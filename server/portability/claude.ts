// The Claude data export adapter (Phase 13e, contracts §12, INV-42). Maps
// only what docs/claude-export-notes.md records as observed; everything
// else is skipped and reported, never guessed.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MEMORY_LIMITS, memoryNameProblem, utf8Bytes } from "@shared/memories";
import type { ImportItem } from "@shared/portability";
import { artifactNameProblem, displayMediaType } from "../artifacts/capture.ts";
import { displayFilename } from "../attachments/sniff.ts";
import type { AttachmentMeta } from "../storage/attachments.ts";
import type { ArtifactMeta } from "../storage/artifacts.ts";
import {
  isCanonicalUuid,
  normalizeBody,
  serializeConversation,
  validateModel,
  type Block,
} from "../storage/markdown.ts";
import { serializeMemory } from "../storage/memories.ts";
import {
  canonicalTime,
  checkDeadline,
  derivedUuid,
  sha256,
  StageWriter,
  type ImportAdapter,
  type UploadContext,
} from "./adapters.ts";
import { ArchiveError, collect, listEntries, openZip, readStream } from "./read-archive.ts";

const CONVERSATIONS = "conversations.json";
const MEMORY_ENTRY = /^memories\/[0-9a-f-]{36}\.json$/;
/** Observed entries that hold no chat content: reported as skipped. */
const NOT_IMPORTED: [RegExp, string][] = [
  [/^users\.json$/, "account data isn't imported"],
  [/^login_history\.json$/, "sign-in history isn't imported"],
  [/^reflections\/[0-9a-f-]{36}\.json$/, "Claude's usage reflections aren't imported"],
];
/** The parent of a conversation's first message. */
const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";
const UNTITLED = "Untitled chat";
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const LINE_BREAKS = /[\n\r\u0085\u2028\u2029]+/g;

const blockSchema = z.looseObject({ type: z.string() });
type ContentBlock = z.infer<typeof blockSchema> & Record<string, unknown>;

const messageSchema = z.looseObject({
  uuid: z.string(),
  sender: z.string(),
  text: z.string().optional(),
  content: z.array(blockSchema).optional(),
  created_at: z.string().optional(),
  attachments: z
    .array(
      z.looseObject({
        file_name: z.string().nullable().optional(),
        file_type: z.string().nullable().optional(),
        extracted_content: z.string().nullable().optional(),
      }),
    )
    .optional(),
  files: z
    .array(
      z.looseObject({
        file_uuid: z.string().nullable().optional(),
        file_name: z.string().nullable().optional(),
      }),
    )
    .optional(),
  parent_message_uuid: z.string().nullable().optional(),
});
type Message = z.infer<typeof messageSchema>;

const conversationSchema = z.looseObject({
  uuid: z.string(),
  name: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  chat_messages: z.array(z.unknown()),
});

const memoriesSchema = z.looseObject({
  memory_files: z.array(
    z.looseObject({
      path: z.string(),
      content: z.string(),
      updated_at: z.string().nullable().optional(),
    }),
  ),
});

/** A decoded source document and its checksum (for the duplicate-import key). */
interface SourceDoc {
  name: string;
  sha256: string;
  value: unknown;
}

/** What was left out, for the preview notes. */
interface Tally {
  tools: Map<string, number>;
  blocks: Map<string, number>;
  branchMessages: number;
  citations: number;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function skippedItem(
  kind: ImportItem["kind"],
  id: string,
  label: string,
  reason: string,
): ImportItem {
  return {
    kind,
    id: id.slice(0, 200),
    label: label.slice(0, 200),
    action: "skipped",
    reason,
    newId: null,
    rewritten: false,
  };
}

function decode(name: string, bytes: Buffer): SourceDoc {
  const text = bytes.toString("utf8");
  try {
    return {
      name,
      sha256: sha256(bytes),
      value: JSON.parse(text.startsWith("\ufeff") ? text.slice(1) : text) as unknown,
    };
  } catch {
    throw new ArchiveError(`${name} isn't valid JSON`);
  }
}

function tooLarge(name: string, max: number): ArchiveError {
  return new ArchiveError(
    `${name} is larger than the ${String(Math.floor(max / (1024 * 1024)))} MB limit for one JSON document`,
  );
}

/** The documents an upload carries: a Claude ZIP's entries, or one bare JSON file. */
async function readDocs(
  ctx: UploadContext,
  isZip: boolean,
): Promise<{ docs: SourceDoc[]; unknown: string[]; notes: string[] }> {
  const max = ctx.limits.maxJsonBytes;
  const docs: SourceDoc[] = [];
  const unknown: string[] = [];
  const notes: string[] = [];
  if (!isZip) {
    if ((await stat(ctx.file)).size > max) throw tooLarge("The file", max);
    const doc = decode("upload.json", await readFile(ctx.file));
    // A bare conversations.json, or one memories/<account>.json file.
    const name = Array.isArray(doc.value)
      ? CONVERSATIONS
      : memoriesSchema.safeParse(doc.value).success
        ? "memories.json"
        : null;
    if (!name)
      throw new ArchiveError(
        "This JSON file is neither Claude's conversations.json nor a memories file",
      );
    docs.push({ ...doc, name });
    return { docs, unknown, notes };
  }
  const zip = await openZip(ctx.file);
  try {
    for (const entry of await listEntries(zip, ctx.limits)) {
      checkDeadline(ctx);
      const name = entry.fileName;
      if (name === CONVERSATIONS || MEMORY_ENTRY.test(name)) {
        if (entry.uncompressedSize > max) throw tooLarge(name, max);
        docs.push(decode(name, await collect(await readStream(zip, entry), max)));
        continue;
      }
      const skipped = NOT_IMPORTED.find(([pattern]) => pattern.test(name));
      if (skipped) notes.push(`Skipped ${name}: ${skipped[1]}`);
      else unknown.push(name.slice(0, 200));
    }
  } finally {
    zip.close();
  }
  return { docs, unknown, notes };
}

/** The messages on the path to the most recently created leaf, and how many were left out. */
function latestBranch(messages: Message[]): { path: Message[]; dropped: number } {
  const linked = messages.every((m) => typeof m.parent_message_uuid === "string");
  if (!linked) return { path: messages, dropped: 0 };
  const byId = new Map(messages.map((m) => [m.uuid, m]));
  const parents = new Set(messages.map((m) => m.parent_message_uuid));
  let leaf: Message | undefined;
  for (const m of messages) {
    if (parents.has(m.uuid)) continue;
    // Ties go to the later message in the array.
    if (!leaf || (canonicalTime(m.created_at) ?? "") >= (canonicalTime(leaf.created_at) ?? ""))
      leaf = m;
  }
  const path: Message[] = [];
  const seen = new Set<string>();
  for (let m = leaf; m && !seen.has(m.uuid);) {
    seen.add(m.uuid);
    path.push(m);
    const parent = m.parent_message_uuid ?? ROOT_PARENT;
    m = parent === ROOT_PARENT ? undefined : byId.get(parent);
  }
  path.reverse();
  return { path, dropped: messages.length - path.length };
}

function blocksOf(m: Message): ContentBlock[] {
  return m.content ?? [];
}

function textOf(blocks: ContentBlock[], fallback: string | undefined): string {
  const texts = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return normalizeBody(texts.length > 0 ? texts.join("\n\n") : (fallback ?? ""));
}

function attachmentMediaType(filename: string): AttachmentMeta["mediaType"] {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "csv") return "text/csv";
  if (ext === "json") return "application/json";
  return "text/plain";
}

function languageOf(block: ContentBlock): string | null {
  const display = block.display_content as { language?: unknown } | null | undefined;
  const language = display?.language;
  return typeof language === "string" && /^[\w+#.-]{1,32}$/.test(language) ? language : null;
}

/**
 * One conversation: the latest branch as canonical blocks, text attachments
 * from `extracted_content`, and `create_file` outputs as imported artifacts.
 */
async function stageConversation(
  raw: unknown,
  w: StageWriter,
  ctx: UploadContext,
  tally: Tally,
  skipped: ImportItem[],
): Promise<string | null> {
  const parsed = conversationSchema.safeParse(raw);
  const rawId = (raw as { uuid?: unknown } | null)?.uuid;
  if (!parsed.success) {
    skipped.push(
      skippedItem(
        "conversation",
        typeof rawId === "string" ? rawId : "",
        "Unreadable conversation",
        "unexpected structure",
      ),
    );
    return null;
  }
  const conv = parsed.data;
  const title =
    Array.from((conv.name ?? "").replace(LINE_BREAKS, " ").trim())
      .slice(0, 200)
      .join("")
      .trim() || UNTITLED;
  const messages: Message[] = [];
  for (const m of conv.chat_messages) {
    const message = messageSchema.safeParse(m);
    if (!message.success) {
      skipped.push(
        skippedItem("conversation", conv.uuid, title, "a message has an unexpected structure"),
      );
      return null;
    }
    messages.push(message.data);
  }
  const id = isCanonicalUuid(conv.uuid) ? conv.uuid : derivedUuid("claude-conversation", conv.uuid);
  const blockId = (m: Message) =>
    isCanonicalUuid(m.uuid) ? m.uuid : derivedUuid("claude-message", m.uuid);
  const times = messages.map((m) => canonicalTime(m.created_at)).filter((t) => t !== null);
  const createdAt = canonicalTime(conv.created_at) ?? times[0] ?? null;
  const updatedAt = canonicalTime(conv.updated_at) ?? times.at(-1) ?? createdAt;
  if (!createdAt || !updatedAt) {
    skipped.push(skippedItem("conversation", conv.uuid, title, "it has no timestamps"));
    return null;
  }

  const { path: branch, dropped } = latestBranch(messages);
  tally.branchMessages += dropped;
  const blocks: Block[] = [];
  let records = 1 + branch.length;
  for (const m of branch) {
    const time = canonicalTime(m.created_at);
    const content = blocksOf(m);
    const mid = blockId(m);
    for (const b of content)
      if (!["text", "thinking", "tool_use", "tool_result", "token_budget"].includes(b.type))
        bump(tally.blocks, b.type);
    if (m.sender === "human") {
      const attachments: string[] = [];
      for (const [index, a] of (m.attachments ?? []).entries()) {
        const given = a.file_name?.trim() ?? "";
        const filename = displayFilename(given === "" ? "Pasted text.txt" : given);
        const aid = derivedUuid("claude-attachment", m.uuid, String(index));
        const text = a.extracted_content;
        const reason =
          a.file_type !== "txt"
            ? "only text attachments are imported"
            : typeof text !== "string"
              ? "the export doesn't include its text"
              : text.includes(String.fromCharCode(0))
                ? "it isn't plain text"
                : utf8Bytes(text) > ctx.caps.attachmentMaxBytes
                  ? "larger than the attachment size limit"
                  : attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE
                    ? "more than 10 attachments on one message"
                    : null;
        if (reason !== null || typeof text !== "string") {
          skipped.push(skippedItem("attachment", aid, filename, reason ?? "unreadable"));
          continue;
        }
        const blob = Buffer.from(text, "utf8");
        const meta: AttachmentMeta = {
          version: 1,
          id: aid,
          ownerId: ctx.userId,
          conversationId: id,
          messageId: mid,
          filename,
          mediaType: attachmentMediaType(filename),
          kind: "text",
          size: blob.length,
          sha256: sha256(blob),
          createdAt: time ?? createdAt,
        };
        await w.add("attachment-meta", aid, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
        await w.add("attachment-blob", aid, blob);
        attachments.push(aid);
        records++;
      }
      for (const f of m.files ?? [])
        skipped.push(
          skippedItem(
            "attachment",
            f.file_uuid ?? "",
            displayFilename(f.file_name ?? undefined),
            "the export doesn't include this file's contents",
          ),
        );
      blocks.push({
        type: "user",
        id: mid,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(time ? { time } : {}),
        body: textOf(content, m.text),
      });
      continue;
    }
    if (m.sender !== "assistant") {
      skipped.push(
        skippedItem("conversation", conv.uuid, title, `unknown sender "${m.sender.slice(0, 20)}"`),
      );
      return null;
    }
    const thinking = normalizeBody(
      content
        .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
        .map((b) => b.thinking as string)
        .join("\n\n"),
    );
    tally.citations += content.filter(
      (b) => b.type === "text" && Array.isArray(b.citations) && b.citations.length > 0,
    ).length;
    let captureIndex = 0;
    for (const [position, b] of content.entries()) {
      if (b.type !== "tool_use") continue;
      const tool = typeof b.name === "string" ? b.name.slice(0, 60) : "unnamed";
      if (tool !== "create_file") {
        bump(tally.tools, tool);
        continue;
      }
      const input = (b.input ?? {}) as { path?: unknown; file_text?: unknown };
      const name = typeof input.path === "string" ? path.posix.basename(input.path) : "";
      const aid = derivedUuid("claude-artifact", m.uuid, String(position));
      // Its result is the next tool_result for this call (observed right after it).
      const result = content
        .slice(position + 1)
        .find((r) => r.type === "tool_result" && r.tool_use_id === b.id);
      const source = input.file_text;
      const problem = artifactNameProblem(name);
      const reason =
        result?.is_error === true
          ? "the tool reported an error"
          : typeof source !== "string"
            ? "the export doesn't include its contents"
            : problem
              ? `its name isn't allowed (${problem})`
              : source.includes(String.fromCharCode(0))
                ? "it isn't plain text"
                : utf8Bytes(source) > ctx.caps.artifactMaxBytes
                  ? "larger than the file size limit"
                  : null;
      if (reason !== null || typeof source !== "string") {
        skipped.push(skippedItem("artifact", aid, name || "file", reason ?? "unreadable"));
        continue;
      }
      const blob = Buffer.from(source, "utf8");
      const meta: ArtifactMeta = {
        version: 1,
        id: aid,
        name: name.trim(),
        language: languageOf(b),
        mediaType: displayMediaType(name.trim()),
        size: blob.length,
        sha256: sha256(blob),
        createdAt: time ?? createdAt,
        source: "imported",
        conversationId: id,
        assistantMessageId: mid,
        generationId: null,
        captureIndex: captureIndex++,
        finalized: true,
      };
      await w.add("artifact-meta", aid, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
      await w.add("artifact-blob", aid, blob);
      records++;
    }
    if (thinking !== "") blocks.push({ type: "reasoning", id: mid, body: thinking });
    blocks.push({
      type: "assistant",
      id: mid,
      status: "complete",
      ...(time ? { time } : {}),
      body: textOf(content, m.text),
    });
  }
  const model = { title, createdAt, updatedAt, blocks };
  const problem = validateModel(model);
  if (problem) {
    skipped.push(
      skippedItem("conversation", conv.uuid, title, `it can't be converted (${problem})`),
    );
    return null;
  }
  w.count(records);
  await w.add("conversation", id, Buffer.from(serializeConversation(model), "utf8"));
  return updatedAt;
}

/** Memory files, as approved-memory candidates (imported only when selected). */
async function stageMemories(
  doc: SourceDoc,
  w: StageWriter,
  ctx: UploadContext,
  skipped: ImportItem[],
): Promise<string | null> {
  const parsed = memoriesSchema.safeParse(doc.value);
  if (!parsed.success) throw new ArchiveError(`${doc.name} isn't a Claude memories file`);
  let latest: string | null = null;
  for (const file of parsed.data.memory_files) {
    checkDeadline(ctx);
    const id = derivedUuid("claude-memory", doc.name, file.path);
    const name = path.posix.basename(file.path).replace(/\.md$/i, "").trim();
    const content = normalizeBody(file.content);
    const problem = memoryNameProblem(name);
    const reason = problem
      ? `its name ${problem}`
      : content === ""
        ? "it is empty"
        : utf8Bytes(content) > MEMORY_LIMITS.contentMaxBytes
          ? `longer than ${String(MEMORY_LIMITS.contentMaxBytes)} bytes`
          : null;
    if (reason) {
      skipped.push(skippedItem("memory", id, name || file.path, reason));
      continue;
    }
    // Claude records one time per file; it serves as both.
    const time = canonicalTime(file.updated_at) ?? ctx.now;
    if (!latest || time > latest) latest = time;
    w.count();
    await w.add(
      "memory",
      id,
      Buffer.from(serializeMemory({ id, name, content, createdAt: time, updatedAt: time }), "utf8"),
    );
  }
  return latest;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function listed(map: Map<string, number>): string {
  return [...map].map(([k, n]) => (n > 1 ? `${k} ×${String(n)}` : k)).join(", ");
}

export const claudeAdapter: ImportAdapter = {
  source: "claude",
  detect(probe) {
    if (probe.zipEntries)
      return probe.zipEntries.some(
        (name) =>
          name === CONVERSATIONS ||
          MEMORY_ENTRY.test(name) ||
          NOT_IMPORTED.some(([pattern]) => pattern.test(name)),
      );
    const text = probe.head
      .toString("utf8")
      .replace(/^\ufeff/, "")
      .trimStart();
    return text.startsWith("[") || text.startsWith("{");
  },
  async stage(ctx, probe) {
    const { docs, unknown, notes } = await readDocs(ctx, probe.zipEntries !== null);
    const w = await new StageWriter(ctx).init();
    const skipped: ImportItem[] = [];
    const tally: Tally = { tools: new Map(), blocks: new Map(), branchMessages: 0, citations: 0 };
    const times: string[] = [];
    const later = (t: string | null) => {
      if (t) times.push(t);
    };
    for (const doc of docs) {
      if (doc.name !== CONVERSATIONS) {
        later(await stageMemories(doc, w, ctx, skipped));
        continue;
      }
      if (!Array.isArray(doc.value))
        throw new ArchiveError("conversations.json isn't a list of conversations");
      // Duplicate ids are refused, not merged (INV-42).
      const conversationIds = new Set<string>();
      const messageIds = new Set<string>();
      for (const raw of doc.value as unknown[]) {
        const c = raw as { uuid?: unknown; chat_messages?: unknown } | null;
        if (typeof c?.uuid === "string") {
          if (conversationIds.has(c.uuid))
            throw new ArchiveError(`Conversation ${c.uuid.slice(0, 64)} appears twice`);
          conversationIds.add(c.uuid);
        }
        if (Array.isArray(c?.chat_messages))
          for (const m of c.chat_messages as ({ uuid?: unknown } | null)[]) {
            if (typeof m?.uuid !== "string") continue;
            if (messageIds.has(m.uuid))
              throw new ArchiveError(`Message ${m.uuid.slice(0, 64)} appears twice`);
            messageIds.add(m.uuid);
          }
      }
      for (const raw of doc.value as unknown[]) {
        checkDeadline(ctx);
        later(await stageConversation(raw, w, ctx, tally, skipped));
      }
    }
    const toolCalls = [...tally.tools.values()].reduce((a, b) => a + b, 0);
    if (toolCalls > 0)
      notes.push(
        `Skipped ${plural(toolCalls, "tool call")} (${listed(tally.tools)}): ChatUI keeps no tool transcripts. Files made with create_file are imported as files.`,
      );
    const otherBlocks = [...tally.blocks.values()].reduce((a, b) => a + b, 0);
    if (otherBlocks > 0)
      notes.push(
        `Skipped ${plural(otherBlocks, "unsupported content block")} (${listed(tally.blocks)})`,
      );
    if (tally.branchMessages > 0)
      notes.push(
        `Skipped ${plural(tally.branchMessages, "message")} on other branches (edits or retries): each chat's latest branch is imported`,
      );
    if (tally.citations > 0)
      notes.push(`${plural(tally.citations, "reply part")} had citations, which aren't imported`);
    return {
      source: "claude",
      key: sha256(
        docs
          .map((d) => `${d.name}:${d.sha256}`)
          .sort()
          .join("\n"),
      ),
      exportCreatedAt: times.sort().at(-1) ?? ctx.now,
      entries: w.entries,
      unknown,
      notes,
      skipped,
    };
  },
};

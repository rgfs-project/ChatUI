import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ErrorCode } from "@shared/errors";
import { memoryNameKey, MEMORY_LIMITS, utf8Bytes } from "@shared/memories";
import type {
  ImportCommit,
  ImportItem,
  ImportPreview,
  ImportSource,
  ItemKind,
} from "@shared/portability";
import { SKILL_LIMITS, skillDtoSchema, type SkillDto } from "@shared/skills";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { AccountWrites } from "../storage/account.ts";
import { isArtifactMeta, type ArtifactMeta, type ArtifactStore } from "../storage/artifacts.ts";
import {
  attachmentMetaSchema,
  type AttachmentMeta,
  type AttachmentStore,
} from "../storage/attachments.ts";
import type { ChatIndex } from "../storage/chat-index.ts";
import { atomicWrite, durableUnlink, ensureDir, listDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import { lockKeys } from "../storage/locks.ts";
import {
  parseConversation,
  serializeConversation,
  type ConversationModel,
} from "../storage/markdown.ts";
import { parseMemory, type MemoryStore } from "../storage/memories.ts";
import { sha256Hex } from "../storage/operations.ts";
import { isUuid, type DataPaths } from "../storage/paths.ts";
import { isProposalRecord, type ProposalRecord } from "../storage/proposals.ts";
import type { PreferencesStore } from "../storage/preferences.ts";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "./archive.ts";
import { stageUpload, type ImportAdapter } from "./adapters.ts";
import { ArchiveError, type ExtractedEntry } from "./read-archive.ts";
import { IMPORT_ADAPTERS } from "./sources.ts";

/** Finished or abandoned import state is kept this long, then removed. */
export const IMPORT_RETENTION_MS = 24 * 60 * 60_000;
/** Completed-import keys kept for duplicate detection. */
const LEDGER_MAX = 200;
const MAX_PINS = 500;

type JournalState = ImportPreview["state"];

/** What one commit step writes; rollback recomputes the path from kind and id. */
interface Planned {
  kind: "conversation" | "attachment" | "artifact" | "memory" | "proposals";
  id: string;
  /** SHA-256 of the file that identifies it (Markdown, meta.json, memory, sidecar). */
  sha256: string;
}

interface Journal {
  version: 1;
  importId: string;
  /** Absent in journals written before Phase 13e: a ChatUI archive. */
  source?: ImportSource;
  key: string;
  state: JournalState;
  createdAt: string;
  exportCreatedAt: string;
  entries: ExtractedEntry[];
  unknown: string[];
  /** The adapter's notes and the source records it couldn't map (Phase 13e). */
  notes?: string[];
  skipped?: ImportItem[];
  preview: Pick<ImportPreview, "items" | "memories" | "counts" | "warnings">;
  options: ImportCommit | null;
  planned: Planned[];
  /** Settings files replaced by the commit: their bytes before, for rollback. */
  replaced: { file: "preferences" | "skills"; before: string | null; afterSha256: string }[];
  report: ImportPreview["report"];
  committedAt: string | null;
}

interface Ledger {
  version: 1;
  imports: { key: string; importId: string; committedAt: string }[];
}

export interface ImportHooks {
  /** Test hook: after `n` commit steps were written (crash simulation). */
  afterStep?: (n: number) => void | Promise<void>;
  /**
   * Test hook: a failing step leaves the journal `committing` without
   * compensating, as a process crash would (startup recovery then rolls back).
   */
  abandonOnError?: boolean;
}

/** An operation the commit performs, with its report line. */
type Op =
  | { kind: "conversation"; id: string; bytes: Buffer }
  | { kind: "attachment"; id: string; meta: Buffer; blob: string }
  | { kind: "artifact"; id: string; meta: Buffer; blob: string }
  | { kind: "memory"; id: string; bytes: Buffer; nameKey: string }
  | { kind: "proposals"; id: string; bytes: Buffer };

interface Plan {
  items: ImportItem[];
  memories: ImportPreview["memories"];
  warnings: string[];
  ops: Op[];
  skills: SkillDto[];
  preferences: {
    pins: string[];
    scalars: Record<string, unknown>;
  } | null;
}

function item(
  kind: ItemKind,
  id: string,
  label: string,
  action: ImportItem["action"],
  reason: string | null = null,
  newId: string | null = null,
  rewritten = false,
): ImportItem {
  return { kind, id, label: label.slice(0, 200), action, reason, newId, rewritten };
}

function countsOf(items: readonly ImportItem[]): ImportPreview["counts"] {
  const counts: ImportPreview["counts"] = {};
  for (const i of items) {
    const byKind = (counts[i.kind] ??= {});
    byKind[i.action] = (byKind[i.action] ?? 0) + 1;
  }
  return counts;
}

/** Atomic copy of a (possibly large) staged file: temp → fsync → rename. */
async function atomicCopy(source: string, target: string): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID().replace(/-/g, "").slice(0, 16)}.tmp`,
  );
  await copyFile(source, temp);
  const handle = await open(temp, "r+");
  try {
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
}

/**
 * Portable import (Phase 13d, INV-42). An upload is streamed into
 * `import-staging/<id>/`, converted by its source's adapter into staged
 * ChatUI entries with every bound checked (Phase 13e, see adapters.ts),
 * previewed without touching canonical data, and committed only on the
 * user's confirmation with their choices: conflicts skipped (default) or
 * imported as copies with remapped ids, and memories only when selected.
 *
 * The commit is transactional-or-compensated: the journal records every
 * planned write with the SHA-256 it will have *before* anything is written;
 * a commit interrupted by a crash is rolled back at startup (step 3) by
 * deleting exactly the files that still carry those hashes and restoring
 * replaced settings files. Every write creates a new file (existing items
 * are never overwritten); the destination is the session's user only.
 */
export class ImportService {
  private readonly o: {
    paths: DataPaths;
    writes: AccountWrites;
    locks: KeyedLocks;
    index: ChatIndex;
    attachments: AttachmentStore;
    artifacts: ArtifactStore;
    memories: MemoryStore;
    preferences: PreferencesStore;
    logger: Logger;
    limits?: Partial<ImportLimits>;
    now?: () => Date;
    /** The sources uploads are detected and converted with (Phase 13e). */
    adapters?: readonly ImportAdapter[];
  };
  readonly limits: ImportLimits;
  hooks: ImportHooks = {};
  private readonly busy = new Set<string>();
  private readonly progress = new Map<string, { done: number; total: number }>();
  private readonly commits = new Map<string, Promise<void>>();

  constructor(options: ImportService["o"]) {
    this.o = options;
    this.limits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits };
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  private journalFile(userId: string, importId: string): string {
    return path.join(this.o.paths.importDir(userId, importId), "journal.json");
  }

  private async readJournal(userId: string, importId: string): Promise<Journal | null> {
    const bytes = await readOrNull(this.journalFile(userId, importId));
    if (!bytes) return null;
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as {
        version?: unknown;
        importId?: unknown;
      };
      return parsed.version === 1 && parsed.importId === importId ? (parsed as Journal) : null;
    } catch {
      return null;
    }
  }

  private async writeJournal(userId: string, journal: Journal): Promise<void> {
    await this.o.writes.run(userId, () =>
      atomicWrite(this.journalFile(userId, journal.importId), JSON.stringify(journal)),
    );
  }

  private exclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(userId))
      throw new AppError(ErrorCode.RATE_LIMITED, "An import is already in progress", undefined, {
        "Retry-After": "5",
      });
    this.busy.add(userId);
    return fn().finally(() => {
      this.busy.delete(userId);
    });
  }

  // -------------------------------------------------------------------------
  // Upload and preview

  /**
   * Streams the request body (a ChatUI archive, a Claude export or a duck.ai
   * chat) into staging, bounded, then converts and previews it.
   */
  receive(
    userId: string,
    req: IncomingMessage,
    declared: number | null,
    timeZone: string | null = null,
  ): Promise<ImportPreview> {
    return this.exclusive(userId, async () => {
      if (declared !== null && declared > this.limits.maxArchiveBytes)
        throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "The archive is too large");
      const importId = randomUUID();
      const dir = this.o.paths.importDir(userId, importId);
      await this.o.writes.run(userId, () => ensureDir(dir));
      const upload = path.join(dir, "upload");
      try {
        let bytes = 0;
        const max = this.limits.maxArchiveBytes;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > max)
              callback(new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "The archive is too large"));
            else callback(null, chunk);
          },
        });
        await pipeline(req, limit, createWriteStream(upload, { mode: 0o600 }));
        return await this.previewFile(userId, importId, upload, timeZone);
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof AppError) throw error;
        if (error instanceof ArchiveError) throw new AppError(ErrorCode.VALIDATION, error.message);
        this.o.logger.warn({ err: error }, "import upload failed");
        throw new AppError(ErrorCode.VALIDATION, "The archive couldn't be read");
      }
    });
  }

  private async previewFile(
    userId: string,
    importId: string,
    upload: string,
    timeZone: string | null,
  ): Promise<ImportPreview> {
    const dir = this.o.paths.importDir(userId, importId);
    const staged = await stageUpload(
      {
        userId,
        file: upload,
        stagingDir: path.join(dir, "entries"),
        limits: this.limits,
        deadline: Date.now() + this.limits.maxMs,
        timeZone,
        now: this.now(),
        caps: {
          attachmentMaxBytes: this.o.attachments.effective().maxFileBytes,
          artifactMaxBytes: this.o.artifacts.config.maxBytes,
        },
      },
      this.o.adapters ?? IMPORT_ADAPTERS,
    );
    await unlink(upload).catch(() => undefined);
    const journal: Journal = {
      version: 1,
      importId,
      source: staged.source,
      key: staged.key,
      state: "previewed",
      createdAt: this.now(),
      exportCreatedAt: staged.exportCreatedAt,
      entries: staged.entries,
      unknown: staged.unknown,
      notes: staged.notes,
      skipped: staged.skipped,
      preview: { items: [], memories: [], counts: {}, warnings: [] },
      options: null,
      planned: [],
      replaced: [],
      report: null,
      committedAt: null,
    };
    const plan = await this.plan(userId, journal, { conflicts: "skip", memoryIds: [] });
    journal.preview = {
      items: plan.items,
      memories: plan.memories,
      counts: countsOf(plan.items),
      warnings: plan.warnings,
    };
    await this.writeJournal(userId, journal);
    return this.dto(userId, journal);
  }

  async get(userId: string, importId: string): Promise<ImportPreview> {
    const journal = await this.readJournal(userId, importId);
    if (!journal) throw new AppError(ErrorCode.NOT_FOUND, "Import not found");
    return this.dto(userId, journal);
  }

  private async dto(userId: string, journal: Journal): Promise<ImportPreview> {
    const previous = (await this.ledger(userId)).imports.find(
      (i) => i.key === journal.key && i.importId !== journal.importId,
    );
    const progress = this.progress.get(journal.importId) ?? {
      done: journal.state === "committed" ? journal.planned.length : 0,
      total: journal.planned.length,
    };
    return {
      importId: journal.importId,
      source: journal.source ?? "chatui",
      key: journal.key,
      state: journal.state,
      createdAt: journal.createdAt,
      exportCreatedAt: journal.exportCreatedAt,
      previousImport: previous
        ? { importId: previous.importId, committedAt: previous.committedAt }
        : null,
      counts: journal.preview.counts,
      items: journal.preview.items,
      memories: journal.preview.memories,
      warnings: journal.preview.warnings,
      report: journal.report,
      progress,
    };
  }

  /** Cancels an import that was not committed: its staging is removed. */
  async cancel(userId: string, importId: string): Promise<void> {
    const journal = await this.readJournal(userId, importId);
    if (!journal) throw new AppError(ErrorCode.NOT_FOUND, "Import not found");
    if (journal.state !== "previewed")
      throw new AppError(ErrorCode.CONFLICT, "This import can no longer be cancelled");
    await rm(this.o.paths.importDir(userId, importId), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Planning (no writes)

  private async plan(userId: string, journal: Journal, options: ImportCommit): Promise<Plan> {
    const { paths } = this.o;
    // What the source adapter couldn't map comes first (Phase 13e).
    const items: ImportItem[] = [...(journal.skipped ?? [])];
    const warnings: string[] = [
      ...(journal.notes ?? []),
      ...journal.unknown.map((name) => `Skipped an unknown entry: ${name}`),
    ];
    const ops: Op[] = [];
    const byKind = (kind: ExtractedEntry["kind"]) => journal.entries.filter((e) => e.kind === kind);
    const read = (e: ExtractedEntry) => readFile(e.file);
    const blobs = (kind: "attachment-blob" | "artifact-blob") =>
      new Map(byKind(kind).map((e) => [e.id ?? "", e]));

    // Conversations: the target id of each imported one, and which were skipped.
    const conversations = new Map<
      string,
      { target: string | null; action: ImportItem["action"] }
    >();
    const convEntries = byKind("conversation");
    const archiveModels = new Map<string, { bytes: Buffer; model: ConversationModel | null }>();
    for (const entry of convEntries) {
      const bytes = await read(entry);
      const parsed = parseConversation(bytes.toString("utf8"));
      archiveModels.set(entry.id ?? "", { bytes, model: parsed.ok ? parsed.conversation : null });
    }
    // Attachments are planned with their conversation (they are linked to it).
    const attachmentMetas = new Map<string, AttachmentMeta>();
    for (const entry of byKind("attachment-meta")) {
      try {
        const meta = attachmentMetaSchema.parse(JSON.parse((await read(entry)).toString("utf8")));
        if (meta.id === entry.id) attachmentMetas.set(meta.id, meta);
      } catch {
        items.push(
          item("attachment", entry.id ?? "", entry.id ?? "", "skipped", "unreadable metadata"),
        );
      }
    }
    const attachmentBlobs = blobs("attachment-blob");
    let attachmentBudget =
      this.o.attachments.effective().quotaBytes - (await this.o.attachments.usage(userId));

    for (const [id, archived] of archiveModels) {
      const label = archived.model?.title ?? "Unreadable conversation";
      const existing = await readOrNull(paths.chatFile(userId, id));
      let action: ImportItem["action"];
      let target: string | null = id;
      if (!existing) action = "new";
      else if (sha256Hex(existing) === sha256Hex(archived.bytes)) action = "identical";
      else if (options.conflicts === "copy") {
        action = "copy";
        target = randomUUID();
      } else {
        action = "conflict";
        target = null;
      }
      // Its attachments: kept ids where free, remapped where taken.
      const linked = [...attachmentMetas.values()].filter((m) => m.conversationId === id);
      const remap = new Map<string, string>();
      const attachmentOps: Op[] = [];
      const attachmentItems: ImportItem[] = [];
      for (const meta of linked) {
        const blob = attachmentBlobs.get(meta.id);
        if (blob?.sha256 !== meta.sha256 || blob.length !== meta.size) {
          attachmentItems.push(
            item(
              "attachment",
              meta.id,
              meta.filename,
              "skipped",
              "its bytes are missing or don't match",
            ),
          );
          continue;
        }
        if (target === null) {
          attachmentItems.push(
            item("attachment", meta.id, meta.filename, "skipped", "its conversation was skipped"),
          );
          continue;
        }
        const present = await readOrNull(paths.attachmentMeta(userId, meta.id));
        if (action === "identical" && present) {
          attachmentItems.push(item("attachment", meta.id, meta.filename, "identical"));
          continue;
        }
        const newId = present ? randomUUID() : meta.id;
        if (newId !== meta.id) remap.set(meta.id, newId);
        if (meta.size > attachmentBudget) {
          attachmentItems.push(
            item("attachment", meta.id, meta.filename, "skipped", "attachment storage quota"),
          );
          continue;
        }
        attachmentBudget -= meta.size;
        const next: AttachmentMeta = {
          ...meta,
          id: newId,
          ownerId: userId,
          conversationId: target,
        };
        const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
        const original = await read(
          byKind("attachment-meta").find((e) => e.id === meta.id) as ExtractedEntry,
        );
        attachmentOps.push({ kind: "attachment", id: newId, meta: bytes, blob: blob.file });
        attachmentItems.push(
          item(
            "attachment",
            meta.id,
            meta.filename,
            newId === meta.id ? "new" : "copy",
            null,
            newId === meta.id ? null : newId,
            !bytes.equals(original),
          ),
        );
      }
      // The conversation's bytes: unchanged unless attachment references move.
      let bytes = archived.bytes;
      let rewritten = false;
      if (target !== null && action !== "identical" && remap.size > 0) {
        if (!archived.model) {
          items.push(
            item(
              "conversation",
              id,
              label,
              "skipped",
              "malformed, and its attachments would need new ids",
            ),
          );
          conversations.set(id, { target: null, action: "skipped" });
          for (const a of attachmentItems)
            items.push({
              ...a,
              action: "skipped",
              reason: "its conversation was skipped",
              newId: null,
            });
          continue;
        }
        const model: ConversationModel = {
          ...archived.model,
          blocks: archived.model.blocks.map((b) =>
            b.type === "user" && b.attachments
              ? { ...b, attachments: b.attachments.map((a) => remap.get(a) ?? a) }
              : b,
          ),
        };
        bytes = Buffer.from(serializeConversation(model), "utf8");
        rewritten = true;
      }
      conversations.set(id, { target, action });
      items.push(
        item(
          "conversation",
          id,
          label,
          action,
          action === "conflict" ? "differs from your copy" : null,
          action === "copy" ? target : null,
          rewritten,
        ),
      );
      if (target !== null && action !== "identical")
        ops.push({ kind: "conversation", id: target, bytes });
      items.push(...attachmentItems);
      ops.push(...attachmentOps);
    }
    for (const meta of attachmentMetas.values())
      if (!meta.conversationId || !archiveModels.has(meta.conversationId))
        items.push(
          item(
            "attachment",
            meta.id,
            meta.filename,
            "skipped",
            "its conversation isn't in the archive",
          ),
        );

    // Memories: only those the user selected, never over a different note.
    const selected = new Set(options.memoryIds);
    const current = (await this.o.memories.list(userId)).notes;
    const takenNames = new Map(current.map((n) => [memoryNameKey(n.name), n.id]));
    const memoryRemap = new Map<string, string | null>();
    const memories: ImportPreview["memories"] = [];
    let memoryCount = current.length;
    let memoryBytes = current.reduce((sum, n) => sum + utf8Bytes(n.content), 0);
    for (const entry of byKind("memory")) {
      const id = entry.id ?? "";
      const bytes = await read(entry);
      const note = parseMemory(bytes.toString("utf8"), id);
      if (!note) {
        items.push(item("memory", id, id, "skipped", "unreadable"));
        memoryRemap.set(id, null);
        continue;
      }
      const existing = current.find((n) => n.id === id);
      const nameOwner = takenNames.get(memoryNameKey(note.name));
      const state: "new" | "identical" | "conflict" = existing
        ? existing.bytes.equals(bytes)
          ? "identical"
          : "conflict"
        : nameOwner
          ? "conflict"
          : "new";
      memories.push({ id, name: note.name, content: note.content, action: state });
      if (state === "identical") {
        memoryRemap.set(id, id);
        if (selected.has(id)) items.push(item("memory", id, note.name, "identical"));
        continue;
      }
      if (!selected.has(id)) {
        memoryRemap.set(id, null);
        items.push(
          item(
            "memory",
            id,
            note.name,
            state === "conflict" ? "conflict" : "skipped",
            "not selected",
          ),
        );
        continue;
      }
      if (state === "conflict") {
        // A copy needs a free name; the name is taken here (by this note or another).
        memoryRemap.set(id, null);
        items.push(
          item("memory", id, note.name, "conflict", "a memory with this name already exists"),
        );
        continue;
      }
      if (
        memoryCount + 1 > MEMORY_LIMITS.maxCount ||
        memoryBytes + utf8Bytes(note.content) > MEMORY_LIMITS.totalMaxBytes
      ) {
        memoryRemap.set(id, null);
        items.push(item("memory", id, note.name, "skipped", "memory limit"));
        continue;
      }
      memoryCount++;
      memoryBytes += utf8Bytes(note.content);
      takenNames.set(memoryNameKey(note.name), id);
      memoryRemap.set(id, id);
      ops.push({ kind: "memory", id, bytes, nameKey: memoryNameKey(note.name) });
      items.push(item("memory", id, note.name, "new"));
    }

    // Proposal sidecars follow their conversation; nothing imported is actionable.
    for (const entry of byKind("proposals")) {
      const conversationId = entry.id ?? "";
      const conv = conversations.get(conversationId);
      if (!conv?.target) {
        items.push(
          item(
            "proposals",
            conversationId,
            "Memory suggestions",
            "skipped",
            "its conversation was skipped",
          ),
        );
        continue;
      }
      if (
        conv.action === "identical" &&
        (await readOrNull(paths.proposalsFile(userId, conversationId)))
      ) {
        items.push(item("proposals", conversationId, "Memory suggestions", "identical"));
        continue;
      }
      let records: ProposalRecord[];
      try {
        const raw = JSON.parse((await read(entry)).toString("utf8")) as {
          version?: unknown;
          proposals?: unknown;
        };
        if (raw.version !== 1 || !Array.isArray(raw.proposals)) throw new Error("shape");
        records = raw.proposals.filter(isProposalRecord);
      } catch {
        items.push(
          item("proposals", conversationId, "Memory suggestions", "skipped", "unreadable"),
        );
        continue;
      }
      const lost = new Set<string>();
      const next = records.map((r) => {
        const target = r.targetMemoryId;
        const mapped =
          target === null
            ? null
            : memoryRemap.has(target)
              ? (memoryRemap.get(target) ?? null)
              : target;
        const lostTarget =
          target !== null && mapped === null && !current.some((n) => n.id === target);
        if (lostTarget) lost.add(r.id);
        const resultMapped =
          r.resultMemoryId === null
            ? null
            : (memoryRemap.get(r.resultMemoryId) ?? r.resultMemoryId);
        return {
          ...r,
          // Importing never makes a suggestion actionable (contracts §12).
          status: r.status === "pending" || lostTarget ? ("invalid" as const) : r.status,
          decidedAt:
            r.status === "pending" || lostTarget ? (r.decidedAt ?? journal.createdAt) : r.decidedAt,
          targetMemoryId: mapped ?? target,
          resultMemoryId: resultMapped,
          intent: null,
        };
      });
      const degraded = lost.size > 0;
      const bytes = Buffer.from(JSON.stringify({ version: 1, proposals: next }));
      const original = await read(entry);
      ops.push({ kind: "proposals", id: conv.target, bytes });
      items.push(
        item(
          "proposals",
          conversationId,
          "Memory suggestions",
          degraded ? "degraded" : conv.action === "copy" ? "copy" : "new",
          degraded ? "a suggested memory wasn't imported; its suggestions are invalid" : null,
          conv.action === "copy" ? conv.target : null,
          !bytes.equals(original),
        ),
      );
    }

    // Artifacts are independent; a skipped conversation leaves a dead backlink.
    const artifactBlobs = blobs("artifact-blob");
    let artifactBudget =
      this.o.artifacts.config.quotaBytes - (await this.o.artifacts.usedBytes(userId));
    for (const entry of byKind("artifact-meta")) {
      const id = entry.id ?? "";
      let meta: ArtifactMeta;
      try {
        const parsed: unknown = JSON.parse((await read(entry)).toString("utf8"));
        if (!isArtifactMeta(parsed, id) || !parsed.finalized) throw new Error("shape");
        meta = parsed;
      } catch {
        items.push(item("artifact", id, id, "skipped", "unreadable metadata"));
        continue;
      }
      const blob = artifactBlobs.get(id);
      if (blob?.sha256 !== meta.sha256 || blob.length !== meta.size) {
        items.push(
          item("artifact", id, meta.name, "skipped", "its bytes are missing or don't match"),
        );
        continue;
      }
      const existing = await this.o.artifacts.readMeta(userId, id);
      let newId = id;
      let action: ImportItem["action"] = "new";
      if (existing) {
        if (existing.sha256 === meta.sha256 && existing.name === meta.name) {
          items.push(item("artifact", id, meta.name, "identical"));
          continue;
        }
        if (options.conflicts !== "copy") {
          items.push(item("artifact", id, meta.name, "conflict", "differs from your file"));
          continue;
        }
        newId = randomUUID();
        action = "copy";
      }
      if (meta.size > artifactBudget) {
        items.push(item("artifact", id, meta.name, "skipped", "file storage quota"));
        continue;
      }
      artifactBudget -= meta.size;
      const conv = meta.conversationId ? conversations.get(meta.conversationId) : undefined;
      let reason: string | null = null;
      let next: ArtifactMeta = { ...meta, id: newId };
      if (conv?.target === null) {
        next = { ...next, conversationId: null, assistantMessageId: null };
        action = "degraded";
        reason = "its conversation was skipped; the link to it is gone";
      } else if (conv?.target && conv.target !== meta.conversationId) {
        next = { ...next, conversationId: conv.target };
      }
      const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
      ops.push({ kind: "artifact", id: newId, meta: bytes, blob: blob.file });
      items.push(
        item(
          "artifact",
          id,
          meta.name,
          action,
          reason,
          newId === id ? null : newId,
          !bytes.equals(await read(entry)),
        ),
      );
    }

    // Skills: new ids with free names only.
    const skillsOut: SkillDto[] = [];
    const skillsEntry = byKind("skills")[0];
    if (skillsEntry) {
      const existingSkills = await this.readSkills(userId);
      let raw: unknown;
      try {
        raw = JSON.parse((await read(skillsEntry)).toString("utf8"));
      } catch {
        raw = null;
      }
      const list = Array.isArray((raw as { skills?: unknown } | null)?.skills)
        ? (raw as { skills: unknown[] }).skills
        : [];
      let count = existingSkills.length;
      for (const candidate of list) {
        const parsed = skillDtoSchema.safeParse(candidate);
        if (!parsed.success) continue;
        const skill = parsed.data;
        const same = existingSkills.find((s) => s.id === skill.id);
        if (same) {
          items.push(
            JSON.stringify(same) === JSON.stringify(skill)
              ? item("skill", skill.id, `/${skill.name}`, "identical")
              : item("skill", skill.id, `/${skill.name}`, "conflict", "differs from your skill"),
          );
          continue;
        }
        if (
          existingSkills.some((s) => s.name === skill.name) ||
          skillsOut.some((s) => s.name === skill.name)
        ) {
          items.push(
            item("skill", skill.id, `/${skill.name}`, "conflict", "a skill with this name exists"),
          );
          continue;
        }
        if (count >= SKILL_LIMITS.maxSkills) {
          items.push(item("skill", skill.id, `/${skill.name}`, "skipped", "skill limit"));
          continue;
        }
        count++;
        skillsOut.push(skill);
        items.push(item("skill", skill.id, `/${skill.name}`, "new"));
      }
    }

    // Preferences: pins merged (remapped, skipped ones dropped); settings only where unset.
    let preferences: Plan["preferences"] = null;
    const prefsEntry = byKind("preferences")[0];
    if (prefsEntry) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse((await read(prefsEntry)).toString("utf8")) as Record<string, unknown>;
      } catch {
        raw = {};
      }
      const currentPrefs = await this.o.preferences.get(userId);
      const pins = (Array.isArray(raw.pins) ? raw.pins : [])
        .filter((p): p is string => typeof p === "string" && isUuid(p))
        .map((p) => {
          const conv = conversations.get(p);
          return conv ? conv.target : p;
        })
        .filter((p): p is string => p !== null && !currentPrefs.pins.includes(p));
      const scalars: Record<string, unknown> = {};
      const conflicts: string[] = [];
      for (const key of [
        "defaultProvider",
        "defaultModel",
        "historyImages",
        "imageMaxEdge",
      ] as const) {
        const value = raw[key];
        if (value === undefined || value === null) continue;
        const mine = currentPrefs[key];
        if (mine === null) scalars[key] = value;
        else if (mine !== value) conflicts.push(key);
      }
      const changes = pins.length > 0 || Object.keys(scalars).length > 0;
      preferences = changes ? { pins, scalars } : null;
      items.push(
        item(
          "preferences",
          "preferences",
          "Preferences",
          conflicts.length > 0 ? "degraded" : changes ? "new" : "identical",
          conflicts.length > 0 ? `kept your ${conflicts.join(", ")}` : null,
        ),
      );
    }

    return { items, memories, warnings, ops, skills: skillsOut, preferences };
  }

  private async readSkills(userId: string): Promise<SkillDto[]> {
    const bytes = await readOrNull(this.o.paths.skillsFile(userId));
    if (!bytes) return [];
    try {
      const raw = JSON.parse(bytes.toString("utf8")) as { skills?: unknown };
      return Array.isArray(raw.skills)
        ? raw.skills.flatMap((s) => {
            const parsed = skillDtoSchema.safeParse(s);
            return parsed.success ? [parsed.data] : [];
          })
        : [];
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Commit

  /**
   * Starts the commit with the user's choices and returns at once (progress
   * via `get`). A repeated key (the same archive, already imported) is a
   * no-op unless `allowRepeat`.
   */
  async commit(
    userId: string,
    importId: string,
    options: ImportCommit & { allowRepeat?: boolean },
  ): Promise<ImportPreview> {
    const journal = await this.readJournal(userId, importId);
    if (!journal) throw new AppError(ErrorCode.NOT_FOUND, "Import not found");
    if (journal.state !== "previewed") return this.dto(userId, journal);
    const previous = (await this.ledger(userId)).imports.find((i) => i.key === journal.key);
    if (previous && !options.allowRepeat)
      throw new AppError(
        ErrorCode.CONFLICT,
        "This archive was already imported; confirm to import it again",
        { reason: "duplicate", importId: previous.importId },
      );
    if (this.busy.has(userId))
      throw new AppError(ErrorCode.RATE_LIMITED, "An import is already in progress", undefined, {
        "Retry-After": "5",
      });
    this.busy.add(userId);
    const run = this.runCommit(userId, journal, options)
      .catch((error: unknown) => {
        this.o.logger.error({ err: error, importId }, "import commit failed");
      })
      .finally(() => {
        this.busy.delete(userId);
        this.progress.delete(importId);
        this.commits.delete(importId);
      });
    this.commits.set(importId, run);
    // Report the committing state once the journal says so.
    for (let i = 0; i < 50; i++) {
      const current = await this.readJournal(userId, importId);
      if (current && current.state !== "previewed") return this.dto(userId, current);
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.dto(userId, journal);
  }

  /** Waits for a running commit (tests and graceful shutdown). */
  async settled(importId: string): Promise<void> {
    await this.commits.get(importId);
  }

  private async runCommit(userId: string, journal: Journal, options: ImportCommit): Promise<void> {
    const deadline = Date.now() + this.limits.maxMs;
    const plan = await this.plan(userId, journal, options);
    // Write-ahead: every planned file and its hash before any canonical write.
    journal.state = "committing";
    journal.options = options;
    journal.planned = plan.ops.map((op) => ({
      kind: op.kind,
      id: op.id,
      sha256: sha256Hex(op.kind === "attachment" || op.kind === "artifact" ? op.meta : op.bytes),
    }));
    const prefsBefore = await readOrNull(this.o.paths.preferencesFile(userId));
    const skillsBefore = await readOrNull(this.o.paths.skillsFile(userId));
    journal.replaced = [];
    await this.writeJournal(userId, journal);
    const total = plan.ops.length + (plan.preferences ? 1 : 0) + (plan.skills.length > 0 ? 1 : 0);
    const progress = { done: 0, total };
    this.progress.set(journal.importId, progress);
    const items = [...plan.items];
    const skip = (op: Op, reason: string) => {
      const index = items.findIndex(
        (i) =>
          (i.newId ?? i.id) === op.id &&
          i.kind === (op.kind === "proposals" ? "proposals" : op.kind),
      );
      if (index >= 0) {
        const existing = items[index];
        if (existing) items[index] = { ...existing, action: "skipped", reason };
      }
    };
    try {
      for (const op of plan.ops) {
        if (Date.now() > deadline) throw new ArchiveError("The import took too long");
        const written = await this.apply(userId, op);
        if (!written) skip(op, "appeared meanwhile; left untouched");
        progress.done++;
        await this.hooks.afterStep?.(progress.done);
      }
      if (plan.skills.length > 0) {
        const after = await this.writeSkills(userId, plan.skills);
        journal.replaced.push({
          file: "skills",
          before: skillsBefore ? skillsBefore.toString("base64") : null,
          afterSha256: after,
        });
        await this.writeJournal(userId, journal);
        progress.done++;
      }
      if (plan.preferences) {
        const { pins, scalars } = plan.preferences;
        await this.o.preferences.modify(userId, (current) => ({
          ...scalars,
          pins: [...current.pins, ...pins.filter((p) => !current.pins.includes(p))].slice(
            0,
            MAX_PINS,
          ),
        }));
        const after = await readOrNull(this.o.paths.preferencesFile(userId));
        journal.replaced.push({
          file: "preferences",
          before: prefsBefore ? prefsBefore.toString("base64") : null,
          afterSha256: after ? sha256Hex(after) : "",
        });
        progress.done++;
      }
      await this.refreshDerived(userId);
      journal.state = "committed";
      journal.committedAt = this.now();
      journal.report = { committedAt: journal.committedAt, items, error: null };
      await this.writeJournal(userId, journal);
      await this.remember(userId, journal);
      await rm(path.join(this.o.paths.importDir(userId, journal.importId), "entries"), {
        recursive: true,
        force: true,
      });
      this.o.logger.info({ userId, importId: journal.importId, steps: total }, "import committed");
    } catch (error) {
      if (this.hooks.abandonOnError) throw error;
      // Compensate now (as startup recovery would), then report the failure.
      await this.rollback(userId, journal).catch(() => undefined);
      journal.state = "failed";
      journal.report = {
        committedAt: null,
        items: [],
        error:
          error instanceof ArchiveError ? error.message : "The import failed and was rolled back",
      };
      await this.writeJournal(userId, journal).catch(() => undefined);
      throw error;
    }
  }

  /** One write, creating a new file under its lock; false when the target exists. */
  private async apply(userId: string, op: Op): Promise<boolean> {
    const { paths, writes, locks } = this.o;
    switch (op.kind) {
      case "conversation":
        return locks.run(lockKeys.conversation(userId, op.id), async () => {
          if (await readOrNull(paths.chatFile(userId, op.id))) return false;
          await writes.run(userId, async () => {
            await ensureDir(paths.chatsDir(userId));
            await atomicWrite(paths.chatFile(userId, op.id), op.bytes);
          });
          return true;
        });
      case "proposals":
        return locks.run(lockKeys.conversation(userId, op.id), () =>
          locks.run(`proposals:${userId}/${op.id}`, async () => {
            if (await readOrNull(paths.proposalsFile(userId, op.id))) return false;
            await writes.run(userId, async () => {
              await ensureDir(paths.proposalsDir(userId));
              await atomicWrite(paths.proposalsFile(userId, op.id), op.bytes);
            });
            return true;
          }),
        );
      case "memory":
        return this.o.memories.withLock(userId, async () => {
          const { notes } = await this.o.memories.list(userId);
          if (notes.some((n) => n.id === op.id || memoryNameKey(n.name) === op.nameKey))
            return false;
          await writes.run(userId, async () => {
            await ensureDir(paths.memoriesDir(userId));
            await atomicWrite(paths.memoryFile(userId, op.id), op.bytes);
          });
          return true;
        });
      case "attachment":
        return locks.run(`attachment:${userId}/${op.id}`, async () => {
          if (await readOrNull(paths.attachmentMeta(userId, op.id))) return false;
          await writes.run(userId, async () => {
            await ensureDir(paths.attachmentDir(userId, op.id));
            await atomicCopy(op.blob, paths.attachmentBlob(userId, op.id));
            await atomicWrite(paths.attachmentMeta(userId, op.id), op.meta);
          });
          return true;
        });
      case "artifact":
        return locks.run(`artifact:${userId}/${op.id}`, async () => {
          if (await readOrNull(paths.artifactMeta(userId, op.id))) return false;
          await writes.run(userId, async () => {
            await ensureDir(paths.artifactDir(userId, op.id));
            await atomicCopy(op.blob, paths.artifactBlob(userId, op.id));
            await atomicWrite(paths.artifactMeta(userId, op.id), op.meta);
          });
          return true;
        });
    }
  }

  private async writeSkills(userId: string, add: readonly SkillDto[]): Promise<string> {
    return this.o.locks.run(`skills:${userId}`, async () => {
      const current = await this.readSkills(userId);
      const fresh = add.filter((s) => !current.some((c) => c.id === s.id || c.name === s.name));
      const bytes = `${JSON.stringify({ version: 1, skills: [...current, ...fresh] }, null, 2)}\n`;
      await this.o.writes.run(userId, () => atomicWrite(this.o.paths.skillsFile(userId), bytes));
      return sha256Hex(Buffer.from(bytes));
    });
  }

  /** Derived state after direct canonical writes: index, usage and catalog caches. */
  private async refreshDerived(userId: string): Promise<void> {
    await this.o.writes.run(userId, () => this.o.index.rebuild(userId));
    this.o.attachments.invalidateUsage(userId);
    this.o.artifacts.forget(userId);
  }

  /**
   * Compensation: deletes every planned file that still has the hash the
   * import gave it (files that were never written, or were changed since,
   * are left alone) and restores replaced settings files.
   */
  private async rollback(userId: string, journal: Journal): Promise<number> {
    const { paths } = this.o;
    let removed = 0;
    for (const planned of journal.planned) {
      if (!isUuid(planned.id)) continue;
      const file =
        planned.kind === "conversation"
          ? paths.chatFile(userId, planned.id)
          : planned.kind === "proposals"
            ? paths.proposalsFile(userId, planned.id)
            : planned.kind === "memory"
              ? paths.memoryFile(userId, planned.id)
              : planned.kind === "attachment"
                ? paths.attachmentMeta(userId, planned.id)
                : paths.artifactMeta(userId, planned.id);
      const bytes = await readOrNull(file);
      if (!bytes || sha256Hex(bytes) !== planned.sha256) continue;
      if (planned.kind === "attachment")
        await rm(paths.attachmentDir(userId, planned.id), { recursive: true, force: true });
      else if (planned.kind === "artifact")
        await rm(paths.artifactDir(userId, planned.id), { recursive: true, force: true });
      else await durableUnlink(file);
      removed++;
    }
    for (const replaced of journal.replaced) {
      const file =
        replaced.file === "preferences" ? paths.preferencesFile(userId) : paths.skillsFile(userId);
      const now = await readOrNull(file);
      if (!now || sha256Hex(now) !== replaced.afterSha256) continue;
      if (replaced.before === null) await durableUnlink(file);
      else await atomicWrite(file, Buffer.from(replaced.before, "base64"));
    }
    await this.refreshDerived(userId).catch(() => undefined);
    return removed;
  }

  // -------------------------------------------------------------------------
  // Ledger and recovery

  private async ledger(userId: string): Promise<Ledger> {
    const bytes = await readOrNull(this.o.paths.importLedger(userId));
    if (!bytes) return { version: 1, imports: [] };
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as { version?: unknown; imports?: unknown };
      return parsed.version === 1 && Array.isArray(parsed.imports)
        ? (parsed as Ledger)
        : { version: 1, imports: [] };
    } catch {
      return { version: 1, imports: [] };
    }
  }

  private async remember(userId: string, journal: Journal): Promise<void> {
    const ledger = await this.ledger(userId);
    ledger.imports = [
      {
        key: journal.key,
        importId: journal.importId,
        committedAt: journal.committedAt ?? this.now(),
      },
      ...ledger.imports.filter((i) => i.importId !== journal.importId),
    ].slice(0, LEDGER_MAX);
    await this.o.writes.run(userId, async () => {
      await ensureDir(this.o.paths.importStagingDir(userId));
      await atomicWrite(this.o.paths.importLedger(userId), JSON.stringify(ledger));
    });
  }

  /**
   * Startup recovery step 3 (contracts §2): an interrupted commit is rolled
   * back; staging of finished, failed, cancelled or abandoned imports is
   * removed after its retention.
   */
  async recover(userId: string): Promise<{ rolledBack: number; removed: number }> {
    const report = { rolledBack: 0, removed: 0 };
    for (const name of await listDir(this.o.paths.importStagingDir(userId))) {
      if (!isUuid(name)) continue;
      const dir = this.o.paths.importDir(userId, name);
      const journal = await this.readJournal(userId, name);
      if (journal?.state === "committing") {
        await this.rollback(userId, journal);
        journal.state = "rolled_back";
        journal.report = {
          committedAt: null,
          items: [],
          error: "The import was interrupted and rolled back",
        };
        await this.writeJournal(userId, journal);
        await rm(path.join(dir, "entries"), { recursive: true, force: true });
        report.rolledBack++;
        this.o.logger.warn({ userId, importId: name }, "interrupted import rolled back");
        continue;
      }
      const age = await stat(dir).then(
        (s) => Date.now() - s.mtimeMs,
        () => Number.POSITIVE_INFINITY,
      );
      if (!journal || age > IMPORT_RETENTION_MS) {
        await rm(dir, { recursive: true, force: true });
        report.removed++;
      }
    }
    return report;
  }
}

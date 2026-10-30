// Portable import (Phase 13d, contracts §12, INV-42). The archive is staged
// under the destination user's `import-staging/<importId>/`, fully validated
// before anything canonical is written, then committed under a durable
// journal: every file it creates is listed first, so startup can roll an
// interrupted commit back. Nothing is ever overwritten; conflicts are skipped
// or imported as copies with consistently remapped ids.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import { ErrorCode } from "@shared/errors";
import type { ImportPreview, ImportReport } from "@shared/portability";
import {
  attachmentMetaSchema,
  type AttachmentMeta,
  type AttachmentStore,
} from "../attachments/store.ts";
import {
  ARTIFACT_MAX_BYTES,
  artifactNameProblem,
  type ArtifactMeta,
  type ArtifactStore,
} from "../artifacts/store.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { ChatIndex } from "../storage/chat-index.ts";
import { atomicWrite, durableUnlink, ensureDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import { parseConversation, serializeConversation } from "../storage/markdown.ts";
import { nameKey, parseMemory, type MemoryStore } from "../storage/memories.ts";
import { isUuid, type DataPaths } from "../storage/paths.ts";
import type { PreferencesStore } from "../storage/preferences.ts";
import type { ProposalRecord } from "../storage/proposals.ts";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, sha256, stagingDir, type Manifest } from "./export.ts";
import { ZipError, ZipReader, type ZipLimits } from "./zip.ts";

export interface ImportLimits {
  /** Compressed archive size. */
  maxArchiveBytes: number;
  zip: ZipLimits;
  /** Wall-clock bound for a preview or a commit. */
  maxMs: number;
  /** Staged archives without a commit are removed after this long. */
  stagingTtlMs: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxArchiveBytes: 2 * 1024 ** 3,
  zip: {
    maxEntries: 50_000,
    maxEntryBytes: 100 * 1024 ** 2,
    maxTotalBytes: 4 * 1024 ** 3,
    maxRatio: 100,
    maxDepth: 3,
  },
  maxMs: 10 * 60_000,
  stagingTtlMs: 24 * 3_600_000,
};

/** The nil UUID: an artifact backlink to a chat that was not imported (a dead link). */
export const DEAD_LINK = "00000000-0000-0000-0000-000000000000";

export interface ImportDeps {
  paths: DataPaths;
  locks: KeyedLocks;
  index: ChatIndex;
  attachments: AttachmentStore;
  artifacts: ArtifactStore;
  memories: MemoryStore;
  preferences: PreferencesStore;
  logger: Logger;
  now: () => Date;
  limits?: ImportLimits;
  /** Test hook: after some files were created, before the commit is recorded. */
  hooks?: { midCommit?: () => Promise<void> };
}

export interface CommitChoices {
  /** Items whose id exists with different content: skip them (default) or import copies. */
  conflicts: "skip" | "copy";
  /** Approved memories from the archive the user chose to import (by archive id). */
  memories: string[];
  /** Replace default model and image options with the archive's (pins always merge). */
  preferences: boolean;
}

// ---------------------------------------------------------------------------
// Parsing the archive

interface ArchiveConversation {
  id: string;
  bytes: Buffer;
  malformed: boolean;
}
interface ArchiveFile<M> {
  meta: M;
  metaBytes: Buffer;
  blob: Buffer;
}
interface Archive {
  key: string;
  manifest: Manifest;
  conversations: Map<string, ArchiveConversation>;
  attachments: Map<string, ArchiveFile<AttachmentMeta>>;
  artifacts: Map<string, ArchiveFile<ArtifactMeta>>;
  memories: Map<string, { bytes: Buffer; name: string; body: string }>;
  proposals: Map<string, ProposalRecord[]>;
  preferences: Record<string, unknown> | null;
  skipped: ImportReport["skipped"];
}

const ENTRY_RE =
  /^(?:manifest\.json|preferences\.json|chats\/[0-9a-f-]{36}\.md|memories\/[0-9a-f-]{36}\.md|proposals\/[0-9a-f-]{36}\.json|(?:attachments|artifacts)\/[0-9a-f-]{36}\/(?:meta\.json|blob))$/;

function invalid(message: string): AppError {
  return new AppError(ErrorCode.VALIDATION, `This archive can't be imported: ${message}`);
}

function deadline(limits: ImportLimits): () => void {
  const end = Date.now() + limits.maxMs;
  return () => {
    if (Date.now() > end) throw new AppError(ErrorCode.VALIDATION, "The import took too long");
  };
}

function isArtifactMeta(value: unknown, id: string): value is ArtifactMeta {
  const m = value as Partial<ArtifactMeta> | null;
  return (
    m?.version === 1 &&
    m.id === id &&
    typeof m.filename === "string" &&
    !artifactNameProblem(m.filename) &&
    typeof m.size === "number" &&
    m.size <= ARTIFACT_MAX_BYTES &&
    typeof m.sha256 === "string" &&
    typeof m.assistantMessageId === "string" &&
    isUuid(m.assistantMessageId) &&
    typeof m.captureIndex === "number" &&
    typeof m.conversationId === "string" &&
    isUuid(m.conversationId) &&
    typeof m.createdAt === "string"
  );
}

/** Reads and validates the whole archive; nothing canonical is touched (preflight). */
async function readArchive(file: string, limits: ImportLimits): Promise<Archive> {
  const check = deadline(limits);
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(file, limits.zip);
  } catch (error) {
    throw error instanceof ZipError ? invalid(error.message) : error;
  }
  try {
    if (!zip.has("manifest.json")) throw invalid("it has no manifest");
    let manifest: Manifest;
    try {
      manifest = JSON.parse((await zip.get("manifest.json")).toString("utf8")) as Manifest;
    } catch {
      throw invalid("the manifest is not valid JSON");
    }
    const head = manifest as { format?: unknown; version?: unknown };
    if (head.format !== ARCHIVE_FORMAT || head.version !== ARCHIVE_VERSION)
      throw invalid("it is not a ChatUI archive of a supported version");
    if (!Array.isArray(manifest.entries)) throw invalid("the manifest lists no entries");
    const names = new Set(zip.entries().map((e) => e.name));
    names.delete("manifest.json");
    const listed = new Set(manifest.entries.map((e) => e.path));
    if (listed.size !== manifest.entries.length || listed.size !== names.size)
      throw invalid("the manifest does not match its files");
    const data = new Map<string, Buffer>();
    for (const entry of manifest.entries) {
      check();
      if (!names.has(entry.path) || !ENTRY_RE.test(entry.path))
        throw invalid(`unexpected file ${JSON.stringify(entry.path.slice(0, 80))}`);
      const bytes = await zip.get(entry.path).catch((error: unknown) => {
        throw error instanceof ZipError ? invalid(error.message) : error;
      });
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
        throw invalid(`the checksum of ${entry.path} does not match`);
      data.set(entry.path, bytes);
    }
    const key = sha256(
      manifest.entries
        .map((e) => `${e.path}:${e.sha256}`)
        .sort()
        .join("\n"),
    );
    const archive: Archive = {
      key,
      manifest,
      conversations: new Map(),
      attachments: new Map(),
      artifacts: new Map(),
      memories: new Map(),
      proposals: new Map(),
      preferences: null,
      skipped: [],
    };
    for (const [name, bytes] of data) {
      const [kind = "", second = "", third] = name.split("/");
      if (kind === "chats") {
        const id = second.slice(0, -3);
        archive.conversations.set(id, {
          id,
          bytes,
          malformed: !parseConversation(bytes.toString("utf8")).ok,
        });
      } else if (kind === "memories") {
        const id = second.slice(0, -3);
        const memory = parseMemory(bytes, id);
        if (memory) archive.memories.set(id, { bytes, name: memory.name, body: memory.body });
        else archive.skipped.push({ kind: "memory", id, reason: "the file is not a valid memory" });
      } else if (kind === "proposals") {
        const id = second.slice(0, -5);
        try {
          const file = JSON.parse(bytes.toString("utf8")) as {
            version?: unknown;
            conversationId?: unknown;
            proposals?: unknown;
          };
          if (file.version !== 1 || file.conversationId !== id || !Array.isArray(file.proposals))
            throw new Error("bad sidecar");
          archive.proposals.set(id, (file.proposals as ProposalRecord[]).slice(0, 500));
        } catch {
          archive.skipped.push({ kind: "suggestions", id, reason: "the file is not valid" });
        }
      } else if (kind === "preferences.json") {
        try {
          const prefs = JSON.parse(bytes.toString("utf8")) as unknown;
          if (prefs && typeof prefs === "object" && !Array.isArray(prefs))
            archive.preferences = prefs as Record<string, unknown>;
        } catch {
          archive.skipped.push({ kind: "settings", id: "preferences", reason: "not valid JSON" });
        }
      } else if ((kind === "attachments" || kind === "artifacts") && third === "meta.json") {
        const blob = data.get(`${kind}/${second}/blob`);
        let raw: unknown;
        try {
          raw = JSON.parse(bytes.toString("utf8"));
        } catch {
          raw = null;
        }
        if (kind === "attachments") {
          const parsed = attachmentMetaSchema.safeParse(raw);
          if (
            !parsed.success ||
            parsed.data.id !== second ||
            !blob ||
            sha256(blob) !== parsed.data.sha256 ||
            blob.length !== parsed.data.size
          ) {
            archive.skipped.push({ kind: "file", id: second, reason: "its data is not valid" });
            continue;
          }
          archive.attachments.set(second, { meta: parsed.data, metaBytes: bytes, blob });
        } else {
          if (
            !isArtifactMeta(raw, second) ||
            !blob ||
            sha256(blob) !== raw.sha256 ||
            blob.length !== raw.size
          ) {
            archive.skipped.push({
              kind: "file from a reply",
              id: second,
              reason: "its data is not valid",
            });
            continue;
          }
          archive.artifacts.set(second, {
            meta: { ...raw, finalized: true },
            metaBytes: bytes,
            blob,
          });
        }
      }
    }
    return archive;
  } finally {
    await zip.close();
  }
}

// ---------------------------------------------------------------------------
// Planning against the user's current data

type Status = "new" | "present" | "conflict";

interface Plan {
  conversations: Map<
    string,
    { status: Status; target: string | null; bytes: Buffer; rewritten: boolean }
  >;
  attachments: Map<
    string,
    { status: Status; target: string | null; meta: AttachmentMeta; blob: Buffer }
  >;
  artifacts: Map<
    string,
    { status: Status; target: string | null; meta: ArtifactMeta; blob: Buffer }
  >;
  memories: Map<string, { status: Status | "name_taken"; target: string | null; bytes: Buffer }>;
  sidecars: Map<string, ProposalRecord[]>;
  pins: string[];
  skipped: ImportReport["skipped"];
  counts: ImportReport["counts"];
}

function statusOf(existing: Buffer | null, incoming: Buffer): Status {
  if (!existing) return "new";
  return existing.equals(incoming) ? "present" : "conflict";
}

/**
 * Decides every item: write it (keeping or remapping its id), skip it as
 * already present, or skip it (a conflict or a dependency of a skipped item).
 * Without `choices` it plans the preview (conflicts skipped).
 */
async function plan(
  userId: string,
  archive: Archive,
  deps: ImportDeps,
  choices: CommitChoices,
): Promise<Plan> {
  const { paths } = deps;
  const copy = choices.conflicts === "copy";
  const skipped = [...archive.skipped];
  const counts = {
    conversations: 0,
    files: 0,
    filesFromReplies: 0,
    memories: 0,
    suggestions: 0,
    present: 0,
    rewritten: 0,
  };
  const conversations: Plan["conversations"] = new Map();
  for (const c of archive.conversations.values()) {
    const status = statusOf(await readOrNull(paths.chatFile(userId, c.id)), c.bytes);
    const target =
      status === "new" ? c.id : status === "present" ? null : copy ? randomUUID() : null;
    if (status === "conflict" && !copy)
      skipped.push({ kind: "chat", id: c.id, reason: "a different chat with this id exists" });
    conversations.set(c.id, { status, target, bytes: c.bytes, rewritten: false });
  }
  // A chat that ends up in the user's data under this id (new, copied or present).
  const chatAfter = (id: string): string | null => {
    const c = conversations.get(id);
    if (!c) return null;
    return c.status === "present" ? id : c.target;
  };

  const attachments: Plan["attachments"] = new Map();
  for (const [id, file] of archive.attachments) {
    const existing = await readOrNull(paths.attachmentMeta(userId, id));
    const existingMeta = existing
      ? attachmentMetaSchema.safeParse(JSON.parse(existing.toString("utf8"))).data
      : undefined;
    const same =
      existingMeta?.sha256 === file.meta.sha256 && existingMeta.filename === file.meta.filename;
    const status: Status = !existing ? "new" : same ? "present" : "conflict";
    const chat = file.meta.conversationId;
    let target: string | null;
    if (chat !== null) {
      const owner = conversations.get(chat);
      const after = chatAfter(chat);
      if (!owner || after === null) {
        target = null;
        if (!owner) skipped.push({ kind: "file", id, reason: "its chat is not in the archive" });
        else if (owner.target === null && owner.status !== "present")
          skipped.push({ kind: "file", id, reason: "its chat was skipped" });
      } else if (owner.status === "present") {
        target = null; // the chat and its files are already here
      } else if (status === "new" && owner.target === chat) {
        target = id;
      } else {
        target = randomUUID(); // the id is taken, or the chat is a copy
      }
    } else {
      target = status === "new" ? id : status === "present" ? null : copy ? randomUUID() : null;
      if (status === "conflict" && !copy)
        skipped.push({ kind: "file", id, reason: "a different file with this id exists" });
    }
    attachments.set(id, { status, target, meta: file.meta, blob: file.blob });
  }

  // Chats whose attachment ids change are rewritten through parse/serialize.
  for (const [id, c] of conversations) {
    if (c.target === null) continue;
    const remap = new Map<string, string>();
    for (const [aid, a] of attachments)
      if (a.meta.conversationId === id && a.target !== null && a.target !== aid)
        remap.set(aid, a.target);
    const source = archive.conversations.get(id);
    if (source?.malformed) {
      if (c.target !== id || remap.size > 0) {
        skipped.push({ kind: "chat", id, reason: "it is malformed and would need new ids" });
        c.target = null;
        for (const a of attachments.values()) if (a.meta.conversationId === id) a.target = null;
      }
      continue;
    }
    if (remap.size === 0) continue;
    const parsed = parseConversation(c.bytes.toString("utf8"));
    if (!parsed.ok) continue;
    const blocks = parsed.conversation.blocks.map((b) =>
      b.type === "user" && b.attachments
        ? { ...b, attachments: b.attachments.map((x) => remap.get(x) ?? x) }
        : b,
    );
    c.bytes = Buffer.from(serializeConversation({ ...parsed.conversation, blocks }));
    c.rewritten = true;
  }

  // Memories: only the user's explicit selection; never a silent replacement.
  const memories: Plan["memories"] = new Map();
  const taken = new Map((await deps.memories.list(userId)).map((m) => [nameKey(m.name), m.id]));
  for (const [id, m] of archive.memories) {
    const existing = await readOrNull(paths.memoryFile(userId, id));
    const holder = taken.get(nameKey(m.name));
    let status: Status | "name_taken" = statusOf(existing, m.bytes);
    if (status === "new" && holder !== undefined && holder !== id) status = "name_taken";
    let target: string | null = null;
    if (choices.memories.includes(id)) {
      if (status === "new") target = id;
      else if (status === "conflict" && copy && holder === undefined) target = randomUUID();
      if (target === null && status !== "present")
        skipped.push({
          kind: "memory",
          id,
          // A copy would need a second note with the same name, which names forbid (§12).
          reason:
            status === "conflict" && !(copy && holder !== undefined)
              ? "a different memory with this id exists"
              : "a memory with this name exists",
        });
      if (target !== null) taken.set(nameKey(m.name), target);
    }
    memories.set(id, { status, target, bytes: m.bytes });
  }
  const memoryAfter = (id: string | null): string | null => {
    if (id === null) return null;
    const m = memories.get(id);
    if (!m) return null;
    return m.status === "present" ? id : m.target;
  };

  // Artifacts are independent: a skipped chat leaves a dead backlink.
  const artifacts: Plan["artifacts"] = new Map();
  for (const [id, file] of archive.artifacts) {
    const existing = await readOrNull(
      path.join(paths.userDir(userId), "artifacts", id, "meta.json"),
    );
    let status: Status = "new";
    if (existing) {
      const current = JSON.parse(existing.toString("utf8")) as Partial<ArtifactMeta>;
      status =
        current.sha256 === file.meta.sha256 && current.filename === file.meta.filename
          ? "present"
          : "conflict";
    }
    const target = status === "new" ? id : status === "present" ? null : copy ? randomUUID() : null;
    if (status === "conflict" && !copy)
      skipped.push({
        kind: "file from a reply",
        id,
        reason: "a different file with this id exists",
      });
    const backlink = chatAfter(file.meta.conversationId) ?? DEAD_LINK;
    artifacts.set(id, {
      status,
      target,
      meta: { ...file.meta, conversationId: backlink },
      blob: file.blob,
    });
  }

  // Suggestions follow their chat; unresolved ones become invalid (never auto-approved).
  const sidecars: Plan["sidecars"] = new Map();
  for (const [chat, records] of archive.proposals) {
    const c = conversations.get(chat);
    if (c?.target == null) {
      if (records.length > 0 && c?.status !== "present")
        skipped.push({ kind: "suggestions", id: chat, reason: "their chat was not imported" });
      continue;
    }
    const now = deps.now().toISOString();
    sidecars.set(
      c.target,
      records.map((r) => {
        const target = memoryAfter(r.targetMemoryId);
        const unresolved =
          r.status === "pending" ||
          (r.targetMemoryId !== null && target === null && r.status !== "accepted");
        return {
          ...r,
          id: c.target === chat ? r.id : randomUUID(),
          targetMemoryId: target ?? r.targetMemoryId,
          status:
            unresolved && r.status !== "rejected" && r.status !== "suppressed"
              ? "invalid"
              : r.status,
          decidedAt: unresolved ? (r.decidedAt ?? now) : r.decidedAt,
          stale: false,
          intent: null,
        };
      }),
    );
  }

  const pins = Array.isArray(archive.preferences?.pins)
    ? (archive.preferences.pins as unknown[])
        .filter((p): p is string => typeof p === "string")
        .map((p) => chatAfter(p))
        .filter((p): p is string => p !== null)
    : [];

  for (const c of conversations.values()) {
    if (c.target !== null) counts.conversations++;
    if (c.status === "present") counts.present++;
    if (c.rewritten && c.target !== null) counts.rewritten++;
  }
  for (const a of attachments.values()) if (a.target !== null) counts.files++;
  for (const a of artifacts.values()) if (a.target !== null) counts.filesFromReplies++;
  for (const m of memories.values()) if (m.target !== null) counts.memories++;
  for (const records of sidecars.values()) counts.suggestions += records.length;
  return { conversations, attachments, artifacts, memories, sidecars, pins, skipped, counts };
}

// ---------------------------------------------------------------------------
// The service

interface Journal {
  version: 1;
  status: "committing" | "committed";
  /** Files this commit creates, relative to the user directory. */
  targets: string[];
  /** preferences.json before the commit (restored on rollback), or null if absent. */
  preferences: string | null;
}

export class ImportService {
  private readonly d: ImportDeps;
  private readonly limits: ImportLimits;

  constructor(deps: ImportDeps) {
    this.d = deps;
    this.limits = deps.limits ?? DEFAULT_IMPORT_LIMITS;
  }

  private dir(userId: string, importId?: string): string {
    const root = stagingDir(this.d.paths, userId);
    if (importId === undefined) return root;
    if (!/^[0-9a-f]{32}$/.test(importId))
      throw new AppError(ErrorCode.NOT_FOUND, "Import not found");
    return path.join(root, importId);
  }

  /** Moves an uploaded archive into staging and returns its preview. */
  async stage(userId: string, uploaded: string, size: number): Promise<ImportPreview> {
    if (size > this.limits.maxArchiveBytes) {
      await rm(uploaded, { force: true });
      throw invalid("it is too large");
    }
    const importId = randomBytes(16).toString("hex");
    const dir = this.dir(userId, importId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await rename(uploaded, path.join(dir, "archive.zip"));
    try {
      return await this.preview(userId, importId);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Streams an uploaded archive into staging (bounded) and returns its preview. */
  async receive(userId: string, stream: Readable): Promise<ImportPreview> {
    await ensureDir(this.dir(userId));
    const target = path.join(this.dir(userId), `upload-${randomBytes(8).toString("hex")}.zip`);
    const file = await open(target, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > this.limits.maxArchiveBytes) throw invalid("it is too large");
        await file.write(chunk);
      }
      await file.sync();
    } catch (error) {
      await file.close();
      await rm(target, { force: true });
      throw error instanceof AppError ? error : invalid("the upload was interrupted");
    }
    await file.close();
    return this.stage(userId, target, size);
  }

  async preview(userId: string, importId: string): Promise<ImportPreview> {
    const file = path.join(this.dir(userId, importId), "archive.zip");
    if (!(await stat(file).catch(() => null)))
      throw new AppError(ErrorCode.NOT_FOUND, "Import not found");
    const archive = await readArchive(file, this.limits);
    const p = await plan(userId, archive, this.d, {
      conflicts: "skip",
      memories: [...archive.memories.keys()],
      preferences: false,
    });
    const done = await this.importedKeys(userId);
    const conflicts: ImportPreview["conflicts"] = [];
    for (const [id, c] of p.conversations)
      if (c.status === "conflict") conflicts.push({ kind: "chat", id, label: titleOf(c.bytes) });
    for (const [id, a] of p.attachments)
      if (a.status === "conflict" && a.meta.conversationId === null)
        conflicts.push({ kind: "file", id, label: a.meta.filename });
    for (const [id, a] of p.artifacts)
      if (a.status === "conflict")
        conflicts.push({ kind: "file from a reply", id, label: a.meta.filename });
    for (const [id, m] of p.memories)
      if (m.status === "conflict")
        conflicts.push({ kind: "memory", id, label: archive.memories.get(id)?.name ?? id });
    const count = (map: Map<string, { status: string }>, status: string) =>
      [...map.values()].filter((v) => v.status === status).length;
    return {
      importId,
      idempotencyKey: archive.key,
      alreadyImported: done.includes(archive.key),
      exportedAt:
        typeof archive.manifest.exportedAt === "string" ? archive.manifest.exportedAt : null,
      chats: {
        new: count(p.conversations, "new"),
        present: count(p.conversations, "present"),
        conflict: count(p.conversations, "conflict"),
        malformed: [...archive.conversations.values()].filter((c) => c.malformed).length,
      },
      files: archive.attachments.size,
      filesFromReplies: archive.artifacts.size,
      suggestions: [...archive.proposals.values()].reduce((n, r) => n + r.length, 0),
      memories: [...archive.memories].map(([id, m]) => ({
        id,
        name: m.name,
        body: m.body.slice(0, 200),
        status: p.memories.get(id)?.status ?? "new",
      })),
      hasPreferences: archive.preferences !== null,
      conflicts,
      skipped: p.skipped.filter(
        (s) =>
          !(s.reason.startsWith("a different") || s.reason === "a memory with this name exists"),
      ),
    };
  }

  async cancel(userId: string, importId: string): Promise<void> {
    const dir = this.dir(userId, importId);
    if (await readOrNull(path.join(dir, "journal.json"))) return; // a commit owns it
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Commits a staged archive: re-validates and re-plans against the current
   * data, records the journal of files to create, creates them (never
   * overwriting), merges preferences, then records the commit and rebuilds
   * the chat index.
   */
  async commit(userId: string, importId: string, choices: CommitChoices): Promise<ImportReport> {
    const dir = this.dir(userId, importId);
    const file = path.join(dir, "archive.zip");
    if (!(await stat(file).catch(() => null)))
      throw new AppError(ErrorCode.NOT_FOUND, "Import not found");
    const check = deadline(this.limits);
    // Canonical mutation: holds the export barrier shared (contracts §2).
    const report = await this.d.locks.run(`import:${userId}`, async () => {
      const archive = await readArchive(file, this.limits);
      const p = await plan(userId, archive, this.d, choices);
      const { paths } = this.d;
      const userDir = paths.userDir(userId);
      const rel = (abs: string) => path.relative(userDir, abs);
      const writes: { file: string; bytes: Buffer }[] = [];
      for (const a of p.attachments.values()) {
        if (a.target === null) continue;
        const chat =
          a.meta.conversationId === null
            ? null
            : (p.conversations.get(a.meta.conversationId)?.target ?? null);
        const meta: AttachmentMeta = {
          ...a.meta,
          id: a.target,
          ownerId: userId,
          conversationId: chat,
        };
        writes.push({ file: paths.attachmentBlob(userId, a.target), bytes: a.blob });
        writes.push({
          file: paths.attachmentMeta(userId, a.target),
          bytes: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`),
        });
      }
      const usage = await this.d.attachments.usage(userId);
      const adding = [...p.attachments.values()].reduce(
        (n, a) => n + (a.target === null ? 0 : a.blob.length),
        0,
      );
      const quota = this.d.attachments.quotaBytes();
      if (usage + adding > quota)
        throw new AppError(
          ErrorCode.VALIDATION,
          "There is not enough storage for this archive's files",
        );
      for (const a of p.artifacts.values()) {
        if (a.target === null) continue;
        const meta: ArtifactMeta = { ...a.meta, id: a.target, ownerId: userId, finalized: true };
        const base = path.join(userDir, "artifacts", a.target);
        writes.push({ file: path.join(base, "blob"), bytes: a.blob });
        writes.push({
          file: path.join(base, "meta.json"),
          bytes: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`),
        });
      }
      for (const m of p.memories.values())
        if (m.target !== null) {
          let bytes = m.bytes;
          if (m.target !== /^id: (.+)$/m.exec(m.bytes.toString("utf8"))?.[1])
            bytes = Buffer.from(m.bytes.toString("utf8").replace(/^id: .+$/m, `id: ${m.target}`));
          writes.push({ file: paths.memoryFile(userId, m.target), bytes });
        }
      for (const c of p.conversations.values())
        if (c.target !== null)
          writes.push({ file: paths.chatFile(userId, c.target), bytes: c.bytes });
      for (const [chat, records] of p.sidecars)
        writes.push({
          file: paths.proposalFile(userId, chat),
          bytes: Buffer.from(
            `${JSON.stringify({ version: 1, conversationId: chat, proposals: records }, null, 2)}\n`,
          ),
        });

      // Never overwrite: any target that exists now aborts before the journal.
      for (const w of writes)
        if (await readOrNull(w.file))
          throw new AppError(
            ErrorCode.CONFLICT,
            "Your data changed while importing; preview the archive again",
          );

      const before = await readOrNull(paths.preferencesFile(userId));
      const journal: Journal = {
        version: 1,
        status: "committing",
        targets: writes.map((w) => rel(w.file)),
        preferences: before ? before.toString("utf8") : null,
      };
      await atomicWrite(path.join(dir, "journal.json"), JSON.stringify(journal));
      let written = 0;
      for (const w of writes) {
        check();
        await ensureDir(path.dirname(path.dirname(w.file)));
        await ensureDir(path.dirname(w.file));
        await atomicWrite(w.file, w.bytes);
        written++;
        if (written === Math.ceil(writes.length / 2)) await this.d.hooks?.midCommit?.();
      }
      const archivePrefs = archive.preferences ?? {};
      const chatTargets = new Map(
        [...p.conversations].map(([id, c]) => [id, c.status === "present" ? id : c.target]),
      );
      await this.d.preferences.update(userId, {}, (current) => ({
        pins: [...current.pins, ...p.pins.filter((id) => !current.pins.includes(id))].slice(0, 500),
        ...mergeProjects(current, archivePrefs, chatTargets),
        ...(choices.preferences
          ? {
              defaultProvider:
                typeof archivePrefs.defaultProvider === "string"
                  ? archivePrefs.defaultProvider
                  : current.defaultProvider,
              defaultModel:
                typeof archivePrefs.defaultModel === "string"
                  ? archivePrefs.defaultModel
                  : current.defaultModel,
              historyImages:
                archivePrefs.historyImages === "include" || archivePrefs.historyImages === "omit"
                  ? archivePrefs.historyImages
                  : current.historyImages,
              imageMaxEdge:
                typeof archivePrefs.imageMaxEdge === "number"
                  ? archivePrefs.imageMaxEdge
                  : current.imageMaxEdge,
            }
          : {}),
      }));
      await atomicWrite(
        path.join(dir, "journal.json"),
        JSON.stringify({ ...journal, status: "committed" }),
      );
      return {
        counts: p.counts,
        skipped: p.skipped,
        rewritten: [...p.conversations.values()]
          .filter((c) => c.rewritten && c.target !== null)
          .map((c) => c.target as string),
        key: archive.key,
      };
    });
    await this.d.index.rebuild(userId);
    this.d.artifacts.forgetUser(userId);
    this.d.attachments.forgetUser(userId);
    await this.remember(userId, report.key);
    await rm(dir, { recursive: true, force: true });
    return { counts: report.counts, skipped: report.skipped, rewrittenChats: report.rewritten };
  }

  private async importedKeys(userId: string): Promise<string[]> {
    const bytes = await readOrNull(path.join(this.dir(userId), "imported.json"));
    try {
      const keys = bytes ? (JSON.parse(bytes.toString("utf8")) as unknown) : [];
      return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
    } catch {
      return [];
    }
  }

  /** Completed imports by idempotency key (the last 100), so a repeat is flagged. */
  private async remember(userId: string, key: string): Promise<void> {
    const keys = [key, ...(await this.importedKeys(userId)).filter((k) => k !== key)].slice(0, 100);
    await atomicWrite(path.join(this.dir(userId), "imported.json"), JSON.stringify(keys));
  }

  /**
   * Startup step 3 (contracts §2): an interrupted commit is rolled back (its
   * created files removed, preferences restored); a recorded commit is only
   * cleaned up; stale staging and export files are removed.
   */
  async recover(userId: string): Promise<{ rolledBack: number; removed: number }> {
    const root = this.dir(userId);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return { rolledBack: 0, removed: 0 };
    }
    let rolledBack = 0;
    let removed = 0;
    const userDir = this.d.paths.userDir(userId);
    for (const name of names) {
      const full = path.join(root, name);
      if (name.startsWith("export-") || name.startsWith("upload-")) {
        await rm(full, { force: true });
        removed++;
        continue;
      }
      if (!/^[0-9a-f]{32}$/.test(name)) continue;
      const journalBytes = await readOrNull(path.join(full, "journal.json"));
      if (journalBytes) {
        const journal = JSON.parse(journalBytes.toString("utf8")) as Journal;
        if (journal.status === "committing") {
          for (const target of journal.targets) {
            const abs = path.resolve(userDir, target);
            if (!abs.startsWith(`${userDir}${path.sep}`)) continue;
            await durableUnlink(abs);
            // Artifact and attachment directories created by the commit.
            if (abs.endsWith(`${path.sep}meta.json`) || abs.endsWith(`${path.sep}blob`))
              await rm(path.dirname(abs), { recursive: true, force: true });
          }
          if (journal.preferences !== null)
            await atomicWrite(this.d.paths.preferencesFile(userId), journal.preferences);
          else await durableUnlink(this.d.paths.preferencesFile(userId));
          rolledBack++;
          this.d.logger.warn({ importId: name }, "rolled back an interrupted import");
        }
        await rm(full, { recursive: true, force: true });
        removed++;
        continue;
      }
      const info = await stat(full).catch(() => null);
      if (!info || Date.now() - info.mtimeMs > this.limits.stagingTtlMs) {
        await rm(full, { recursive: true, force: true });
        removed++;
      }
    }
    if (rolledBack > 0) await this.d.index.rebuild(userId);
    return { rolledBack, removed };
  }
}

/**
 * Projects (Phase 13g): the archive's projects are added when their id is new
 * (a clashing name gets " (imported)"); imported chats keep their project.
 * Existing projects and placements are never changed.
 */
function mergeProjects(
  current: {
    projects: { id: string; name: string; createdAt: string }[];
    chatProjects: Record<string, string>;
  },
  archive: Record<string, unknown>,
  chatTargets: Map<string, string | null>,
): { projects: typeof current.projects; chatProjects: Record<string, string> } {
  const projects = [...current.projects];
  const names = new Set(projects.map((p) => p.name.normalize("NFC").toLowerCase()));
  const incoming = Array.isArray(archive.projects) ? (archive.projects as unknown[]) : [];
  for (const raw of incoming) {
    const p = raw as { id?: unknown; name?: unknown; createdAt?: unknown };
    if (typeof p.id !== "string" || !isUuid(p.id) || typeof p.name !== "string") continue;
    if (projects.some((q) => q.id === p.id) || projects.length >= 100) continue;
    let name = p.name.trim().slice(0, 60) || "Project";
    if (names.has(name.normalize("NFC").toLowerCase())) name = `${name.slice(0, 48)} (imported)`;
    names.add(name.normalize("NFC").toLowerCase());
    projects.push({
      id: p.id,
      name,
      createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
    });
  }
  const chatProjects = { ...current.chatProjects };
  const placed = archive.chatProjects;
  if (placed && typeof placed === "object" && !Array.isArray(placed)) {
    for (const [chat, project] of Object.entries(placed as Record<string, unknown>)) {
      const target = chatTargets.get(chat);
      if (!target || typeof project !== "string" || target in chatProjects) continue;
      if (projects.some((q) => q.id === project)) chatProjects[target] = project;
    }
  }
  return { projects, chatProjects };
}

function titleOf(bytes: Buffer): string {
  const parsed = parseConversation(bytes.toString("utf8"));
  return parsed.ok ? parsed.conversation.title : "Malformed chat";
}

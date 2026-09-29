// Derived conversation index (contracts §1, INV-11). Loadable natively by Node.
// data/<user>/index/chats.json is never the source of truth: it is rebuilt from
// chats/*.md when missing, unparseable or marked dirty, and reconciled with the
// files (size + mtime) at every start so hand edits show up after a restart.
import { stat } from "node:fs/promises";
import { atomicWrite, durableUnlink, ensureDir, listDir, readOrNull } from "./fs.ts";
import { parseConversation, type ConversationModel } from "./markdown.ts";
import { isUuid, type DataPaths } from "./paths.ts";

export interface FileStamp {
  fileSize: number;
  fileMtimeMs: number;
}

export interface IndexEntry extends FileStamp {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  malformed: boolean;
}

interface IndexFile {
  version: 1;
  entries: IndexEntry[];
}

export interface IndexLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Counts user, assistant and system messages (reasoning belongs to its assistant). */
export function messageCount(model: ConversationModel): number {
  return model.blocks.filter((block) => block.type !== "reasoning").length;
}

export async function stampOf(file: string): Promise<FileStamp | undefined> {
  const info = await stat(file).catch(() => undefined);
  return info ? { fileSize: info.size, fileMtimeMs: info.mtimeMs } : undefined;
}

export function entryFor(id: string, model: ConversationModel, stamp: FileStamp): IndexEntry {
  return {
    id,
    title: model.title,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    messageCount: messageCount(model),
    malformed: false,
    ...stamp,
  };
}

function malformedEntry(id: string, stamp: FileStamp): IndexEntry {
  const when = new Date(stamp.fileMtimeMs).toISOString();
  return {
    id,
    title: "Unreadable conversation",
    createdAt: when,
    updatedAt: when,
    messageCount: 0,
    malformed: true,
    ...stamp,
  };
}

function isEntry(e: unknown): e is IndexEntry {
  if (typeof e !== "object" || e === null) return false;
  const x = e as Partial<IndexEntry>;
  return (
    typeof x.id === "string" &&
    isUuid(x.id) &&
    typeof x.title === "string" &&
    typeof x.createdAt === "string" &&
    typeof x.updatedAt === "string" &&
    typeof x.messageCount === "number" &&
    typeof x.malformed === "boolean" &&
    typeof x.fileSize === "number" &&
    typeof x.fileMtimeMs === "number"
  );
}

function isIndexFile(value: unknown): value is IndexFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; entries?: unknown };
  return (
    candidate.version === 1 && Array.isArray(candidate.entries) && candidate.entries.every(isEntry)
  );
}

export class ChatIndex {
  private readonly paths: DataPaths;
  private readonly logger: IndexLogger;
  private readonly entries = new Map<string, Map<string, IndexEntry>>();
  /** Per-user persistence queue (the "derived-index queue" in the lock order). */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();

  constructor(paths: DataPaths, logger: IndexLogger) {
    this.paths = paths;
    this.logger = logger;
  }

  /**
   * Derives entries from chats/*.md. With `previous`, files whose size and
   * mtime are unchanged keep their entry; others are re-parsed.
   */
  private async scan(
    userId: string,
    previous?: Map<string, IndexEntry>,
  ): Promise<{ map: Map<string, IndexEntry>; changed: number }> {
    const map = new Map<string, IndexEntry>();
    let changed = 0;
    for (const name of await listDir(this.paths.chatsDir(userId))) {
      const id = name.endsWith(".md") ? name.slice(0, -3) : "";
      if (!isUuid(id)) {
        if (!name.startsWith("."))
          this.logger.warn({ file: name }, "ignoring unexpected file in chats/");
        continue;
      }
      const file = this.paths.chatFile(userId, id);
      const stamp = await stampOf(file);
      if (!stamp) continue;
      const known = previous?.get(id);
      if (known?.fileSize === stamp.fileSize && known.fileMtimeMs === stamp.fileMtimeMs) {
        map.set(id, known);
        continue;
      }
      const bytes = await readOrNull(file);
      if (!bytes) continue;
      const parsed = parseConversation(bytes.toString("utf8"));
      map.set(id, parsed.ok ? entryFor(id, parsed.conversation, stamp) : malformedEntry(id, stamp));
      changed++;
    }
    if (previous) changed += [...previous.keys()].filter((id) => !map.has(id)).length;
    return { map, changed };
  }

  /** Rebuilds the index entirely from canonical files. */
  async rebuild(userId: string): Promise<IndexEntry[]> {
    const { map } = await this.scan(userId);
    this.entries.set(userId, map);
    await this.enqueuePersist(userId);
    await durableUnlink(this.paths.indexDirtyFile(userId));
    this.logger.info({ conversations: map.size }, "conversation index rebuilt");
    return [...map.values()];
  }

  /** Loads the index: rebuild when missing/unparseable/dirty, else reconcile. */
  async load(userId: string): Promise<void> {
    const dirty = (await readOrNull(this.paths.indexDirtyFile(userId))) !== null;
    const raw = await readOrNull(this.paths.indexFile(userId));
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw.toString("utf8")) : undefined;
    } catch {
      parsed = undefined;
    }
    if (dirty || !isIndexFile(parsed)) {
      this.logger.info(
        { reason: dirty ? "dirty" : raw ? "unparseable" : "missing" },
        "rebuilding conversation index",
      );
      await this.rebuild(userId);
      return;
    }
    const previous = new Map(parsed.entries.map((entry) => [entry.id, entry]));
    const { map, changed } = await this.scan(userId, previous);
    this.entries.set(userId, map);
    if (changed > 0) {
      this.logger.info({ changed }, "conversation index reconciled with canonical files");
      await this.enqueuePersist(userId);
    }
  }

  list(userId: string): IndexEntry[] {
    return [...(this.entries.get(userId)?.values() ?? [])].sort((a, b) =>
      a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt < b.updatedAt ? 1 : -1,
    );
  }

  get(userId: string, id: string): IndexEntry | undefined {
    return this.entries.get(userId)?.get(id);
  }

  /**
   * Runs a canonical mutation and reflects it in the index. The dirty marker
   * exists before the canonical write and is removed only after the index is
   * persisted with no other mutation pending, so a crash in between forces a
   * rebuild at the next start. `write` returns the new entry, or null when the
   * conversation was deleted.
   */
  async mutate<T>(
    userId: string,
    id: string,
    write: () => Promise<{ entry: IndexEntry | null; result: T }>,
  ): Promise<T> {
    this.pending.set(userId, (this.pending.get(userId) ?? 0) + 1);
    try {
      await ensureDir(this.paths.indexDir(userId));
      await atomicWrite(this.paths.indexDirtyFile(userId), "");
      const { entry, result } = await write();
      const map = this.entries.get(userId) ?? new Map<string, IndexEntry>();
      this.entries.set(userId, map);
      if (entry) map.set(id, entry);
      else map.delete(id);
      await this.enqueuePersist(userId);
      return result;
    } finally {
      const left = (this.pending.get(userId) ?? 1) - 1;
      this.pending.set(userId, left);
      if (left === 0) {
        await this.enqueue(userId, async () => {
          if ((this.pending.get(userId) ?? 0) === 0)
            await durableUnlink(this.paths.indexDirtyFile(userId));
        });
      }
    }
  }

  private enqueue(userId: string, task: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(userId) ?? Promise.resolve()).then(task, task);
    this.queues.set(
      userId,
      next.catch(() => undefined),
    );
    return next;
  }

  private enqueuePersist(userId: string): Promise<void> {
    return this.enqueue(userId, async () => {
      const file: IndexFile = { version: 1, entries: this.list(userId) };
      await ensureDir(this.paths.indexDir(userId));
      await atomicWrite(this.paths.indexFile(userId), `${JSON.stringify(file, null, 2)}\n`);
    });
  }
}

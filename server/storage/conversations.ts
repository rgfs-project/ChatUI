// Canonical conversation storage (contracts §1–§3). Loadable natively by Node.
import { randomUUID } from "node:crypto";
import { entryFor, stampOf, type ChatIndex, type IndexEntry } from "./chat-index.ts";
import type { AccountWrites } from "./account.ts";
import { atomicWrite, durableUnlink, ensureDir, readOrNull } from "./fs.ts";
import { lockKeys, type KeyedLocks } from "./locks.ts";
import {
  NEW_CONVERSATION_TITLE,
  parseConversation,
  serializeConversation,
  titleProblem,
  type Block,
  type ConversationModel,
} from "./markdown.ts";
import { sha256Hex } from "./operations.ts";
import type { DataPaths } from "./paths.ts";

export class StorageError extends Error {
  override name = "StorageError";
  readonly kind: "not_found" | "malformed" | "conflict" | "invalid";

  constructor(kind: StorageError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface LoadedConversation {
  id: string;
  model: ConversationModel;
  /** Exact canonical bytes (single-chat export in Phase 13d relies on these). */
  bytes: Buffer;
  /** Lowercase hex SHA-256 of the file bytes (contracts §4.1). */
  revision: string;
}

export type ReadResult =
  | { kind: "ok"; conversation: LoadedConversation }
  | { kind: "malformed"; reason: string; line: number; revision: string }
  | { kind: "missing" };

/** First surviving user block, collapsed to one line, cut at a word boundary (§3.3). */
export function autoTitle(model: ConversationModel): string | undefined {
  const first = model.blocks.find((block) => block.type === "user");
  if (!first) return undefined;
  const flat = first.body.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length === 0) return undefined;
  if (chars.length <= 60) return flat;
  const cut = chars.slice(0, 61).join("");
  const space = cut.lastIndexOf(" ");
  return space > 0 ? cut.slice(0, space).trimEnd() : chars.slice(0, 60).join("");
}

export class ConversationStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly index: ChatIndex;
  private readonly now: () => Date;

  constructor(options: {
    paths: DataPaths;
    locks: KeyedLocks;
    index: ChatIndex;
    now?: () => Date;
    /** Account write guard (INV-61); every canonical write runs through it. */
    writes?: AccountWrites;
  }) {
    this.paths = options.paths;
    this.locks = options.locks;
    this.index = options.index;
    this.now = options.now ?? (() => new Date());
    this.writes = options.writes;
  }

  private readonly writes: AccountWrites | undefined;

  private guarded<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.writes ? this.writes.run(userId, fn) : fn();
  }

  /** The data paths (for recovery-style checks by callers). */
  get dataPaths(): DataPaths {
    return this.paths;
  }

  /** Locks currently held (tests assert none are held during network I/O). */
  get heldLocks(): number {
    return this.locks.held;
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  /** Holds the per-conversation lock (contracts §2). No network I/O inside. */
  withLock<T>(userId: string, id: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(lockKeys.conversation(userId, id), fn);
  }

  /** Reads and parses without taking the lock (callers hold it or accept a snapshot). */
  async readUnlocked(userId: string, id: string): Promise<ReadResult> {
    const bytes = await readOrNull(this.paths.chatFile(userId, id));
    if (!bytes) return { kind: "missing" };
    const revision = sha256Hex(bytes);
    const parsed = parseConversation(bytes.toString("utf8"));
    if (!parsed.ok)
      return { kind: "malformed", reason: parsed.reason, line: parsed.line, revision };
    return { kind: "ok", conversation: { id, model: parsed.conversation, bytes, revision } };
  }

  /** Serializes, validates and atomically replaces the file, updating the index. */
  async writeUnlocked(
    userId: string,
    id: string,
    model: ConversationModel,
  ): Promise<LoadedConversation> {
    const text = serializeConversation(model);
    const check = parseConversation(text);
    if (!check.ok)
      throw new StorageError(
        "invalid",
        `refusing to write an invalid conversation: ${check.reason}`,
      );
    const bytes = Buffer.from(text, "utf8");
    return this.guarded(userId, () =>
      this.index.mutate(userId, id, async () => {
        await ensureDir(this.paths.chatsDir(userId));
        const file = this.paths.chatFile(userId, id);
        await atomicWrite(file, bytes);
        const stamp = (await stampOf(file)) ?? { fileSize: bytes.length, fileMtimeMs: Date.now() };
        return {
          entry: entryFor(id, model, stamp),
          result: { id, model, bytes, revision: sha256Hex(bytes) },
        };
      }),
    );
  }

  async deleteUnlocked(userId: string, id: string): Promise<boolean> {
    return this.guarded(userId, () =>
      this.index.mutate(userId, id, async () => {
        const removed = await durableUnlink(this.paths.chatFile(userId, id));
        return { entry: null, result: removed };
      }),
    );
  }

  list(userId: string): IndexEntry[] {
    return this.index.list(userId);
  }

  /** Throws not_found / malformed (INV-10: malformed files are never modified). */
  async get(userId: string, id: string): Promise<LoadedConversation> {
    const read = await this.readUnlocked(userId, id);
    if (read.kind === "missing") throw new StorageError("not_found", "Conversation not found");
    if (read.kind === "malformed")
      throw new StorageError("malformed", "This conversation file is malformed");
    return read.conversation;
  }

  /** Explicit empty-conversation creation (not used by send). */
  async create(userId: string, title = NEW_CONVERSATION_TITLE): Promise<LoadedConversation> {
    const problem = titleProblem(title);
    if (problem) throw new StorageError("invalid", problem);
    const id = randomUUID();
    return this.withLock(userId, id, () => {
      const now = this.timestamp();
      return this.writeUnlocked(userId, id, { title, createdAt: now, updatedAt: now, blocks: [] });
    });
  }

  async rename(
    userId: string,
    id: string,
    title: string,
    expectedRevision?: string,
  ): Promise<LoadedConversation> {
    const problem = titleProblem(title);
    if (problem) throw new StorageError("invalid", problem);
    return this.withLock(userId, id, async () => {
      const current = await this.get(userId, id);
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new StorageError("conflict", "The conversation changed; reload and try again");
      }
      return this.writeUnlocked(userId, id, {
        ...current.model,
        title,
        updatedAt: this.timestamp(),
      });
    });
  }

  /** Deletes the Markdown under the lock, then the index entry (malformed files too). */
  async delete(userId: string, id: string): Promise<void> {
    await this.withLock(userId, id, async () => {
      const removed = await this.deleteUnlocked(userId, id);
      if (!removed) throw new StorageError("not_found", "Conversation not found");
    });
  }

  /**
   * Appends blocks with storage-owned `updatedAt` and the §3.3 auto-title rule.
   * Caller holds the lock and passes the current model.
   */
  appendBlocks(model: ConversationModel, blocks: Block[]): ConversationModel {
    const next: ConversationModel = {
      ...model,
      blocks: [...model.blocks, ...blocks],
      updatedAt: this.timestamp(),
    };
    const completed = blocks.some(
      (block) => block.type === "assistant" && block.status === "complete",
    );
    if (completed && next.title === NEW_CONVERSATION_TITLE) {
      next.title = autoTitle(next) ?? next.title;
    }
    return next;
  }
}

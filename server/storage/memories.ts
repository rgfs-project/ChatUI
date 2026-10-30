// Approved memories (contracts §12, Phase 13b): `memories/<memory-uuid>.md`.
// The filename is a server-minted UUID; the name lives inside the file
// (INV-12). A memory's revision is the SHA-256 of its bytes. Every change
// holds the per-user memory-store lock. Loadable natively by Node.
import { createHash, randomUUID } from "node:crypto";
import { isScalar, isSeq, parseDocument, type Pair } from "yaml";
import { atomicWrite, durableUnlink, ensureDir, listDir, readOrNull } from "./fs.ts";
import { lockKeys, type KeyedLocks } from "./locks.ts";
import { isCanonicalTimestamp, isCanonicalUuid, normalizeBody, quote } from "./markdown.ts";
import type { DataPaths } from "./paths.ts";

export const MEMORY_NAME_MAX = 64;
/** Per-note body cap (characters). */
export const MEMORY_BODY_MAX = 2_000;
export const MEMORY_MAX_NOTES = 200;
/** Combined body cap across all notes (characters). */
export const MEMORY_TOTAL_MAX = 100_000;

export interface Memory {
  id: string;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** SHA-256 of the file bytes. */
  revision: string;
}

/** Failures callers map to API errors. */
export class MemoryError extends Error {
  override name = "MemoryError";
  readonly kind: "invalid" | "duplicate" | "not_found" | "conflict" | "limit";
  constructor(kind: MemoryError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Trimmed name, or a reason it is invalid (1–64 chars, no line breaks or controls). */
export function memoryNameProblem(raw: string): string | undefined {
  const name = raw.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > MEMORY_NAME_MAX) return "The name must be 1–64 characters";
  if (CONTROL.test(name)) return "The name must not contain line breaks or control characters";
  return undefined;
}

/** Uniqueness key: Unicode NFC, then case-folded. */
export function nameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase().normalize("NFC");
}

export function revisionOf(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function serializeMemory(memory: Omit<Memory, "revision">): string {
  const body = normalizeBody(memory.body);
  return [
    "---",
    "formatVersion: 1",
    `id: ${memory.id}`,
    `name: ${quote(memory.name)}`,
    `createdAt: ${quote(memory.createdAt)}`,
    `updatedAt: ${quote(memory.updatedAt)}`,
    "---",
    "",
    ...(body ? [body, ""] : []),
  ].join("\n");
}

/** Parses a memory file; null when it is not a valid version 1 memory. */
export function parseMemory(bytes: Buffer, expectedId: string): Memory | null {
  const text = bytes.toString("utf8");
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---\n", 3);
  if (close < 0) return null;
  const doc = parseDocument(text.slice(4, close + 1), { schema: "core", uniqueKeys: true });
  if (doc.errors.length > 0) return null;
  const contents = doc.contents;
  if (!contents || isScalar(contents) || isSeq(contents) || !("items" in contents)) return null;
  const items = contents.items as Pair[];
  const keys = items.map((pair) => (isScalar(pair.key) ? pair.key.value : undefined));
  const expected = ["formatVersion", "id", "name", "createdAt", "updatedAt"];
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) return null;
  const values = items.map((pair) => (isScalar(pair.value) ? pair.value.value : undefined));
  const [version, id, name, createdAt, updatedAt] = values;
  if (version !== 1 || id !== expectedId || typeof id !== "string" || !isCanonicalUuid(id))
    return null;
  if (typeof name !== "string" || memoryNameProblem(name) || name !== name.trim()) return null;
  if (typeof createdAt !== "string" || !isCanonicalTimestamp(createdAt)) return null;
  if (typeof updatedAt !== "string" || !isCanonicalTimestamp(updatedAt)) return null;
  const body = normalizeBody(text.slice(close + 5));
  return { id: expectedId, name, body, createdAt, updatedAt, revision: revisionOf(bytes) };
}

export interface MemoryWriteHooks {
  /** Test hook: runs after the memory file is written. */
  afterWrite?: () => Promise<void>;
}

export class MemoryStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly now: () => Date;

  constructor(paths: DataPaths, locks: KeyedLocks, now: () => Date = () => new Date()) {
    this.paths = paths;
    this.locks = locks;
    this.now = now;
  }

  /** Runs `fn` under the per-user memory-store lock (contracts §2 order: after proposals). */
  withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(lockKeys.memories(userId), fn);
  }

  /** Every valid memory, ordered by name then id; unreadable files are skipped. */
  async list(userId: string): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const file of await listDir(this.paths.memoriesDir(userId))) {
      const id = file.endsWith(".md") ? file.slice(0, -3) : "";
      if (!isCanonicalUuid(id)) continue;
      const memory = await this.get(userId, id);
      if (memory) out.push(memory);
    }
    return sortMemories(out);
  }

  async get(userId: string, id: string): Promise<Memory | null> {
    if (!isCanonicalUuid(id)) return null;
    const bytes = await readOrNull(this.paths.memoryFile(userId, id));
    return bytes ? parseMemory(bytes, id) : null;
  }

  /** Current revision of a memory file (any bytes), or null when absent. */
  async revision(userId: string, id: string): Promise<string | null> {
    const bytes = await readOrNull(this.paths.memoryFile(userId, id));
    return bytes ? revisionOf(bytes) : null;
  }

  private validate(name: string, body: string): { name: string; body: string } {
    const problem = memoryNameProblem(name);
    if (problem) throw new MemoryError("invalid", problem);
    const text = normalizeBody(body);
    if (text.length > MEMORY_BODY_MAX)
      throw new MemoryError("invalid", "A memory can be at most 2,000 characters");
    if (text.trim() === "") throw new MemoryError("invalid", "A memory must not be empty");
    return { name: name.trim(), body: text };
  }

  private checkLimits(all: Memory[], replacing: string | null, body: string): void {
    const others = all.filter((m) => m.id !== replacing);
    if (replacing === null && others.length >= MEMORY_MAX_NOTES)
      throw new MemoryError("limit", "You have reached the maximum number of memories");
    const total = others.reduce((sum, m) => sum + m.body.length, 0) + body.length;
    if (total > MEMORY_TOTAL_MAX)
      throw new MemoryError("limit", "Your memories are over the total size limit");
  }

  private async write(userId: string, memory: Omit<Memory, "revision">): Promise<Memory> {
    await ensureDir(this.paths.memoriesDir(userId));
    const bytes = serializeMemory(memory);
    await atomicWrite(this.paths.memoryFile(userId, memory.id), bytes);
    return { ...memory, body: normalizeBody(memory.body), revision: revisionOf(bytes) };
  }

  /** Creates a note. Unlocked variant for callers that already hold the lock. */
  async createUnlocked(
    userId: string,
    input: { name: string; body: string; id?: string },
  ): Promise<Memory> {
    const { name, body } = this.validate(input.name, input.body);
    const all = await this.list(userId);
    if (all.some((m) => nameKey(m.name) === nameKey(name)))
      throw new MemoryError("duplicate", "A memory with this name already exists");
    this.checkLimits(all, null, body);
    const now = this.now().toISOString();
    return this.write(userId, {
      id: input.id ?? randomUUID(),
      name,
      body,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Conditional update: `expectedRevision` must match the file (INV-38). */
  async updateUnlocked(
    userId: string,
    id: string,
    input: { name?: string; body?: string; expectedRevision: string },
  ): Promise<Memory> {
    const current = await this.get(userId, id);
    if (!current) throw new MemoryError("not_found", "Memory not found");
    if (current.revision !== input.expectedRevision)
      throw new MemoryError("conflict", "This memory changed; reload and try again");
    const { name, body } = this.validate(input.name ?? current.name, input.body ?? current.body);
    const all = await this.list(userId);
    if (all.some((m) => m.id !== id && nameKey(m.name) === nameKey(name)))
      throw new MemoryError("duplicate", "A memory with this name already exists");
    this.checkLimits(all, id, body);
    return this.write(userId, {
      ...current,
      name,
      body,
      updatedAt: this.now().toISOString(),
    });
  }

  /** Conditional delete: `expectedRevision` must match the file (INV-38). */
  async deleteUnlocked(userId: string, id: string, expectedRevision: string): Promise<void> {
    const revision = isCanonicalUuid(id) ? await this.revision(userId, id) : null;
    if (revision === null) throw new MemoryError("not_found", "Memory not found");
    if (revision !== expectedRevision)
      throw new MemoryError("conflict", "This memory changed; reload and try again");
    await durableUnlink(this.paths.memoryFile(userId, id));
  }

  /**
   * Validates a create without writing (proposal acceptance records the
   * exact bytes in its intent first). Caller holds the lock.
   */
  async prepareCreateUnlocked(
    userId: string,
    input: { name: string; body: string },
  ): Promise<{ memory: Omit<Memory, "revision">; bytes: string }> {
    const { name, body } = this.validate(input.name, input.body);
    const all = await this.list(userId);
    if (all.some((m) => nameKey(m.name) === nameKey(name)))
      throw new MemoryError("duplicate", "A memory with this name already exists");
    this.checkLimits(all, null, body);
    const now = this.now().toISOString();
    const memory = { id: randomUUID(), name, body, createdAt: now, updatedAt: now };
    return { memory, bytes: serializeMemory(memory) };
  }

  /** Validates an update of `current` without writing. Caller holds the lock. */
  async prepareUpdateUnlocked(
    userId: string,
    current: Memory,
    body: string,
  ): Promise<{ memory: Omit<Memory, "revision">; bytes: string }> {
    const valid = this.validate(current.name, body);
    this.checkLimits(await this.list(userId), current.id, valid.body);
    const memory = {
      id: current.id,
      name: current.name,
      body: valid.body,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    };
    return { memory, bytes: serializeMemory(memory) };
  }

  /** Writes prepared bytes (null deletes). Caller holds the lock. */
  async applyUnlocked(userId: string, id: string, bytes: string | null): Promise<void> {
    if (bytes === null) {
      await durableUnlink(this.paths.memoryFile(userId, id));
      return;
    }
    await ensureDir(this.paths.memoriesDir(userId));
    await atomicWrite(this.paths.memoryFile(userId, id), bytes);
  }

  create(userId: string, input: { name: string; body: string }): Promise<Memory> {
    return this.withLock(userId, () => this.createUnlocked(userId, input));
  }

  update(
    userId: string,
    id: string,
    input: { name?: string; body?: string; expectedRevision: string },
  ): Promise<Memory> {
    return this.withLock(userId, () => this.updateUnlocked(userId, id, input));
  }

  delete(userId: string, id: string, expectedRevision: string): Promise<void> {
    return this.withLock(userId, () => this.deleteUnlocked(userId, id, expectedRevision));
  }
}

export function sortMemories(memories: Memory[]): Memory[] {
  return memories.sort((a, b) =>
    a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
}

/** Characters the memory section may use in the prompt (contracts §12). */
export const MEMORY_PROMPT_BUDGET = 6_000;

export interface MemorySnapshot {
  /** Notes in the prompt, in prompt order. */
  included: Memory[];
  /** Notes left out by the budget (whole notes only). */
  omitted: Memory[];
}

/**
 * Whole notes in deterministic order (name, then id) until the budget is
 * reached; a note is never truncated (contracts §12).
 */
export function memorySnapshot(memories: Memory[], budget = MEMORY_PROMPT_BUDGET): MemorySnapshot {
  const included: Memory[] = [];
  const omitted: Memory[] = [];
  let used = 0;
  for (const memory of sortMemories([...memories])) {
    const cost = memory.name.length + memory.body.length + 8;
    if (used + cost <= budget) {
      included.push(memory);
      used += cost;
    } else {
      omitted.push(memory);
    }
  }
  return { included, omitted };
}

/** The system-prompt section for approved memories (plain text, never a template). */
export function memoryPrompt(included: readonly Memory[]): string | null {
  if (included.length === 0) return null;
  const notes = included.map((m) => `### ${m.name}\n${m.body}`).join("\n\n");
  return `Saved memories about the user. The user approved each one; treat them as facts the user told you earlier.\n\n${notes}`;
}

// Temporary chats (Phase 13f): a per-user registry, `temporary.json`, of
// conversations kept out of the sidebar, search, the Library, exports and
// memory, and deleted when the user leaves them (or after a day). The chats
// themselves are ordinary canonical Markdown. Loadable natively by Node.
import { atomicWrite, readOrNull } from "./fs.ts";
import type { KeyedLocks } from "./locks.ts";
import { isUuid, type DataPaths } from "./paths.ts";
import path from "node:path";

/** A temporary chat left open (a closed tab, a crash) is removed after this long. */
export const TEMPORARY_TTL_MS = 24 * 3_600_000;

export class TemporaryChats {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly now: () => Date;
  /** userId → (conversationId → createdAt ms), loaded at startup and kept in step. */
  private readonly cache = new Map<string, Map<string, number>>();

  constructor(paths: DataPaths, locks: KeyedLocks, now: () => Date = () => new Date()) {
    this.paths = paths;
    this.locks = locks;
    this.now = now;
  }

  private file(userId: string): string {
    return path.join(this.paths.userDir(userId), "temporary.json");
  }

  async load(userId: string): Promise<void> {
    const bytes = await readOrNull(this.file(userId));
    const map = new Map<string, number>();
    try {
      const parsed = bytes ? (JSON.parse(bytes.toString("utf8")) as { chats?: unknown }) : {};
      if (parsed.chats && typeof parsed.chats === "object")
        for (const [id, at] of Object.entries(parsed.chats))
          if (isUuid(id) && typeof at === "number") map.set(id, at);
    } catch {
      // An unreadable registry lists nothing: the chats show up normally.
    }
    this.cache.set(userId, map);
  }

  /** Whether a conversation is temporary (synchronous: the registry is loaded at startup). */
  has(userId: string, conversationId: string): boolean {
    return this.cache.get(userId)?.has(conversationId) ?? false;
  }

  ids(userId: string): ReadonlySet<string> {
    return new Set(this.cache.get(userId)?.keys() ?? []);
  }

  private async write(userId: string, map: Map<string, number>): Promise<void> {
    await atomicWrite(
      this.file(userId),
      `${JSON.stringify({ version: 1, chats: Object.fromEntries(map) })}\n`,
    );
    this.cache.set(userId, map);
  }

  /** Registers a chat before its first write, so it never appears anywhere. */
  add(userId: string, conversationId: string): Promise<void> {
    return this.locks.run(`temporary:${userId}`, async () => {
      if (!this.cache.has(userId)) await this.load(userId);
      const map = new Map(this.cache.get(userId));
      map.set(conversationId, this.now().getTime());
      await this.write(userId, map);
    });
  }

  remove(userId: string, conversationId: string): Promise<void> {
    return this.locks.run(`temporary:${userId}`, async () => {
      if (!this.cache.has(userId)) await this.load(userId);
      const map = new Map(this.cache.get(userId));
      if (!map.delete(conversationId)) return;
      await this.write(userId, map);
    });
  }

  /** Temporary chats older than the TTL (for the sweep). */
  expired(userId: string, ttlMs = TEMPORARY_TTL_MS): string[] {
    const cutoff = this.now().getTime() - ttlMs;
    return [...(this.cache.get(userId) ?? new Map<string, number>())]
      .filter(([, at]) => at < cutoff)
      .map(([id]) => id);
  }

  forgetUser(userId: string): void {
    this.cache.delete(userId);
  }
}

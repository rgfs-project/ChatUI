// In-process keyed locks (contracts §2). Loadable natively by Node.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-user export barrier (contracts §2, §12): canonical mutations hold
 * it shared, the export snapshot exclusive. It comes first in the lock order,
 * so it is taken by the outermost user-scoped lock of an operation and is
 * re-entrant for everything nested inside it.
 */
class ExportBarrier {
  private readonly shared = new Map<string, number>();
  private readonly exclusive = new Map<string, Promise<void>>();
  private readonly drained = new Map<string, () => void>();
  /** The users whose barrier this async context holds (shared or exclusive). */
  private readonly held = new AsyncLocalStorage<{ users: Set<string>; open: boolean }>();

  private holds(userId: string): boolean {
    const context = this.held.getStore();
    return context?.open === true && context.users.has(userId);
  }

  async withShared<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    if (this.holds(userId)) return fn();
    // Wait out an exclusive holder (writer first: no new shared holder jumps it).
    for (let gate = this.exclusive.get(userId); gate; gate = this.exclusive.get(userId)) await gate;
    this.shared.set(userId, (this.shared.get(userId) ?? 0) + 1);
    const parent = this.held.getStore();
    const context = { users: new Set([...(parent?.open ? parent.users : []), userId]), open: true };
    try {
      return await this.held.run(context, fn);
    } finally {
      context.open = false;
      const left = (this.shared.get(userId) ?? 1) - 1;
      if (left === 0) {
        this.shared.delete(userId);
        this.drained.get(userId)?.();
      } else this.shared.set(userId, left);
    }
  }

  /** Runs `fn` with no canonical mutation of `userId` in progress. Keep it short. */
  async withExclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    for (let gate = this.exclusive.get(userId); gate; gate = this.exclusive.get(userId)) await gate;
    let release!: () => void;
    this.exclusive.set(
      userId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      if ((this.shared.get(userId) ?? 0) > 0)
        await new Promise<void>((resolve) => {
          this.drained.set(userId, resolve);
        });
      this.drained.delete(userId);
      const context = { users: new Set([userId]), open: true };
      try {
        return await this.held.run(context, fn);
      } finally {
        context.open = false;
      }
    } finally {
      this.exclusive.delete(userId);
      release();
    }
  }

  /** Whether an exclusive holder is active (tests). */
  isExclusive(userId: string): boolean {
    return this.exclusive.has(userId);
  }
}

/** User-scoped canonical lock keys: `<kind>:<user-uuid>` or `<kind>:<user-uuid>/<id>`. */
const USER_KEY =
  /^(?:conversation|memories|preferences|proposals|artifact|attachment|operations|profile|import):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/;

/**
 * FIFO mutex per key. `run` holds the key's lock for the duration of `fn`.
 * `held` counts locks currently held, so tests can assert that no network I/O
 * happens while any lock is held.
 */
export class KeyedLocks {
  private readonly tails = new Map<string, Promise<void>>();
  private heldCount = 0;
  readonly barrier = new ExportBarrier();

  get held(): number {
    return this.heldCount;
  }

  isHeld(key: string): boolean {
    return this.tails.has(key);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const userId = USER_KEY.exec(key)?.[1];
    return userId
      ? this.barrier.withShared(userId, () => this.runKey(key, fn))
      : this.runKey(key, fn);
  }

  private async runKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    this.heldCount++;
    try {
      return await fn();
    } finally {
      this.heldCount--;
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export const lockKeys = {
  conversation: (userId: string, conversationId: string) =>
    `conversation:${userId}/${conversationId}`,
  operations: (userId: string) => `operations:${userId}`,
  memories: (userId: string) => `memories:${userId}`,
  proposals: (userId: string, conversationId: string) => `proposals:${userId}/${conversationId}`,
};

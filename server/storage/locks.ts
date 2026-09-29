// In-process keyed locks (contracts §2). Loadable natively by Node.

/**
 * FIFO mutex per key. `run` holds the key's lock for the duration of `fn`.
 * `held` counts locks currently held, so tests can assert that no network I/O
 * happens while any lock is held.
 */
export class KeyedLocks {
  private readonly tails = new Map<string, Promise<void>>();
  private heldCount = 0;

  get held(): number {
    return this.heldCount;
  }

  isHeld(key: string): boolean {
    return this.tails.has(key);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
};

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

/**
 * Per-user shared/exclusive barrier (contracts §6 account closure, INV-61).
 * Every writer into a user's directory holds it shared for the duration of
 * the write; account closure takes it exclusively to rename the directory
 * away. Exclusive requests are queued fairly: once one is waiting, new shared
 * holders wait behind it, so closure cannot be starved.
 */
export class UserBarrier {
  private readonly state = new Map<
    string,
    { shared: number; exclusive: boolean; queue: { exclusive: boolean; wake: () => void }[] }
  >();

  private entry(userId: string) {
    let s = this.state.get(userId);
    if (!s) {
      s = { shared: 0, exclusive: false, queue: [] };
      this.state.set(userId, s);
    }
    return s;
  }

  private pump(userId: string): void {
    const s = this.state.get(userId);
    if (!s) return;
    while (s.queue.length > 0 && !s.exclusive) {
      const next = s.queue[0];
      if (!next) break;
      if (next.exclusive) {
        if (s.shared > 0) break;
        s.queue.shift();
        s.exclusive = true;
        next.wake();
        break;
      }
      s.queue.shift();
      s.shared++;
      next.wake();
    }
    if (s.shared === 0 && !s.exclusive && s.queue.length === 0) this.state.delete(userId);
  }

  private acquire(userId: string, exclusive: boolean): Promise<void> {
    const s = this.entry(userId);
    const free = exclusive
      ? s.shared === 0 && !s.exclusive && s.queue.length === 0
      : !s.exclusive && s.queue.length === 0;
    if (free) {
      if (exclusive) s.exclusive = true;
      else s.shared++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      s.queue.push({ exclusive, wake: resolve });
    });
  }

  private release(userId: string, exclusive: boolean): void {
    const s = this.entry(userId);
    if (exclusive) s.exclusive = false;
    else s.shared--;
    this.pump(userId);
  }

  async shared<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(userId, false);
    try {
      return await fn();
    } finally {
      this.release(userId, false);
    }
  }

  async exclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(userId, true);
    try {
      return await fn();
    } finally {
      this.release(userId, true);
    }
  }

  /** Test/diagnostic: shared holders currently inside. */
  sharedHolders(userId: string): number {
    return this.state.get(userId)?.shared ?? 0;
  }
}

// Argon2id password hashing with bounded concurrency (contracts §6, INV-62).
import argon2 from "argon2";

/** OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1). */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export class HashQueueFullError extends Error {
  override name = "HashQueueFullError";
}

/**
 * A small semaphore with a bounded wait queue: login floods cannot starve a
 * host whose CPU and memory also run local models. A full queue is rejected.
 */
export class PasswordHasher {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly queueLimit: number;
  private readonly options: typeof ARGON2_OPTIONS | Record<string, number>;
  /** A valid hash to verify against for unknown users (uniform timing). */
  private dummy: Promise<string> | undefined;

  constructor(options: {
    concurrency: number;
    queue: number;
    argon2?: Partial<{ memoryCost: number; timeCost: number; parallelism: number }>;
  }) {
    this.concurrency = options.concurrency;
    this.queueLimit = options.queue;
    this.options = { ...ARGON2_OPTIONS, ...options.argon2 };
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Runs `fn` in a hashing slot (bounded concurrency and queue). */
  protected async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.queueLimit)
        throw new HashQueueFullError("password hashing queue is full");
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  hash(password: string): Promise<string> {
    return this.slot(() => argon2.hash(password, this.options as typeof ARGON2_OPTIONS));
  }

  /** Verifies; with `hash` undefined, verifies against a dummy to keep timing uniform. */
  verify(hash: string | undefined, password: string): Promise<boolean> {
    return this.slot(async () => {
      if (hash === undefined) {
        this.dummy ??= argon2.hash(
          "dummy-password-for-timing",
          this.options as typeof ARGON2_OPTIONS,
        );
        await argon2.verify(await this.dummy, password).catch(() => false);
        return false;
      }
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    });
  }
}

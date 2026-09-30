/**
 * In-process fixed-window limiter: login and registration (contracts §6) and
 * the per-user request budgets below (Phase 16).
 * Keys are client addresses and usernames; memory is bounded by pruning.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { limit: number; windowMs: number; now?: () => number }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /** Records a hit; returns seconds to wait when over the limit, else 0. */
  hit(key: string): number {
    const now = this.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    entry.count++;
    return entry.count > this.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

/** Per-user request budgets (Phase 16): requests per minute per bucket. */
export interface RateLimitConfig {
  /** Generation starts: sends and regenerations. */
  generationsPerMinute: number;
  /** Uploads: attachments and import archives. */
  uploadsPerMinute: number;
  /** Administrative mutations. */
  adminPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  generationsPerMinute: 30,
  uploadsPerMinute: 60,
  adminPerMinute: 120,
};

export type RateBucket = "generation" | "upload" | "admin";

/**
 * In-process request limits per user and bucket (contracts §5: RATE_LIMITED
 * with Retry-After). Limits are per process, like every ChatUI limit: the
 * single-process deployment is the supported one.
 */
export class RequestLimits {
  private readonly limiters: Record<RateBucket, RateLimiter>;

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMITS, now?: () => number) {
    const minute = (limit: number) =>
      new RateLimiter({ limit, windowMs: 60_000, ...(now ? { now } : {}) });
    this.limiters = {
      generation: minute(config.generationsPerMinute),
      upload: minute(config.uploadsPerMinute),
      admin: minute(config.adminPerMinute),
    };
  }

  /** Records a request; seconds to wait when over budget, else 0. */
  hit(bucket: RateBucket, userId: string): number {
    return this.limiters[bucket].hit(userId);
  }
}

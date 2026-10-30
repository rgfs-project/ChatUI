import { ErrorCode } from "@shared/errors";
import type { RateCategory } from "../config.ts";
import { AppError } from "../errors.ts";
import { RateLimiter } from "./rate-limit.ts";

const WINDOW_MS = 60_000;

/**
 * Per-account request rates for expensive or privileged routes (Phase 16).
 * Each registry route may declare a category; the guard takes one hit after
 * authentication and CSRF pass, so rejected requests cost the account
 * nothing. Counters live in this process only (no distributed limiting).
 */
export class RouteLimits {
  private readonly limiters: Record<RateCategory, RateLimiter>;

  constructor(perMinute: Record<RateCategory, number>, now: () => number = Date.now) {
    const make = (limit: number) => new RateLimiter({ limit, windowMs: WINDOW_MS, now });
    this.limiters = {
      generation: make(perMinute.generation),
      upload: make(perMinute.upload),
      admin: make(perMinute.admin),
    };
  }

  /** Counts one request; throws RATE_LIMITED with Retry-After when over the rate. */
  take(category: RateCategory, userId: string): void {
    const wait = this.limiters[category].hit(userId);
    if (wait > 0)
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        "Too many requests; try again shortly",
        undefined,
        {
          "Retry-After": String(wait),
        },
      );
  }
}

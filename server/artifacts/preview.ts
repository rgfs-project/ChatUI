import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export { isPreviewable, PREVIEW_MAX_BYTES } from "@shared/preview";

/** How long a preview link stays valid (docs/threat-model-19.md). */
export const PREVIEW_TOKEN_TTL_MS = 60_000;

interface Payload {
  /** Owner, file, expiry (ms since epoch), nonce. */
  u: string;
  a: string;
  e: number;
  n: string;
}

/**
 * Single-use capability links for previews (Phase 19, INV-51). A token is
 * minted by an authenticated, CSRF-checked request and names exactly one
 * user's file for 60 s; the preview document is loaded with the token alone,
 * so the sandboxed frame never needs (or sends) the session. The key lives
 * only in this process: a restart invalidates every outstanding token.
 */
export class PreviewTokens {
  private readonly key = randomBytes(32);
  private readonly used = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  mint(userId: string, artifactId: string): { token: string; expiresAt: string } {
    const payload: Payload = {
      u: userId,
      a: artifactId,
      e: this.now() + PREVIEW_TOKEN_TTL_MS,
      n: randomBytes(12).toString("base64url"),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return { token: `${body}.${this.sign(body)}`, expiresAt: new Date(payload.e).toISOString() };
  }

  /** The owner and file of a valid, unexpired, unused token; consumes it. */
  redeem(token: string): { userId: string; artifactId: string } | null {
    const now = this.now();
    for (const [nonce, expiry] of this.used) if (expiry <= now) this.used.delete(nonce);
    const [body, signature, ...rest] = token.split(".");
    if (!body || !signature || rest.length > 0 || token.length > 1_024) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    } catch {
      return null;
    }
    if (typeof payload.e !== "number" || payload.e <= now || typeof payload.n !== "string")
      return null;
    if (this.used.has(payload.n)) return null;
    this.used.set(payload.n, payload.e);
    return { userId: payload.u, artifactId: payload.a };
  }
}

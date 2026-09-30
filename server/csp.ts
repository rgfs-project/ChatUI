import { randomBytes } from "node:crypto";
import type { RequestHandler, Response } from "express";
import helmet from "helmet";

/** 128-bit random nonce, fresh for every response (contracts §9.2b). */
export function createNonce(): string {
  return randomBytes(16).toString("base64");
}

export function getNonce(res: Response): string {
  const nonce: unknown = res.locals.cspNonce;
  if (typeof nonce !== "string") throw new Error("CSP nonce middleware did not run");
  return nonce;
}

export type CspMode = "production" | "development";

type Directive = string | ((req: unknown, res: unknown) => string);

/**
 * Production policy: scripts only from our origin or carrying this response's
 * nonce; no unsafe-inline/unsafe-eval anywhere. Development additionally allows
 * Vite's HMR websocket and injected <style> tags.
 */
export function cspDirectives(mode: CspMode): Record<string, Directive[]> {
  const nonce: Directive = (_req, res) => `'nonce-${getNonce(res as Response)}'`;
  const directives: Record<string, Directive[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", nonce],
    "script-src-attr": ["'none'"],
    // Nonce'd <style> elements only (Radix scroll lock); no unsafe-inline.
    "style-src": ["'self'", nonce],
    // blob: only for local previews of files being attached (object URLs the
    // page itself created); attachment bytes come from 'self'.
    "img-src": ["'self'", "blob:"],
    "media-src": ["'self'", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'none'"],
    "object-src": ["'none'"],
    "frame-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  if (mode === "development") {
    directives["style-src"] = ["'self'", "'unsafe-inline'"];
    directives["connect-src"] = ["'self'", "ws://localhost:*", "ws://127.0.0.1:*"];
  }
  return directives;
}

/**
 * Powerful browser features ChatUI never uses are disabled for the page and
 * anything it could embed (Phase 16). Clipboard writes (copy buttons) keep
 * their default same-origin permission.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

export function securityHeaders(mode: CspMode): RequestHandler[] {
  const assignNonce: RequestHandler = (_req, res, next) => {
    res.locals.cspNonce = createNonce();
    next();
  };
  const permissions: RequestHandler = (_req, res, next) => {
    res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
    next();
  };
  return [
    assignNonce,
    permissions,
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: cspDirectives(mode) },
      // HSTS belongs to the TLS-terminating proxy deployment introduced with auth (Phase 4).
      strictTransportSecurity: false,
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  ];
}

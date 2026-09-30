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
    "img-src": ["'self'"],
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

export function securityHeaders(mode: CspMode): RequestHandler[] {
  const assignNonce: RequestHandler = (_req, res, next) => {
    res.locals.cspNonce = createNonce();
    next();
  };
  return [
    assignNonce,
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: cspDirectives(mode) },
      // HSTS belongs to the TLS-terminating proxy deployment introduced with auth (Phase 4).
      strictTransportSecurity: false,
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  ];
}

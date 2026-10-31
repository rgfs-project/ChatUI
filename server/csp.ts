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
export function cspDirectives(
  mode: CspMode,
  previewOrigin: string | null = null,
): Record<string, Directive[]> {
  const nonce: Directive = (_req, res) => `'nonce-${getNonce(res as Response)}'`;
  const directives: Record<string, Directive[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", nonce],
    "script-src-attr": ["'none'"],
    // The nonce admits only the scroll-lock <style> element that modal dialogs
    // insert (react-remove-scroll); style attributes stay blocked.
    "style-src": ["'self'", nonce],
    "style-src-attr": ["'none'"],
    // blob: previews of images chosen for upload, before they reach the server (Phase 12).
    "img-src": ["'self'", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'none'"],
    "object-src": ["'none'"],
    // Only sandboxed file previews (Phase 19): this origin or the preview origin.
    "frame-src": ["'self'", ...(previewOrigin ? [previewOrigin] : [])],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  if (mode === "development") {
    directives["style-src"] = ["'self'", "'unsafe-inline'"];
    directives["style-src-attr"] = ["'unsafe-inline'"];
    directives["connect-src"] = ["'self'", "ws://localhost:*", "ws://127.0.0.1:*"];
  }
  return directives;
}

/**
 * Powerful features the app may use (Phase 16): the microphone for dictation
 * (the browser asks first), clipboard writes for Copy, full screen. Everything
 * else is off for this page and anything it could ever embed. Only features
 * Chromium recognises are listed, since unknown names log console warnings.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "clipboard-write=(self)",
  "display-capture=()",
  "fullscreen=(self)",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=(self)",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

export function securityHeaders(
  mode: CspMode,
  previewOrigin: string | null = null,
): RequestHandler[] {
  const assignNonce: RequestHandler = (_req, res, next) => {
    res.locals.cspNonce = createNonce();
    res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
    next();
  };
  return [
    assignNonce,
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: cspDirectives(mode, previewOrigin) },
      // HSTS belongs to the TLS-terminating proxy deployment introduced with auth (Phase 4).
      strictTransportSecurity: false,
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  ];
}

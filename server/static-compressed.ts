import { readdirSync } from "node:fs";
import path from "node:path";
import type { RequestHandler } from "express";

const ENCODINGS = [
  { name: "br", ext: ".br" },
  { name: "gzip", ext: ".gz" },
] as const;

/** Accept-Encoding parsing that honours `;q=0` (never serve a refused coding). */
export function acceptedEncodings(header: string | undefined): Set<string> {
  const accepted = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [coding = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (coding && (!q || Number(q.slice(2)) > 0)) accepted.add(coding);
  }
  return accepted;
}

/**
 * Serves build-time precompressed variants (`.br`, `.gz`) of hashed assets.
 * The set of variants is read once at startup, so requests never probe the
 * filesystem. Responses keep the original type, carry `Vary: Accept-Encoding`
 * and the same immutable caching as the plain file; anything without a
 * variant (or a client that accepts none) falls through to express.static.
 */
export function precompressedAssets(dir: string): RequestHandler {
  let files: Set<string>;
  try {
    files = new Set(readdirSync(dir));
  } catch {
    files = new Set();
  }
  return (req, res, next) => {
    res.vary("Accept-Encoding");
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    const name = req.path.slice(1);
    // Hashed assets live flat in one directory: anything else is not ours.
    if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      next();
      return;
    }
    const accepted = acceptedEncodings(req.headers["accept-encoding"]);
    const variant = ENCODINGS.find((e) => accepted.has(e.name) && files.has(name + e.ext));
    if (!variant) {
      next();
      return;
    }
    res.type(path.extname(name));
    res.setHeader("Content-Encoding", variant.name);
    res.sendFile(path.join(dir, name + variant.ext), {
      maxAge: "1y",
      immutable: true,
      dotfiles: "deny",
    });
  };
}

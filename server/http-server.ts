// Loaded natively by Node from server/main.ts (explicit .ts imports, no aliases).
import { createServer, type RequestListener, type Server } from "node:http";

/** Request headers above this are refused with 431 before any handler runs. */
export const MAX_HEADER_BYTES = 16 * 1024;
/** A client must finish sending its headers within this (slow-header clients). */
export const HEADERS_TIMEOUT_MS = 30_000;

/**
 * The HTTP server with explicit limits (Phase 16, INV-62): header size, the
 * time to send headers and the whole request (uploads included), and open
 * connections. Responses such as SSE streams are not bounded by these; their
 * own caps live in the generation and stream services.
 */
export function createHttpServer(
  handler: RequestListener,
  limits: { maxConnections: number; requestTimeoutMs: number },
): Server {
  const server = createServer(
    {
      maxHeaderSize: MAX_HEADER_BYTES,
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: limits.requestTimeoutMs,
    },
    handler,
  );
  server.maxConnections = limits.maxConnections;
  return server;
}

/**
 * Connection limits (Phase 16, INV-62). Headers are capped at 16 KiB and
 * must arrive within 30 s (slow-header clients are cut off). A request body
 * must finish within 30 minutes, the longest a maximum-size import upload
 * can reasonably take; SSE responses are not bounded by this. Idle
 * keep-alive sockets close after 5 s.
 */
export const HTTP_SERVER_LIMITS = {
  maxHeaderSize: 16 * 1024,
  headersTimeout: 30_000,
  requestTimeout: 30 * 60_000,
  keepAliveTimeout: 5_000,
} as const;

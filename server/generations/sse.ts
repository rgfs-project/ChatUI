import type { Request, Response } from "express";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import type { GenerationEvent } from "@shared/generations";
import type { Logger } from "../logger.ts";
import type { GenerationObserver } from "./manager.ts";

export interface SseOptions {
  /** Comment heartbeat interval; contracts §5 requires at least every 15 s. */
  heartbeatMs: number;
  /** Bytes buffered for a backpressured client before it is disconnected. */
  maxQueuedBytes: number;
}

export const DEFAULT_SSE_OPTIONS: SseOptions = { heartbeatMs: 15_000, maxQueuedBytes: 1024 * 1024 };

export function formatEvent(event: GenerationEvent): string {
  return `id: ${String(event.id)}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Opens an SSE response (contracts §5) and returns an observer that writes to
 * it without ever blocking the producer: when the socket is backpressured,
 * events queue up to `maxQueuedBytes`; beyond that the observer is too slow
 * and is disconnected (INV-62). It can reconnect and resync from a snapshot.
 */
export function openSse(
  req: Request,
  res: Response,
  options: SseOptions,
  logger: Logger,
  onDisconnect: () => void,
  /** Re-checked at every heartbeat; a false result ends the stream (contracts §5). */
  validate?: () => Promise<boolean>,
): GenerationObserver & { terminate: () => void } {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  req.socket.setNoDelay(true);

  const queue: string[] = [];
  let queuedBytes = 0;
  let backpressured = false;
  let closing = false;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    onDisconnect();
  };

  const write = (chunk: string) => {
    if (finished) return;
    if (backpressured) {
      queue.push(chunk);
      queuedBytes += Buffer.byteLength(chunk);
      if (queuedBytes > options.maxQueuedBytes) {
        logger.warn("disconnecting slow SSE observer");
        queue.length = 0;
        queuedBytes = 0;
        cleanup();
        res.destroy();
      }
      return;
    }
    if (!res.write(chunk)) backpressured = true;
  };

  res.on("drain", () => {
    backpressured = false;
    while (queue.length > 0 && !backpressured) {
      const chunk = queue.shift();
      if (chunk === undefined) break;
      queuedBytes -= Buffer.byteLength(chunk);
      if (!res.write(chunk)) backpressured = true;
    }
    if (closing && queue.length === 0 && !backpressured) {
      cleanup();
      res.end();
    }
  });

  const terminate = () => {
    if (finished) return;
    queue.length = 0;
    cleanup();
    res.end();
  };

  const heartbeat = setInterval(() => {
    if (!validate) {
      if (!backpressured) write(": ping\n\n");
      return;
    }
    void validate().then(
      (ok) => {
        if (!ok) terminate();
        else if (!backpressured) write(": ping\n\n");
      },
      () => {
        terminate();
      },
    );
  }, options.heartbeatMs);
  heartbeat.unref();

  // Client went away: stop observing. The generation itself continues (INV-06).
  res.on("close", cleanup);

  return {
    terminate,
    send: (event) => {
      write(formatEvent(event));
    },
    close: () => {
      if (finished || closing) return;
      closing = true;
      if (!backpressured && queue.length === 0) {
        cleanup();
        res.end();
      }
    },
  };
}

/**
 * Open SSE connections by user and session: enforces the per-user and global
 * caps (INV-62) and closes a session's streams when it is revoked.
 */
export class SseConnections {
  private readonly open = new Map<
    symbol,
    { userId: string; tokenHash: string; close: () => void }
  >();
  private readonly maxPerUser: number;
  private readonly maxTotal: number;

  constructor(options: { maxPerUser: number; maxTotal: number }) {
    this.maxPerUser = options.maxPerUser;
    this.maxTotal = options.maxTotal;
  }

  get size(): number {
    return this.open.size;
  }

  /** Throws RATE_LIMITED before any stream bytes when a cap is reached. */
  assertCapacity(userId: string): void {
    const mine = [...this.open.values()].filter((c) => c.userId === userId).length;
    if (this.open.size >= this.maxTotal || mine >= this.maxPerUser) {
      throw new AppError(ErrorCode.RATE_LIMITED, "Too many open streams", undefined, {
        "Retry-After": "5",
      });
    }
  }

  add(userId: string, tokenHash: string, close: () => void): () => void {
    const key = Symbol("sse");
    this.open.set(key, { userId, tokenHash, close });
    return () => this.open.delete(key);
  }

  closeSession(tokenHash: string): void {
    for (const [key, conn] of this.open) {
      if (conn.tokenHash === tokenHash) {
        this.open.delete(key);
        conn.close();
      }
    }
  }
}

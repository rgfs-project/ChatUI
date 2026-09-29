import type { Request, Response } from "express";
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
): GenerationObserver {
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

  const heartbeat = setInterval(() => {
    if (!backpressured) write(": ping\n\n");
  }, options.heartbeatMs);
  heartbeat.unref();

  // Client went away: stop observing. The generation itself continues (INV-06).
  res.on("close", cleanup);

  return {
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

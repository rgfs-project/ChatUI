import { Writable } from "node:stream";
import type { RequestHandler } from "express";
import { createApp, type AppOptions } from "../../server/create-app.ts";
import { createLogger, type Logger } from "../../server/logger.ts";

export interface LogCapture {
  logger: Logger;
  lines: () => Record<string, unknown>[];
}

export function captureLogger(): LogCapture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return {
    logger: createLogger("info", stream),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Stand-in document handler: marks responses so tests can see what reached it. */
export const stubDocumentHandler: RequestHandler = (_req, res) => {
  res.status(200).type("text/html").send("<!doctype html><p>document</p>");
};

export function testApp(overrides: Partial<AppOptions> = {}) {
  const logs = captureLogger();
  const app = createApp({
    config: { nodeEnv: "test" },
    logger: logs.logger,
    version: "9.9.9-test",
    createDocumentHandler: () => stubDocumentHandler,
    ...overrides,
  });
  return { app, logs };
}

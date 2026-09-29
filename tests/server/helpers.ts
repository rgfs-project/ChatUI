import { Writable } from "node:stream";
import type { RequestHandler } from "express";
import { createApp, type AppOptions } from "../../server/create-app.ts";
import type { ProviderConfig } from "../../server/config.ts";
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

export function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    baseUrl: undefined,
    apiKey: undefined,
    timeoutMs: 5_000,
    generationMaxMs: 30_000,
    defaultContextTokens: 8_192,
    maxOutputTokens: 256,
    maxActiveGenerations: 4,
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  };
}

export interface TestAppOptions extends Partial<Omit<AppOptions, "config">> {
  config?: Partial<AppOptions["config"]>;
}

export function testApp(overrides: TestAppOptions = {}) {
  const logs = captureLogger();
  const { config, ...rest } = overrides;
  const chatui = createApp({
    logger: logs.logger,
    version: "9.9.9-test",
    createDocumentHandler: () => stubDocumentHandler,
    ...rest,
    config: { nodeEnv: "test", inContainer: false, provider: providerConfig(), ...config },
  });
  return { app: chatui.handler, chatui, logs };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { RequestHandler } from "express";
import { createApp, type AppOptions } from "../../server/create-app.ts";
import type { ProviderConfig, StorageConfig } from "../../server/config.ts";
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

export const LOCAL_USER = "5f0c6a3e-9d0b-4c1e-8f2a-3b6d7e8f9a01";

export function storageConfig(overrides: Partial<StorageConfig> = {}): StorageConfig {
  return {
    localUserId: LOCAL_USER,
    operationRetentionMs: 7 * 86_400_000,
    contextTrimStep: undefined,
    templateOverheadTokens: 16,
    ...overrides,
  };
}

const tempDirs: string[] = [];
process.on("exit", () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh DATA_DIR removed when the test process exits. */
export function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chatui-data-"));
  tempDirs.push(dir);
  return dir;
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
    config: {
      nodeEnv: "test",
      inContainer: false,
      provider: providerConfig(),
      storage: storageConfig(),
      dataDir: config?.dataDir ?? tempDataDir(),
      ...config,
    },
  });
  return { app: chatui.handler, chatui, logs };
}

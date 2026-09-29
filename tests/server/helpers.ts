import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { RequestHandler } from "express";
import { createApp, type AppOptions } from "../../server/create-app.ts";
import { PasswordHasher } from "../../server/auth/passwords.ts";
import type { AuthConfig, ProviderConfig, StorageConfig } from "../../server/config.ts";
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

export function storageConfig(overrides: Partial<StorageConfig> = {}): StorageConfig {
  return {
    operationRetentionMs: 7 * 86_400_000,
    contextTrimStep: undefined,
    templateOverheadTokens: 16,
    ...overrides,
  };
}

export const TEST_ORIGIN = "http://localhost:3000";

export function authConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    publicOrigin: TEST_ORIGIN,
    secureCookies: false,
    trustProxy: 0,
    registrationMode: "closed",
    sessionAbsoluteTtlMs: 30 * 86_400_000,
    sessionIdleTtlMs: 7 * 86_400_000,
    maxActiveGenerationsPerUser: 4,
    maxSsePerUser: 8,
    maxSseTotal: 256,
    hashConcurrency: 4,
    hashQueue: 16,
    ...overrides,
  };
}

/** Cheap Argon2id parameters so tests stay fast (production uses OWASP values). */
export function testHasher(options: { concurrency?: number; queue?: number } = {}): PasswordHasher {
  return new PasswordHasher({
    concurrency: options.concurrency ?? 4,
    queue: options.queue ?? 16,
    argon2: { memoryCost: 1024, timeCost: 1 },
  });
}

export const TEST_PASSWORD = "correct horse battery staple";

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
    hasher: testHasher(),
    ...rest,
    config: {
      nodeEnv: "test",
      inContainer: false,
      provider: providerConfig(),
      storage: storageConfig(),
      auth: authConfig(),
      dataDir: config?.dataDir ?? tempDataDir(),
      ...config,
    },
  });
  return { app: chatui.handler, chatui, logs };
}

export interface TestSession {
  userId: string;
  username: string;
  cookie: string;
  csrfToken: string;
  /** Headers for a signed-in request; mutations add CSRF and expected user. */
  headers: (mutation?: boolean) => Record<string, string>;
}

/** Creates the account if needed, then signs in over real HTTP. */
export async function signIn(
  base: string,
  chatui: {
    services: {
      users: {
        create: (i: {
          username: string;
          passwordHash: string;
          role: "user" | "admin";
        }) => Promise<unknown>;
      };
    };
  },
  username = "alice",
  role: "user" | "admin" = "user",
): Promise<TestSession> {
  const hash = await testHasher().hash(TEST_PASSWORD);
  await chatui.services.users.create({ username, passwordHash: hash, role }).catch(() => undefined);
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: TEST_ORIGIN },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  if (res.status !== 200)
    throw new Error(`login failed: ${String(res.status)} ${await res.text()}`);
  const body = (await res.json()) as { user: { id: string }; csrfToken: string };
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return {
    userId: body.user.id,
    username,
    cookie,
    csrfToken: body.csrfToken,
    headers: (mutation = false) => ({
      Cookie: cookie,
      ...(mutation ? { "X-CSRF-Token": body.csrfToken, "X-Expected-User": body.user.id } : {}),
    }),
  };
}

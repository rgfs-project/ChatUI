// Loaded natively by Node (type stripping) from server/main.ts, so relative
// imports carry explicit .ts extensions and no path aliases are used.
import { statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { isLoopbackAddress } from "./loopback.ts";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

function intFrom(min: number, max: number) {
  return z.string().transform((value, ctx) => {
    const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: "custom", message: `must be an integer between ${min} and ${max}` });
      return z.NEVER;
    }
    return n;
  });
}

const envSchema = z.object({
  PORT: intFrom(0, 65_535).default(3_000),
  DATA_DIR: z.string().min(1, "must not be empty").default("./data"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  LISTEN_HOST: z
    .string()
    .default("127.0.0.1")
    .refine((value) => isIP(value) !== 0, "must be an IP address"),
  // Set only by the container image (Dockerfile). Not a user-facing option.
  CHATUI_CONTAINER: z.enum(["0", "1"]).default("0"),

  // llama.cpp provider (Phase 2).
  LLAMA_BASE_URL: z
    .url({ protocol: /^https?$/, message: "must be an http(s) URL" })
    .refine((value) => {
      if (!URL.canParse(value)) return true; // reported by the url check above
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash;
    }, "must not contain credentials, a query string or a fragment")
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
  LLAMA_API_KEY: z.string().min(1).max(4096).optional(),
  PROVIDER_TIMEOUT_MS: intFrom(1_000, 3_600_000).default(300_000),
  GENERATION_MAX_MS: intFrom(1_000, 86_400_000).default(1_800_000),
  DEFAULT_CONTEXT_TOKENS: intFrom(256, 10_000_000).default(8_192),
  MAX_OUTPUT_TOKENS: intFrom(1, 1_000_000).default(4_096),
  MAX_ACTIVE_GENERATIONS: intFrom(1, 1_000).optional(),
  PROVIDER_MAX_RESPONSE_BYTES: intFrom(1_024, 1_073_741_824).default(16 * 1024 * 1024),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  port: number;
  dataDir: string;
  nodeEnv: "development" | "production" | "test";
  logLevel: LogLevel;
  /** Interface the HTTP server listens on. */
  listenHost: string;
  /**
   * Running inside the ChatUI container image. The container listens on its own
   * interface and Compose publishes the port on 127.0.0.1 only; peers are the
   * container runtime's proxy, not loopback.
   */
  inContainer: boolean;
  provider: ProviderConfig;
}

export interface ProviderConfig {
  /** llama-server base URL without trailing slash; undefined = not configured. */
  baseUrl: string | undefined;
  /** Secret. Never logged or sent to the browser. */
  apiKey: string | undefined;
  /** Per-request inactivity timeout: to the first chunk and between chunks. */
  timeoutMs: number;
  /** Whole-generation cap. */
  generationMaxMs: number;
  defaultContextTokens: number;
  maxOutputTokens: number;
  /** Explicit global generation admission limit; undefined = discovered slots, else 1. */
  maxActiveGenerations: number | undefined;
  maxResponseBytes: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Validates the environment once at boot. Throws a ConfigError listing every
 * problem so the process can fail fast with a clear message.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): Config {
  // Treat empty strings as unset so `PORT=` falls back to the default.
  const input = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${problems.join("\n")}`);
  }

  const dataDir = path.resolve(cwd, parsed.data.DATA_DIR);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dataDir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new ConfigError(
      `Invalid configuration:\n  - DATA_DIR: ${parsed.data.DATA_DIR} is not an existing directory`,
    );
  }

  const inContainer = parsed.data.CHATUI_CONTAINER === "1";
  // Pre-authentication boundary (contracts §9.2b): on the host, never listen
  // beyond loopback. Removed only when authentication exists (Phase 4).
  if (!inContainer && !isLoopbackAddress(parsed.data.LISTEN_HOST)) {
    throw new ConfigError(
      "Invalid configuration:\n  - LISTEN_HOST: must be a loopback address (127.0.0.1 or ::1) " +
        "until authentication is available; use the Compose deployment to publish on 127.0.0.1",
    );
  }

  return {
    port: parsed.data.PORT,
    dataDir,
    nodeEnv: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    listenHost: parsed.data.LISTEN_HOST,
    inContainer,
    provider: {
      baseUrl: parsed.data.LLAMA_BASE_URL,
      apiKey: parsed.data.LLAMA_API_KEY,
      timeoutMs: parsed.data.PROVIDER_TIMEOUT_MS,
      generationMaxMs: parsed.data.GENERATION_MAX_MS,
      defaultContextTokens: parsed.data.DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: parsed.data.MAX_OUTPUT_TOKENS,
      maxActiveGenerations: parsed.data.MAX_ACTIVE_GENERATIONS,
      maxResponseBytes: parsed.data.PROVIDER_MAX_RESPONSE_BYTES,
    },
  };
}

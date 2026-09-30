// Loaded natively by Node (type stripping) from server/main.ts, so relative
// imports carry explicit .ts extensions and no path aliases are used.
import { statSync } from "node:fs";
import type { ArtifactConfig } from "./storage/artifacts.ts";
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
  // SSRF policy for provider endpoints (Phase 5).
  ALLOW_PRIVATE_PROVIDER_HOSTS: z.enum(["true", "false"]).default("true"),
  PROVIDER_HOST_ALLOWLIST: z.string().default(""),
  PROVIDER_LINK_LOCAL_EXCEPTIONS: z.string().default(""),

  // Persistence (Phase 3).
  OPERATION_RETENTION_MS: intFrom(2 * 86_400_000, 365 * 86_400_000).default(7 * 86_400_000),
  CONTEXT_TRIM_STEP: intFrom(1, 10_000_000).optional(),
  TEMPLATE_OVERHEAD_TOKENS: intFrom(0, 10_000).default(16),

  // Production streaming (Phase 6).
  GENERATION_CHECKPOINT_MS: intFrom(100, 60_000).default(1_000),
  GENERATION_RETENTION_MS: intFrom(1_000, 7 * 86_400_000).default(3_600_000),
  SSE_REPLAY_EVENTS: intFrom(10, 100_000).default(2_000),

  // Authentication (Phase 4).
  PUBLIC_ORIGIN: z.string().optional(),
  TRUST_PROXY: intFrom(0, 10).default(0),
  REGISTRATION_MODE: z.enum(["closed", "open"]).default("closed"),
  SESSION_ABSOLUTE_TTL: intFrom(60_000, 365 * 86_400_000).default(30 * 86_400_000),
  SESSION_IDLE_TTL: intFrom(60_000, 365 * 86_400_000).default(7 * 86_400_000),
  MAX_ACTIVE_GENERATIONS_PER_USER: intFrom(1, 100).default(2),
  MAX_SSE_PER_USER: intFrom(1, 1_000).default(8),
  MAX_SSE_TOTAL: intFrom(1, 100_000).default(256),
  PASSWORD_HASH_CONCURRENCY: intFrom(1, 64).default(2),
  PASSWORD_HASH_QUEUE: intFrom(0, 10_000).default(16),

  // Attachments (Phase 12). Admin settings may override the first four.
  ATTACHMENT_MAX_BYTES: intFrom(1_024, 1_073_741_824).default(20 * 1024 * 1024),
  ATTACHMENT_MAX_PER_MESSAGE: intFrom(1, 10).default(10),
  ATTACHMENT_QUOTA_BYTES: intFrom(1_024, 1_099_511_627_776).default(1024 * 1024 * 1024),
  ATTACHMENT_TEXT_INLINE_BYTES: intFrom(256, 10_000_000).default(100_000),
  ATTACHMENT_PENDING_TTL: intFrom(60_000, 30 * 86_400_000).default(86_400_000),
  ATTACHMENT_MAX_IMAGE_PIXELS: intFrom(1, 1_000_000_000).default(50_000_000),
  MAX_UPLOADS_PER_USER: intFrom(1, 100).default(4),
  MAX_UPLOADS_TOTAL: intFrom(1, 10_000).default(32),
  MEDIA_TOKEN_RESERVE: intFrom(1, 1_000_000).default(1_024),

  // Approved memories and proposal tools (Phase 13b).
  MEMORY_PROMPT_BUDGET: intFrom(0, 1_000_000).default(4_096),
  MEMORY_TOOL_MAX_CALLS: intFrom(1, 16).default(4),
  MEMORY_TOOL_MAX_ARGUMENT_BYTES: intFrom(256, 65_536).default(8_192),
  CONTINUATION_TOKEN_RESERVE: intFrom(0, 100_000).default(256),

  // Generated source artifacts (Phase 13c).
  ARTIFACT_MAX_BYTES: intFrom(1_024, 16 * 1024 * 1024).default(256 * 1024),
  ARTIFACT_MAX_PER_REPLY: intFrom(1, 100).default(16),
  ARTIFACT_QUOTA_BYTES: intFrom(1_024, 1_099_511_627_776).default(100 * 1024 * 1024),
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
  storage: StorageConfig;
  auth: AuthConfig;
  attachments: AttachmentConfig;
  memories: MemoryConfig;
  artifacts: ArtifactConfig;
}

/** Generated source artifact limits (contracts §12); the store holds the defaults. */
export type { ArtifactConfig } from "./storage/artifacts.ts";

/** Approved memories and proposal-only tools (contracts §4.3, §12). */
export interface MemoryConfig {
  /** UTF-8 bytes of approved notes a prompt may include (whole notes only). */
  promptBudgetBytes: number;
  /** Proposal calls per generation; later calls are invalid. */
  maxToolCalls: number;
  /** Streamed argument bytes per call; larger calls are invalid. */
  maxToolArgumentBytes: number;
  /** Context tokens reserved for the continuation's call/result messages when tools are offered. */
  continuationTokenReserve: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  promptBudgetBytes: 4_096,
  maxToolCalls: 4,
  maxToolArgumentBytes: 8_192,
  continuationTokenReserve: 256,
};

/** Attachment limits (contracts §7). Instance settings can override the first four. */
export interface AttachmentConfig {
  maxFileBytes: number;
  maxPerMessage: number;
  /** Total attachment bytes per user (QUOTA_EXCEEDED). */
  quotaBytes: number;
  /** Text inlined into the prompt per attachment; the rest is cut with a marker. */
  textInlineBytes: number;
  /** Unlinked uploads older than this are garbage-collected. */
  pendingTtlMs: number;
  maxImagePixels: number;
  /** Concurrent uploads in flight (INV-62). */
  maxUploadsPerUser: number;
  maxUploadsTotal: number;
  /** Context tokens reserved per image/audio part unless the provider counts them. */
  mediaTokenReserve: number;
}

export const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = {
  maxFileBytes: 20 * 1024 * 1024,
  maxPerMessage: 10,
  quotaBytes: 1024 * 1024 * 1024,
  textInlineBytes: 100_000,
  pendingTtlMs: 86_400_000,
  maxImagePixels: 50_000_000,
  maxUploadsPerUser: 4,
  maxUploadsTotal: 32,
  mediaTokenReserve: 1_024,
};

export interface AuthConfig {
  /** The URL users open. https (behind a TLS proxy) or http://localhost only. */
  publicOrigin: string;
  /** Cookies are `Secure` exactly when the public origin is https. */
  secureCookies: boolean;
  /** Reverse-proxy hops to trust for the client address (never for the protocol). */
  trustProxy: number;
  registrationMode: "closed" | "open";
  sessionAbsoluteTtlMs: number;
  sessionIdleTtlMs: number;
  maxActiveGenerationsPerUser: number;
  maxSsePerUser: number;
  maxSseTotal: number;
  hashConcurrency: number;
  hashQueue: number;
}

export interface StorageConfig {
  /** Committed operation records are kept this long (contracts §4.1). */
  operationRetentionMs: number;
  /** Anchor step for prefix-stable truncation; undefined = 25% of the budget. */
  contextTrimStep: number | undefined;
  /** Per-message template overhead used by the pessimistic token estimate. */
  templateOverheadTokens: number;
  /** Checkpoint cadence for running generations (plus every state transition). */
  generationCheckpointMs: number;
  /** Terminal generations (memory and finalized checkpoints) are kept this long. */
  generationRetentionMs: number;
  /** Replay ring buffer size per generation. */
  sseReplayEvents: number;
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
  /** SSRF policy applied at load and on every outbound provider request. */
  ssrf: {
    allowPrivate: boolean;
    hostAllowlist: string[];
    linkLocalExceptions: { hostname: string; address: string; port: number }[];
  };
}

/**
 * `host=address:port` tuples, comma-separated; IPv6 addresses in brackets
 * (`gw=[fe80::1]:8080`). Exact matches only: no wildcards or ranges.
 */
function parseLinkLocalExceptions(value: string): ProviderConfig["ssrf"]["linkLocalExceptions"] {
  const out: ProviderConfig["ssrf"]["linkLocalExceptions"] = [];
  for (const part of value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const match = /^([a-z0-9.-]+)=(?:\[([0-9a-f:.]+)\]|([0-9.]+)):(\d{1,5})$/i.exec(part);
    if (!match || !isIP(match[2] ?? match[3] ?? "")) {
      throw new ConfigError(
        `Invalid configuration:\n  - PROVIDER_LINK_LOCAL_EXCEPTIONS: "${part}" must be host=address:port (IPv6 in brackets)`,
      );
    }
    out.push({
      hostname: (match[1] ?? "").toLowerCase(),
      address: match[2] ?? match[3] ?? "",
      port: Number(match[4]),
    });
  }
  return out;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Exactly two transports are supported (contracts §6): an https origin behind
 * a TLS-terminating proxy (Secure cookies), or http://localhost for the host
 * machine only. Any other http origin fails at startup; there is no
 * insecure-LAN mode. The protocol is never inferred from X-Forwarded-Proto.
 */
function authConfig(
  env: {
    PUBLIC_ORIGIN?: string | undefined;
    TRUST_PROXY: number;
    REGISTRATION_MODE: "closed" | "open";
    SESSION_ABSOLUTE_TTL: number;
    SESSION_IDLE_TTL: number;
    MAX_ACTIVE_GENERATIONS_PER_USER: number;
    MAX_SSE_PER_USER: number;
    MAX_SSE_TOTAL: number;
    PASSWORD_HASH_CONCURRENCY: number;
    PASSWORD_HASH_QUEUE: number;
  },
  port: number,
): AuthConfig {
  const raw = env.PUBLIC_ORIGIN ?? `http://localhost:${String(port === 0 ? 3000 : port)}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      "Invalid configuration:\n  - PUBLIC_ORIGIN: must be a URL like https://chat.example.com",
    );
  }
  if (url.origin !== raw.replace(/\/+$/, "") || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ConfigError(
      "Invalid configuration:\n  - PUBLIC_ORIGIN: must be an origin only (scheme, host, optional port)",
    );
  }
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new ConfigError(
      "Invalid configuration:\n  - PUBLIC_ORIGIN: plain http is only supported for http://localhost or " +
        "http://127.0.0.1 (this computer). For LAN or phone access put ChatUI behind an https TLS proxy " +
        "(e.g. Caddy or Tailscale HTTPS) and set PUBLIC_ORIGIN to that https URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("Invalid configuration:\n  - PUBLIC_ORIGIN: must be http(s)");
  }
  return {
    publicOrigin: url.origin,
    secureCookies: url.protocol === "https:",
    trustProxy: env.TRUST_PROXY,
    registrationMode: env.REGISTRATION_MODE,
    sessionAbsoluteTtlMs: env.SESSION_ABSOLUTE_TTL,
    sessionIdleTtlMs: env.SESSION_IDLE_TTL,
    maxActiveGenerationsPerUser: env.MAX_ACTIVE_GENERATIONS_PER_USER,
    maxSsePerUser: env.MAX_SSE_PER_USER,
    maxSseTotal: env.MAX_SSE_TOTAL,
    hashConcurrency: env.PASSWORD_HASH_CONCURRENCY,
    hashQueue: env.PASSWORD_HASH_QUEUE,
  };
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
  const auth = authConfig(parsed.data, parsed.data.PORT);
  // Cookie transport (contracts §6): an http origin is host-only, so the
  // host process must listen on loopback. Behind a TLS proxy (https origin)
  // it may listen more widely; the container listens on its own interface.
  if (!inContainer && !auth.secureCookies && !isLoopbackAddress(parsed.data.LISTEN_HOST)) {
    throw new ConfigError(
      "Invalid configuration:\n  - LISTEN_HOST: must be loopback (127.0.0.1 or ::1) when PUBLIC_ORIGIN is " +
        "http://localhost; serve LAN or phone access through an https TLS proxy instead",
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
      ssrf: {
        allowPrivate: parsed.data.ALLOW_PRIVATE_PROVIDER_HOSTS === "true",
        hostAllowlist: parsed.data.PROVIDER_HOST_ALLOWLIST.split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean),
        linkLocalExceptions: parseLinkLocalExceptions(parsed.data.PROVIDER_LINK_LOCAL_EXCEPTIONS),
      },
    },
    auth,
    attachments: {
      maxFileBytes: parsed.data.ATTACHMENT_MAX_BYTES,
      maxPerMessage: parsed.data.ATTACHMENT_MAX_PER_MESSAGE,
      quotaBytes: parsed.data.ATTACHMENT_QUOTA_BYTES,
      textInlineBytes: parsed.data.ATTACHMENT_TEXT_INLINE_BYTES,
      pendingTtlMs: parsed.data.ATTACHMENT_PENDING_TTL,
      maxImagePixels: parsed.data.ATTACHMENT_MAX_IMAGE_PIXELS,
      maxUploadsPerUser: parsed.data.MAX_UPLOADS_PER_USER,
      maxUploadsTotal: parsed.data.MAX_UPLOADS_TOTAL,
      mediaTokenReserve: parsed.data.MEDIA_TOKEN_RESERVE,
    },
    artifacts: {
      maxBytes: parsed.data.ARTIFACT_MAX_BYTES,
      maxPerReply: parsed.data.ARTIFACT_MAX_PER_REPLY,
      quotaBytes: parsed.data.ARTIFACT_QUOTA_BYTES,
    },
    memories: {
      promptBudgetBytes: parsed.data.MEMORY_PROMPT_BUDGET,
      maxToolCalls: parsed.data.MEMORY_TOOL_MAX_CALLS,
      maxToolArgumentBytes: parsed.data.MEMORY_TOOL_MAX_ARGUMENT_BYTES,
      continuationTokenReserve: parsed.data.CONTINUATION_TOKEN_RESERVE,
    },
    storage: {
      operationRetentionMs: parsed.data.OPERATION_RETENTION_MS,
      contextTrimStep: parsed.data.CONTEXT_TRIM_STEP,
      templateOverheadTokens: parsed.data.TEMPLATE_OVERHEAD_TOKENS,
      generationCheckpointMs: parsed.data.GENERATION_CHECKPOINT_MS,
      generationRetentionMs: parsed.data.GENERATION_RETENTION_MS,
      sseReplayEvents: parsed.data.SSE_REPLAY_EVENTS,
    },
  };
}

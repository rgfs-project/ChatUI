// Loaded natively by Node (type stripping) from server/main.ts, so relative
// imports carry explicit .ts extensions and no path aliases are used.
import { statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { isLoopbackAddress } from "./loopback.ts";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const envSchema = z.object({
  PORT: z
    .string()
    .default("3000")
    .transform((value, ctx) => {
      const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        ctx.addIssue({ code: "custom", message: "must be an integer between 0 and 65535" });
        return z.NEVER;
      }
      return port;
    }),
  DATA_DIR: z.string().min(1, "must not be empty").default("./data"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  LISTEN_HOST: z
    .string()
    .default("127.0.0.1")
    .refine((value) => isIP(value) !== 0, "must be an IP address"),
  // Set only by the container image (Dockerfile). Not a user-facing option.
  CHATUI_CONTAINER: z.enum(["0", "1"]).default("0"),
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
  };
}

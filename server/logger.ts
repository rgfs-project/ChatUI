// Loaded natively by Node (type stripping); see server/config.ts.
import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

/** Field names that are always redacted, at any of the first two nesting levels. */
export const REDACTED_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "api_key",
  "secret",
  "csrfToken",
  "x-csrf-token",
  "x-api-key",
] as const;

export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...REDACTED_KEYS.flatMap((key) => {
    const accessor = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
    const dot = accessor.startsWith("[") ? "" : ".";
    return [accessor, `*${dot}${accessor}`];
  }),
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

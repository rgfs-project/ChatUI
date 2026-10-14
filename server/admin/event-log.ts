import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  LOG_LEVELS,
  LOG_SOURCES,
  type LogEntryDto,
  type LogLevel,
  type LogSettingsDto,
  type LogSource,
} from "@shared/admin";
import { REDACTED_KEYS, type Logger } from "../logger.ts";
import type { DataPaths } from "../storage/paths.ts";

/**
 * Settings → Logs (administrators): `_system/logs/<yyyy-mm-dd>.jsonl`, one
 * entry per line. Entries carry identifiers and short messages, never
 * passwords, keys or message content; a problem report's text is the user's
 * own words, shown to administrators by design. Days older than the
 * retention setting are removed by the hourly sweep.
 */

export const DEFAULT_LOG_SETTINGS: LogSettingsDto = { level: "info", retentionDays: 30 };

export interface LogEvent {
  level: LogLevel;
  source: LogSource;
  message: string;
  user?: { id: string; username: string } | null;
  requestId?: string | null;
  details?: string | null;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ID_RE = /^(\d{4}-\d{2}-\d{2})\.[0-9a-f]{16}$/;
const MAX_MESSAGE = 500;
const MAX_DETAILS = 8_000;

const rank = (level: LogLevel) => LOG_LEVELS.indexOf(level);

function isEntry(value: unknown): value is LogEntryDto {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<LogEntryDto>;
  return (
    typeof e.id === "string" &&
    typeof e.time === "string" &&
    (LOG_LEVELS as readonly unknown[]).includes(e.level) &&
    (LOG_SOURCES as readonly unknown[]).includes(e.source) &&
    typeof e.message === "string"
  );
}

function normalize(e: LogEntryDto): LogEntryDto {
  return {
    id: e.id,
    time: e.time,
    level: e.level,
    source: e.source,
    message: e.message,
    user:
      e.user && typeof e.user.id === "string" && typeof e.user.username === "string"
        ? { id: e.user.id, username: e.user.username }
        : null,
    requestId: typeof e.requestId === "string" ? e.requestId : null,
    details: typeof e.details === "string" ? e.details : null,
  };
}

export class EventLog {
  private readonly dir: string;
  private readonly now: () => Date;
  private settings: () => LogSettingsDto = () => DEFAULT_LOG_SETTINGS;
  /** Appends run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { paths: DataPaths; now?: () => Date }) {
    this.dir = path.join(options.paths.systemDir(), "logs");
    this.now = options.now ?? (() => new Date());
  }

  /** Where the level and retention come from (instance settings, once loaded). */
  useSettings(read: () => LogSettingsDto): void {
    this.settings = read;
  }

  get current(): LogSettingsDto {
    return this.settings();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Records an event at or above the configured level. Never throws. */
  record(event: LogEvent): Promise<void> {
    if (rank(event.level) < rank(this.settings().level)) return Promise.resolve();
    const time = this.now().toISOString();
    const day = time.slice(0, 10);
    const entry: LogEntryDto = {
      id: `${day}.${randomBytes(8).toString("hex")}`,
      time,
      level: event.level,
      source: event.source,
      message: event.message.slice(0, MAX_MESSAGE),
      user: event.user ?? null,
      requestId: event.requestId ?? null,
      details: event.details ? event.details.slice(0, MAX_DETAILS) : null,
    };
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await appendFile(path.join(this.dir, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
    }).catch(() => undefined);
  }

  private async days(): Promise<string[]> {
    return (await readdir(this.dir).catch(() => []))
      .filter((f) => DAY_FILE.test(f))
      .sort()
      .reverse();
  }

  private async read(file: string): Promise<LogEntryDto[]> {
    const text = await readFile(path.join(this.dir, file), "utf8").catch(() => "");
    const out: LogEntryDto[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntry(parsed)) out.push(normalize(parsed));
      } catch {
        // a torn last line after a crash: skip it
      }
    }
    return out;
  }

  /** The newest `limit` entries, newest first. */
  async recent(limit: number): Promise<LogEntryDto[]> {
    await this.queue;
    const out: LogEntryDto[] = [];
    for (const file of await this.days()) {
      for (const entry of (await this.read(file)).reverse()) {
        out.push(entry);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async get(id: string): Promise<LogEntryDto | null> {
    const match = ID_RE.exec(id);
    if (!match) return null;
    await this.queue;
    return (await this.read(`${match[1] ?? ""}.jsonl`)).find((e) => e.id === id) ?? null;
  }

  /** Every kept entry, oldest first. */
  async all(): Promise<LogEntryDto[]> {
    await this.queue;
    const out: LogEntryDto[] = [];
    for (const file of (await this.days()).reverse()) out.push(...(await this.read(file)));
    return out;
  }

  async clear(): Promise<number> {
    return this.serial(async () => {
      const files = await this.days();
      for (const file of files) await rm(path.join(this.dir, file), { force: true });
      return files.length;
    });
  }

  /** Removes day files older than the retention setting. */
  async sweep(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.settings().retentionDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return this.serial(async () => {
      let removed = 0;
      for (const file of await this.days()) {
        const day = DAY_FILE.exec(file)?.[1] ?? "";
        if (day < cutoff) {
          await rm(path.join(this.dir, file), { force: true });
          removed++;
        }
      }
      return removed;
    });
  }
}

const REDACTED = new Set<string>(REDACTED_KEYS.map((k) => k.toLowerCase()));
const LEVELS = ["debug", "info", "warn", "error"] as const;

/** Scalar fields of a log call's object, minus anything secret, as details. */
function detailsOf(obj: Record<string, unknown>): string | null {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACTED.has(key.toLowerCase())) continue;
    if (value instanceof Error) safe[key] = value.message;
    else if (["string", "number", "boolean"].includes(typeof value) || value === null)
      safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? JSON.stringify(safe, null, 2) : null;
}

function sourceOf(obj: Record<string, unknown>, message: string): LogSource {
  if (/^(login|logout|register|password)/.test(message)) return "auth";
  if ("generationId" in obj) return "generations";
  if ("providerId" in obj || "providers" in obj || /provider/i.test(message)) return "providers";
  return "system";
}

/**
 * The server logger, also feeding the event log: what the server already
 * logs (without secrets or content) shows in Settings → Logs too.
 */
export function teeLogger(base: Logger, events: EventLog): Logger {
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key === "child")
        return (...args: Parameters<Logger["child"]>) =>
          teeLogger(target.child(...args) as unknown as Logger, events);
      const level = LEVELS.find((l) => l === key);
      const value: unknown = Reflect.get(target, key, receiver);
      if (!level || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const [first, second] = args;
        const obj =
          typeof first === "object" && first !== null && !(first instanceof Error)
            ? (first as Record<string, unknown>)
            : first instanceof Error
              ? { err: first }
              : {};
        const message =
          typeof first === "string" ? first : typeof second === "string" ? second : "";
        if (message)
          void events.record({
            level,
            source: sourceOf(obj, message),
            message,
            details: detailsOf(obj),
          });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

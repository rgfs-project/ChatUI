// Append-only admin audit log (Phase 10): _system/audit/<yyyy-mm>.jsonl.
import { appendFile, readFile } from "node:fs/promises";
import { ensureDir } from "../storage/fs.ts";
import type { DataPaths } from "../storage/paths.ts";

export interface AuditEntry {
  at: string;
  actor: { id: string; username: string };
  action: string;
  target: { type: "user" | "provider" | "model" | "settings" | "maintenance"; id: string | null };
  outcome: "ok" | "error";
  /** Non-sensitive detail only: never secrets, passwords or message content. */
  detail?: Record<string, string | number | boolean | null>;
}

export class AuditLog {
  private readonly paths: DataPaths;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();

  constructor(paths: DataPaths, now: () => Date = () => new Date()) {
    this.paths = paths;
    this.now = now;
  }

  /** Appends one line (serialized: lines never interleave). */
  record(entry: Omit<AuditEntry, "at">): Promise<void> {
    const at = this.now().toISOString();
    const line = `${JSON.stringify({ at, ...entry } satisfies AuditEntry)}\n`;
    const write = async () => {
      await ensureDir(this.paths.auditDir());
      await appendFile(this.paths.auditFile(at.slice(0, 7)), line, { mode: 0o600 });
    };
    this.queue = this.queue.then(write, write);
    return this.queue;
  }

  /** Newest first, at most `limit` entries of one month. */
  async read(month: string, limit = 500): Promise<AuditEntry[]> {
    const text = await readFile(this.paths.auditFile(month), "utf8").catch(() => "");
    const entries: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // a torn final line after a crash is skipped
      }
    }
    return entries.reverse().slice(0, limit);
  }
}

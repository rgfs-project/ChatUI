import { appendFile, mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { KeyedLocks } from "../storage/locks.ts";
import type { DataPaths } from "../storage/paths.ts";

/**
 * Admin audit log (Phase 10): `_system/audit/<yyyy-mm>.jsonl`, one JSON
 * object per line, appended and fsynced under a lock. Entries name the
 * actor, action, target and outcome, never secret values, passwords or
 * message content: callers pass identifiers and field names only.
 */
export interface AuditEntry {
  time: string;
  actor: { id: string; username: string };
  action: string;
  target: {
    type: "user" | "provider" | "model" | "settings" | "maintenance";
    id?: string;
    label?: string;
  };
  outcome: "success" | "failure";
  /** Contract error code on failure. */
  code?: string;
  /** Names of changed fields (never their values). */
  fields?: string[];
}

export class AuditLog {
  private readonly dir: string;
  private readonly locks: KeyedLocks;
  private readonly now: () => Date;

  constructor(options: { paths: DataPaths; locks: KeyedLocks; now?: () => Date }) {
    this.dir = path.join(options.paths.systemDir(), "audit");
    this.locks = options.locks;
    this.now = options.now ?? (() => new Date());
  }

  async record(entry: Omit<AuditEntry, "time">): Promise<void> {
    const time = this.now().toISOString();
    const line = `${JSON.stringify({ time, ...entry })}\n`;
    const file = path.join(this.dir, `${time.slice(0, 7)}.jsonl`);
    await this.locks.run("audit", async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await appendFile(file, line, { mode: 0o600 });
      const handle = await open(file, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  /** The newest `limit` entries (newest first), across monthly files. */
  async recent(limit: number): Promise<AuditEntry[]> {
    const files = (await readdir(this.dir).catch(() => []))
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
    const out: AuditEntry[] = [];
    for (const f of files) {
      const lines = (await readFile(path.join(this.dir, f), "utf8")).split("\n").filter(Boolean);
      for (const line of lines.reverse()) {
        try {
          out.push(JSON.parse(line) as AuditEntry);
        } catch {
          // a torn last line after a crash: skip it
        }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

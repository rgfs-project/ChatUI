// Loaded natively by Node (server/cli.ts and the server bundle): .ts imports only.
import { hostname } from "node:os";
import path from "node:path";
import { atomicWrite, durableUnlink, readOrNull } from "./fs.ts";
import { SYSTEM_DIR } from "./paths.ts";

/** How often a running server refreshes its lock, and when a lock counts as stale. */
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 3 * HEARTBEAT_MS;

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
}

const lockFile = (dataDir: string) => path.join(path.resolve(dataDir), SYSTEM_DIR, "server.lock");

/**
 * The running server's presence in DATA_DIR (Phase 16): a small file it
 * refreshes every 30 s and removes on a clean shutdown. Offline tools
 * (backup, restore) refuse to run while it is fresh, which also works when
 * the server runs in another container sharing the volume. A crash leaves a
 * lock that goes stale after 90 s; it never blocks the server's own start.
 */
export async function readLock(dataDir: string, now = Date.now()): Promise<LockInfo | null> {
  const bytes = await readOrNull(lockFile(dataDir));
  if (!bytes) return null;
  try {
    const info = JSON.parse(bytes.toString("utf8")) as LockInfo;
    const age = now - Date.parse(info.heartbeatAt);
    return Number.isFinite(age) && age < STALE_MS ? info : null;
  } catch {
    return null;
  }
}

export class InstanceLock {
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date().toISOString();

  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Writes the lock and keeps it fresh; returns another live server's lock, if one exists. */
  async acquire(): Promise<LockInfo | null> {
    const other = await readLock(this.dataDir);
    const mine = other?.pid === process.pid && other.host === hostname();
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat().catch(() => undefined);
    }, HEARTBEAT_MS);
    this.timer.unref();
    return other && !mine ? other : null;
  }

  private beat(): Promise<void> {
    const info: LockInfo = {
      pid: process.pid,
      host: hostname(),
      startedAt: this.startedAt,
      heartbeatAt: new Date().toISOString(),
    };
    return atomicWrite(lockFile(this.dataDir), `${JSON.stringify(info)}\n`);
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await durableUnlink(lockFile(this.dataDir)).catch(() => false);
  }
}

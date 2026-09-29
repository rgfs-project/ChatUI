// Server-side sessions (contracts §6). Only the SHA-256 of the token is stored.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { atomicWrite, durableUnlink, ensureDir, listDir, readOrNull } from "../storage/fs.ts";
import { isSha256Hex, type DataPaths } from "../storage/paths.ts";
import type { Role } from "../storage/users.ts";

export interface SessionRecord {
  version: 1;
  userId: string;
  /** Role at issue time: any change revokes the session (privilege change). */
  role: Role;
  /** Synchronizer CSRF token delivered to the browser (contracts §5). */
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
}

export interface IssuedSession {
  token: string;
  tokenHash: string;
  record: SessionRecord;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Idle-expiry bookkeeping is written at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;

export class SessionStore {
  private readonly paths: DataPaths;
  private readonly absoluteTtlMs: number;
  private readonly idleTtlMs: number;
  private readonly now: () => Date;
  private readonly revokedListeners = new Set<(tokenHash: string) => void>();

  constructor(options: {
    paths: DataPaths;
    absoluteTtlMs: number;
    idleTtlMs: number;
    now?: () => Date;
  }) {
    this.paths = options.paths;
    this.absoluteTtlMs = options.absoluteTtlMs;
    this.idleTtlMs = options.idleTtlMs;
    this.now = options.now ?? (() => new Date());
  }

  /** Notified whenever a session is revoked (closes bound SSE streams). */
  onRevoked(listener: (tokenHash: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  async issue(userId: string, role: Role): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const now = this.now();
    const record: SessionRecord = {
      version: 1,
      userId,
      role,
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + this.absoluteTtlMs).toISOString(),
    };
    await ensureDir(this.paths.sessionsDir());
    await atomicWrite(this.paths.sessionFile(tokenHash), JSON.stringify(record));
    return { token, tokenHash, record };
  }

  expired(record: SessionRecord, at = this.now()): boolean {
    return (
      at.getTime() >= Date.parse(record.absoluteExpiresAt) ||
      at.getTime() >= Date.parse(record.lastSeenAt) + this.idleTtlMs
    );
  }

  /** Reads a live session by hash; expired or unreadable sessions are removed. */
  async read(tokenHash: string): Promise<SessionRecord | null> {
    if (!isSha256Hex(tokenHash)) return null;
    const bytes = await readOrNull(this.paths.sessionFile(tokenHash));
    if (!bytes) return null;
    let parsed: Partial<SessionRecord> | null;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as Partial<SessionRecord> | null;
    } catch {
      parsed = null;
    }
    const valid =
      parsed?.version === 1 &&
      typeof parsed.userId === "string" &&
      typeof parsed.csrfToken === "string" &&
      typeof parsed.lastSeenAt === "string" &&
      typeof parsed.absoluteExpiresAt === "string";
    const record = parsed as SessionRecord;
    if (!valid || this.expired(record)) {
      await this.revoke(tokenHash);
      return null;
    }
    return record;
  }

  /** Extends idle expiry (throttled). */
  async touch(tokenHash: string, record: SessionRecord): Promise<void> {
    const now = this.now();
    if (now.getTime() - Date.parse(record.lastSeenAt) < TOUCH_INTERVAL_MS) return;
    await atomicWrite(
      this.paths.sessionFile(tokenHash),
      JSON.stringify({ ...record, lastSeenAt: now.toISOString() }),
    );
  }

  async revoke(tokenHash: string): Promise<void> {
    if (!isSha256Hex(tokenHash)) return;
    await durableUnlink(this.paths.sessionFile(tokenHash));
    for (const listener of this.revokedListeners) listener(tokenHash);
  }

  /** Revokes every session of a user (password change, disable, demotion, deletion). */
  async revokeUser(userId: string): Promise<number> {
    let count = 0;
    for (const { hash, record } of await this.list()) {
      if (record?.userId === userId) {
        await this.revoke(hash);
        count++;
      }
    }
    return count;
  }

  /** Removes expired and unreadable sessions (startup and periodic sweep). */
  async sweep(): Promise<number> {
    let removed = 0;
    for (const { hash, record } of await this.list()) {
      if (!record || this.expired(record)) {
        await this.revoke(hash);
        removed++;
      }
    }
    return removed;
  }

  private async list(): Promise<{ hash: string; record: SessionRecord | null }[]> {
    const out: { hash: string; record: SessionRecord | null }[] = [];
    for (const name of await listDir(this.paths.sessionsDir())) {
      const hash = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isSha256Hex(hash)) continue;
      const bytes = await readOrNull(this.paths.sessionFile(hash));
      try {
        out.push({
          hash,
          record: bytes ? (JSON.parse(bytes.toString("utf8")) as SessionRecord) : null,
        });
      } catch {
        out.push({ hash, record: null });
      }
    }
    return out;
  }
}

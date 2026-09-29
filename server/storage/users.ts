// Accounts (contracts §6). Loadable natively by Node (used by the CLI).
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { atomicWrite, ensureDir, readOrNull } from "./fs.ts";
import type { KeyedLocks } from "./locks.ts";
import { isUuid, type DataPaths } from "./paths.ts";

export type Role = "user" | "admin";
export type AccountStatus = "active" | "disabled" | "closing";

/** Canonical account record. `passwordHash` never leaves the storage layer. */
export interface UserRecord {
  id: string;
  username: string;
  role: Role;
  status: AccountStatus;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

/** What the rest of the server may see of an account. */
export type PublicUser = Omit<UserRecord, "passwordHash">;

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

export class UserError extends Error {
  override name = "UserError";
  readonly kind: "taken" | "invalid" | "not_found";
  constructor(kind: UserError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Usernames are case-insensitive: stored and compared in lowercase. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function isUserRecord(value: unknown, id: string): value is UserRecord {
  if (typeof value !== "object" || value === null) return false;
  const u = value as Partial<UserRecord>;
  return (
    u.id === id &&
    typeof u.username === "string" &&
    USERNAME_RE.test(u.username) &&
    (u.role === "user" || u.role === "admin") &&
    (u.status === "active" || u.status === "disabled" || u.status === "closing") &&
    typeof u.passwordHash === "string" &&
    typeof u.createdAt === "string" &&
    typeof u.updatedAt === "string"
  );
}

export function publicUser(record: UserRecord): PublicUser {
  const { passwordHash: _omit, ...rest } = record;
  return rest;
}

export const REGISTRY_LOCK = "registry";

export class UserStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly now: () => Date;
  /** Derived username → id map (users.index.json mirrors it). */
  private byName = new Map<string, string>();

  constructor(options: { paths: DataPaths; locks: KeyedLocks; now?: () => Date }) {
    this.paths = options.paths;
    this.locks = options.locks;
    this.now = options.now ?? (() => new Date());
  }

  async get(id: string): Promise<UserRecord | null> {
    if (!isUuid(id)) return null;
    const bytes = await readOrNull(this.paths.userFile(id));
    if (!bytes) return null;
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      return isUserRecord(parsed, id) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Every user directory that holds a valid user.json (account directories). */
  async all(): Promise<UserRecord[]> {
    const entries = await readdir(this.paths.root, { withFileTypes: true }).catch(() => []);
    const users: UserRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue;
      const user = await this.get(entry.name);
      if (user) users.push(user);
    }
    return users;
  }

  /** Rebuilds the derived username index from canonical user.json files. */
  async rebuildIndex(): Promise<number> {
    const users = await this.all();
    this.byName = new Map(users.map((u) => [u.username, u.id]));
    await ensureDir(this.paths.systemDir());
    await atomicWrite(
      this.paths.usersIndexFile(),
      `${JSON.stringify({ version: 1, users: Object.fromEntries(this.byName) }, null, 2)}\n`,
    );
    return users.length;
  }

  /** Finds by username; on a miss, rebuilds once (accounts created by the CLI). */
  async findByUsername(username: string): Promise<UserRecord | null> {
    const name = normalizeUsername(username);
    let id = this.byName.get(name);
    if (id === undefined) {
      await this.locks.run(REGISTRY_LOCK, () => this.rebuildIndex());
      id = this.byName.get(name);
    }
    if (id === undefined) return null;
    const user = await this.get(id);
    return user?.username === name ? user : null;
  }

  /** Creates an account under the registry lock (case-insensitive uniqueness). */
  async create(input: { username: string; passwordHash: string; role: Role }): Promise<UserRecord> {
    const username = normalizeUsername(input.username);
    if (!USERNAME_RE.test(username)) {
      throw new UserError("invalid", "Usernames are 3-32 characters: a-z, 0-9, _ . -");
    }
    return this.locks.run(REGISTRY_LOCK, async () => {
      await this.rebuildIndex();
      if (this.byName.has(username)) throw new UserError("taken", "That username is taken");
      const now = this.now().toISOString();
      const record: UserRecord = {
        id: randomUUID(),
        username,
        role: input.role,
        status: "active",
        passwordHash: input.passwordHash,
        createdAt: now,
        updatedAt: now,
      };
      // Creating an account is the one place a user root directory is created.
      await ensureDir(this.paths.userDir(record.id));
      await atomicWrite(this.paths.userFile(record.id), `${JSON.stringify(record, null, 2)}\n`);
      this.byName.set(username, record.id);
      await atomicWrite(
        this.paths.usersIndexFile(),
        `${JSON.stringify({ version: 1, users: Object.fromEntries(this.byName) }, null, 2)}\n`,
      );
      return record;
    });
  }

  /** Updates mutable fields of an existing account (never creates one). */
  async update(
    id: string,
    patch: Partial<Pick<UserRecord, "passwordHash" | "role" | "status">>,
  ): Promise<UserRecord> {
    return this.locks.run(REGISTRY_LOCK, async () => {
      const current = await this.get(id);
      if (!current) throw new UserError("not_found", "Account not found");
      const next: UserRecord = { ...current, ...patch, updatedAt: this.now().toISOString() };
      await atomicWrite(this.paths.userFile(id), `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }
}

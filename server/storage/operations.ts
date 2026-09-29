// Generation acceptance records by client operation key (contracts §4.1,
// INV-58). Loadable natively by Node.
import { createHash } from "node:crypto";
import type { AccountWrites } from "./account.ts";
import { atomicWrite, durableUnlink, ensureDir, listDir, readOrNull } from "./fs.ts";
import { isSha256Hex, type DataPaths } from "./paths.ts";

export interface OperationRecord {
  version: 1;
  operationKey: string;
  /** SHA-256 of the normalized request payload. */
  payloadHash: string;
  conversationId: string;
  generationId: string;
  userMessageId: string;
  assistantMessageId: string;
  /** Conversation file hash before the write; null when the send creates it. */
  beforeHash: string | null;
  /** Conversation file hash after the user-block write. */
  afterHash: string;
  status: "pending" | "committed";
  /** Set by the terminal sequence after the assistant write (or its discard). */
  terminalWritten: boolean;
  issuedAt: string;
  createdAt: string;
  committedAt: string | null;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function operationDigest(userId: string, operationKey: string): string {
  return sha256Hex(`${userId}:${operationKey}`);
}

function isRecord(value: unknown): value is OperationRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<OperationRecord>;
  return (
    r.version === 1 &&
    typeof r.operationKey === "string" &&
    typeof r.payloadHash === "string" &&
    typeof r.conversationId === "string" &&
    typeof r.afterHash === "string" &&
    (r.status === "pending" || r.status === "committed") &&
    typeof r.terminalWritten === "boolean"
  );
}

export class OperationStore {
  private readonly paths: DataPaths;

  private readonly writes: AccountWrites | undefined;

  constructor(paths: DataPaths, writes?: AccountWrites) {
    this.paths = paths;
    this.writes = writes;
  }

  private guarded<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.writes ? this.writes.run(userId, fn) : fn();
  }

  async read(userId: string, operationKey: string): Promise<OperationRecord | null> {
    const bytes = await readOrNull(
      this.paths.operationFile(userId, operationDigest(userId, operationKey)),
    );
    if (!bytes) return null;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("operation record is invalid");
    return parsed;
  }

  async write(userId: string, record: OperationRecord): Promise<void> {
    await this.guarded(userId, async () => {
      await ensureDir(this.paths.operationsDir(userId));
      await atomicWrite(
        this.paths.operationFile(userId, operationDigest(userId, record.operationKey)),
        `${JSON.stringify(record, null, 2)}\n`,
      );
    });
  }

  async delete(userId: string, operationKey: string): Promise<void> {
    await this.guarded(userId, () =>
      durableUnlink(this.paths.operationFile(userId, operationDigest(userId, operationKey))).then(
        () => undefined,
      ),
    );
  }

  /** Every readable record of a user (recovery and retention). */
  async all(userId: string): Promise<OperationRecord[]> {
    const records: OperationRecord[] = [];
    for (const name of await listDir(this.paths.operationsDir(userId))) {
      const digest = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isSha256Hex(digest)) continue;
      const bytes = await readOrNull(this.paths.operationFile(userId, digest));
      if (!bytes) continue;
      try {
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // An unreadable record is left for an operator; it is never guessed at.
      }
    }
    return records;
  }
}

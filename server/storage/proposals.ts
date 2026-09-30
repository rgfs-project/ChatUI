// Proposal sidecars (Phase 13b, contracts §4.3): `proposals/<conversation-uuid>.json`.
import type { ProposalDto, ProposalStatus, ProposalTool } from "@shared/memories";
import type { AccountWrites } from "./account.ts";
import { atomicWrite, durableUnlink, ensureDir, listDir, readOrNull } from "./fs.ts";
import type { KeyedLocks } from "./locks.ts";
import type { ConversationModel } from "./markdown.ts";
import { isUuid, type DataPaths } from "./paths.ts";

/** Recovery metadata of an acceptance in progress (contracts §4.3). */
export interface AcceptanceIntent {
  memoryId: string;
  /** SHA-256 of the note file before the change; null = absent (create). */
  beforeHash: string | null;
  /** SHA-256 of the note file after the change; null = absent (forget). */
  afterHash: string | null;
  startedAt: string;
}

/**
 * One validated or suppressed proposal call and its outcome. Invalid calls
 * are never recorded (only logged without content); `invalid` is the status
 * a pending proposal takes when its source turn goes away.
 */
export interface ProposalRecord {
  id: string;
  generationId: string;
  callIndex: number;
  userMessageId: string;
  assistantMessageId: string;
  providerId: string;
  model: string;
  tool: ProposalTool;
  /** Validated arguments. */
  name: string;
  content: string | null;
  /** The snapshot note an update/forget targets. */
  targetMemoryId: string | null;
  /** The target's revision in the generation's prompt snapshot (null for create). */
  baselineRevision: string | null;
  /** Duplicate-suppression key parts. */
  nameKey: string;
  contentHash: string | null;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  resultMemoryId: string | null;
  intent: AcceptanceIntent | null;
}

interface SidecarFile {
  version: 1;
  proposals: ProposalRecord[];
}

/** Records retained per conversation; the oldest resolved ones go first. */
export const MAX_PROPOSALS_PER_CONVERSATION = 500;

function isRecord(value: unknown): value is ProposalRecord {
  const r = value as Partial<ProposalRecord> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.id === "string" &&
    isUuid(r.id) &&
    typeof r.generationId === "string" &&
    typeof r.callIndex === "number" &&
    typeof r.userMessageId === "string" &&
    typeof r.assistantMessageId === "string" &&
    (r.tool === "create" || r.tool === "update" || r.tool === "forget") &&
    typeof r.name === "string" &&
    typeof r.status === "string"
  );
}

export function toProposalDto(record: ProposalRecord): ProposalDto {
  return {
    id: record.id,
    generationId: record.generationId,
    callIndex: record.callIndex,
    userMessageId: record.userMessageId,
    assistantMessageId: record.assistantMessageId,
    tool: record.tool,
    name: record.name,
    content: record.content,
    targetMemoryId: record.targetMemoryId,
    status: record.status,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
    resultMemoryId: record.resultMemoryId,
  };
}

export class SidecarMalformedError extends Error {
  override name = "SidecarMalformedError";
}

/**
 * Proposal sidecars. Each is canonical (not derived): records are only ever
 * appended idempotently by `(generationId, callIndex)` or have their status
 * changed; a malformed sidecar is never overwritten. Every change holds the
 * sidecar lock, taken after the conversation lock and before the memory lock
 * (contracts §2).
 */
export class ProposalStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly writes: AccountWrites | undefined;

  constructor(options: { paths: DataPaths; locks: KeyedLocks; writes?: AccountWrites }) {
    this.paths = options.paths;
    this.locks = options.locks;
    this.writes = options.writes;
  }

  withLock<T>(userId: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(`proposals:${userId}/${conversationId}`, fn);
  }

  /** The records, or `malformed` (which callers must not overwrite). */
  async readUnlocked(
    userId: string,
    conversationId: string,
  ): Promise<{ records: ProposalRecord[]; malformed: boolean }> {
    const bytes = await readOrNull(this.paths.proposalsFile(userId, conversationId));
    if (!bytes) return { records: [], malformed: false };
    try {
      const raw = JSON.parse(bytes.toString("utf8")) as Partial<SidecarFile>;
      if (raw.version !== 1 || !Array.isArray(raw.proposals))
        return { records: [], malformed: true };
      return { records: raw.proposals.filter(isRecord), malformed: false };
    } catch {
      return { records: [], malformed: true };
    }
  }

  async writeUnlocked(
    userId: string,
    conversationId: string,
    records: readonly ProposalRecord[],
  ): Promise<void> {
    let kept = [...records];
    if (kept.length > MAX_PROPOSALS_PER_CONVERSATION) {
      // Drop the oldest resolved records; pending ones and open intents stay.
      let excess = kept.length - MAX_PROPOSALS_PER_CONVERSATION;
      kept = kept.filter((r) => {
        if (excess > 0 && r.status !== "pending" && r.intent === null) {
          excess--;
          return false;
        }
        return true;
      });
    }
    const file: SidecarFile = { version: 1, proposals: kept };
    const write = async () => {
      await ensureDir(this.paths.proposalsDir(userId));
      await atomicWrite(this.paths.proposalsFile(userId, conversationId), JSON.stringify(file));
    };
    await (this.writes ? this.writes.run(userId, write) : write());
  }

  /** Read-modify-write under the sidecar lock. `change` returns null for no write. */
  modify<T>(
    userId: string,
    conversationId: string,
    change: (records: ProposalRecord[]) => { records: ProposalRecord[] | null; result: T },
  ): Promise<T> {
    return this.withLock(userId, conversationId, async () => {
      const read = await this.readUnlocked(userId, conversationId);
      if (read.malformed)
        throw new SidecarMalformedError("the proposal sidecar is malformed; it was left untouched");
      const { records, result } = change(read.records);
      if (records) await this.writeUnlocked(userId, conversationId, records);
      return result;
    });
  }

  async list(userId: string, conversationId: string): Promise<ProposalRecord[]> {
    return (await this.readUnlocked(userId, conversationId)).records;
  }

  /**
   * Appends staged records, skipping any whose `(generationId, callIndex)` is
   * already present (so the terminal sequence and recovery are idempotent).
   * Returns the number written.
   */
  stage(userId: string, conversationId: string, staged: readonly ProposalRecord[]) {
    return this.modify(userId, conversationId, (records) => {
      const have = new Set(records.map((r) => `${r.generationId}:${String(r.callIndex)}`));
      const fresh = staged.filter((r) => !have.has(`${r.generationId}:${String(r.callIndex)}`));
      return { records: fresh.length > 0 ? [...records, ...fresh] : null, result: fresh.length };
    });
  }

  /**
   * Edit / regenerate / delete exchange (contracts §4.3 lifecycle): pending
   * proposals whose source turn is no longer valid become `invalid`; resolved
   * history is kept. Caller holds the conversation lock.
   */
  async invalidateStale(
    userId: string,
    conversationId: string,
    model: ConversationModel,
    isValid: (model: ConversationModel, record: ProposalRecord) => boolean,
    now: string,
  ): Promise<number> {
    if ((await readOrNull(this.paths.proposalsFile(userId, conversationId))) === null) return 0;
    return this.modify(userId, conversationId, (records) => {
      let changed = 0;
      const next = records.map((r) => {
        if (r.status !== "pending" || r.intent !== null || isValid(model, r)) return r;
        changed++;
        return { ...r, status: "invalid" as const, decidedAt: now };
      });
      return { records: changed > 0 ? next : null, result: changed };
    });
  }

  /** Conversation deletion: the sidecar goes after the Markdown (contracts §4.3). */
  async delete(userId: string, conversationId: string): Promise<void> {
    await this.withLock(userId, conversationId, async () => {
      const remove = () => durableUnlink(this.paths.proposalsFile(userId, conversationId));
      await (this.writes ? this.writes.run(userId, remove) : remove());
    });
  }

  /** Conversation ids that have a sidecar (startup recovery). */
  async conversations(userId: string): Promise<string[]> {
    return (await listDir(this.paths.proposalsDir(userId)))
      .map((name) => (name.endsWith(".json") ? name.slice(0, -5) : ""))
      .filter(isUuid);
  }
}

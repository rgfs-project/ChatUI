// Memory proposal sidecars (contracts §4.3, Phase 13b):
// `proposals/<conversation-uuid>.json`, one per conversation, holding the
// validated and suppressed suggestions of its replies and their outcomes.
// Every change holds the sidecar lock (contracts §2: after conversation
// locks, before the memory-store lock). Loadable natively by Node.
import { atomicWrite, durableUnlink, ensureDirUnder, listDir, readOrNull } from "./fs.ts";
import { lockKeys, type KeyedLocks } from "./locks.ts";
import { isCanonicalUuid } from "./markdown.ts";
import type { DataPaths } from "./paths.ts";

export type ProposalTool = "remember" | "update_memory" | "forget_memory";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "invalid" | "suppressed";

/** Recovery metadata for an acceptance in progress (contracts §4.3). */
export interface AcceptanceIntent {
  op: "create" | "update" | "delete";
  memoryId: string;
  /** Memory file hash before the change (null: absent). */
  beforeHash: string | null;
  /** Memory file hash after the change (null: absent, for delete). */
  afterHash: string | null;
  /** The exact bytes to write (create/update), so a retry writes the same file. */
  bytes: string | null;
  startedAt: string;
}

/** A validated call staged in the `terminal-decided` checkpoint. */
export interface StagedProposal {
  id: string;
  generationId: string;
  callIndex: number;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  providerId: string;
  model: string;
  tool: ProposalTool;
  /** Validated arguments: the note name, and the content for remember/update. */
  name: string;
  content: string | null;
  /** update/forget: the note it resolved to in the prompt snapshot. */
  targetMemoryId: string | null;
  /** The target's revision in the prompt snapshot (null for create: absence). */
  baselineRevision: string | null;
  contentHash: string;
  status: "pending" | "suppressed";
  createdAt: string;
}

export interface ProposalRecord extends Omit<StagedProposal, "status"> {
  status: ProposalStatus;
  decidedAt: string | null;
  /** The note changed since the snapshot: accepting is refused (INV-38). */
  stale: boolean;
  intent: AcceptanceIntent | null;
}

interface SidecarFile {
  version: 1;
  conversationId: string;
  proposals: ProposalRecord[];
}

/** Retained records per conversation; the oldest resolved ones go first. */
export const MAX_PROPOSALS_PER_CONVERSATION = 200;

function isRecord(value: unknown): value is ProposalRecord {
  const r = value as Partial<ProposalRecord> | null;
  return (
    typeof r?.id === "string" &&
    isCanonicalUuid(r.id) &&
    typeof r.generationId === "string" &&
    typeof r.callIndex === "number" &&
    typeof r.name === "string" &&
    (r.tool === "remember" || r.tool === "update_memory" || r.tool === "forget_memory") &&
    typeof r.status === "string"
  );
}

export class ProposalStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;

  constructor(paths: DataPaths, locks: KeyedLocks) {
    this.paths = paths;
    this.locks = locks;
  }

  withLock<T>(userId: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(lockKeys.proposals(userId, conversationId), fn);
  }

  /** Records of a conversation (missing or unreadable sidecar: none). */
  async read(userId: string, conversationId: string): Promise<ProposalRecord[]> {
    const bytes = await readOrNull(this.paths.proposalFile(userId, conversationId));
    if (!bytes) return [];
    try {
      const file = JSON.parse(bytes.toString("utf8")) as Partial<SidecarFile>;
      if (file.version !== 1 || !Array.isArray(file.proposals)) return [];
      return file.proposals.filter(isRecord);
    } catch {
      return [];
    }
  }

  /** Conversations with a sidecar (startup intent recovery). */
  async conversations(userId: string): Promise<string[]> {
    return (await listDir(this.paths.proposalsDir(userId)))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => isCanonicalUuid(id));
  }

  async writeUnlocked(
    userId: string,
    conversationId: string,
    proposals: ProposalRecord[],
  ): Promise<void> {
    await ensureDirUnder(this.paths.userDir(userId), this.paths.proposalsDir(userId));
    let kept = proposals;
    if (kept.length > MAX_PROPOSALS_PER_CONVERSATION) {
      const excess = kept.length - MAX_PROPOSALS_PER_CONVERSATION;
      const removable = new Set(
        kept
          .filter((p) => p.status !== "pending" && p.intent === null)
          .slice(0, excess)
          .map((p) => p.id),
      );
      kept = kept.filter((p) => !removable.has(p.id));
    }
    const file: SidecarFile = { version: 1, conversationId, proposals: kept };
    await atomicWrite(
      this.paths.proposalFile(userId, conversationId),
      `${JSON.stringify(file, null, 2)}\n`,
    );
  }

  /**
   * Adds staged proposals, idempotently by `(generationId, callIndex)`
   * (contracts §4.3). Returns how many were new.
   */
  async addStagedUnlocked(
    userId: string,
    conversationId: string,
    staged: readonly StagedProposal[],
  ): Promise<number> {
    if (staged.length === 0) return 0;
    const current = await this.read(userId, conversationId);
    const seen = new Set(current.map((p) => `${p.generationId}:${String(p.callIndex)}`));
    const fresh = staged
      .filter((p) => !seen.has(`${p.generationId}:${String(p.callIndex)}`))
      .map((p): ProposalRecord => ({ ...p, decidedAt: null, stale: false, intent: null }));
    if (fresh.length === 0) return 0;
    await this.writeUnlocked(userId, conversationId, [...current, ...fresh]);
    return fresh.length;
  }

  /**
   * Marks pending proposals whose source message is gone `invalid` (edit,
   * regenerate, delete exchange); resolved history stays (contracts §4.3).
   */
  async invalidateMissing(
    userId: string,
    conversationId: string,
    remainingMessageIds: ReadonlySet<string>,
    now: string,
  ): Promise<number> {
    return this.withLock(userId, conversationId, async () => {
      const current = await this.read(userId, conversationId);
      let changed = 0;
      const next = current.map((p) => {
        if (
          p.status !== "pending" ||
          p.intent !== null ||
          (remainingMessageIds.has(p.sourceUserMessageId) &&
            remainingMessageIds.has(p.sourceAssistantMessageId))
        )
          return p;
        changed++;
        return { ...p, status: "invalid" as const, decidedAt: now };
      });
      if (changed > 0) await this.writeUnlocked(userId, conversationId, next);
      return changed;
    });
  }

  async deleteUnlocked(userId: string, conversationId: string): Promise<void> {
    await durableUnlink(this.paths.proposalFile(userId, conversationId));
  }
}

// Memories and proposals (Phase 13b, contracts §4.3, §12): CRUD for approved
// notes, accept/reject of model suggestions with recoverable acceptance
// intents, and the sidecar steps of conversation deletion.
import type { MemoryDto, ProposalDto } from "@shared/memories";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import {
  memorySnapshot,
  MemoryError,
  revisionOf,
  type Memory,
  type MemoryStore,
} from "../storage/memories.ts";
import type { AcceptanceIntent, ProposalRecord, ProposalStore } from "../storage/proposals.ts";

export interface MemoryServiceHooks {
  /** Test hooks for crash simulation around an acceptance. */
  afterIntent?: () => Promise<void>;
  afterApply?: () => Promise<void>;
}

export function toAppError(error: unknown): never {
  if (error instanceof MemoryError) {
    const code = {
      invalid: ErrorCode.VALIDATION,
      duplicate: ErrorCode.CONFLICT,
      not_found: ErrorCode.NOT_FOUND,
      conflict: ErrorCode.CONFLICT,
      limit: ErrorCode.VALIDATION,
    }[error.kind];
    throw new AppError(code, error.message);
  }
  throw error;
}

export function proposalDto(record: ProposalRecord): ProposalDto {
  return {
    id: record.id,
    tool: record.tool,
    name: record.name,
    content: record.content,
    status: record.status,
    stale: record.stale,
    sourceAssistantMessageId: record.sourceAssistantMessageId,
    createdAt: record.createdAt,
  };
}

export class MemoryService {
  private readonly memories: MemoryStore;
  private readonly proposals: ProposalStore;
  private readonly logger: Logger;
  private readonly now: () => Date;
  hooks: MemoryServiceHooks = {};

  constructor(options: {
    memories: MemoryStore;
    proposals: ProposalStore;
    logger: Logger;
    now?: () => Date;
  }) {
    this.memories = options.memories;
    this.proposals = options.proposals;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async list(userId: string): Promise<MemoryDto[]> {
    const all = await this.memories.list(userId);
    const omitted = new Set(memorySnapshot(all).omitted.map((m) => m.id));
    return all.map((m) => ({ ...m, omitted: omitted.has(m.id) }));
  }

  private async dto(userId: string, memory: Memory): Promise<MemoryDto> {
    return (
      (await this.list(userId)).find((m) => m.id === memory.id) ?? { ...memory, omitted: false }
    );
  }

  async create(userId: string, input: { name: string; body: string }): Promise<MemoryDto> {
    const memory = await this.memories.create(userId, input).catch(toAppError);
    return this.dto(userId, memory);
  }

  async update(
    userId: string,
    id: string,
    input: { name?: string; body?: string; expectedRevision: string },
  ): Promise<MemoryDto> {
    const memory = await this.memories.update(userId, id, input).catch(toAppError);
    return this.dto(userId, memory);
  }

  async delete(userId: string, id: string, expectedRevision: string): Promise<void> {
    await this.memories.delete(userId, id, expectedRevision).catch(toAppError);
  }

  async proposalsFor(userId: string, conversationId: string): Promise<ProposalDto[]> {
    return (await this.proposals.read(userId, conversationId)).map(proposalDto);
  }

  /**
   * Accepts a pending suggestion (INV-37, INV-38): under the sidecar lock,
   * then the memory-store lock, the change is checked against the note's
   * revision in the reply's prompt snapshot, recorded as an intent with the
   * before/after hashes, applied atomically, then finalized. Accepting twice
   * is idempotent.
   */
  accept(userId: string, conversationId: string, proposalId: string): Promise<ProposalDto> {
    return this.proposals.withLock(userId, conversationId, async () => {
      const records = await this.proposals.read(userId, conversationId);
      const record = records.find((p) => p.id === proposalId);
      if (!record) throw new AppError(ErrorCode.NOT_FOUND, "Suggestion not found");
      if (record.status === "accepted") return proposalDto(record);
      if (record.intent) {
        const resolved = await this.resolveIntentUnlocked(userId, conversationId, record);
        if (resolved.status === "accepted" || resolved.stale) return this.conflictOr(resolved);
      }
      if (record.status !== "pending")
        throw new AppError(ErrorCode.CONFLICT, "This suggestion is no longer pending");

      return this.memories.withLock(userId, async () => {
        const intent = await this.planUnlocked(userId, record);
        if (!intent) {
          const stale = { ...record, stale: true };
          await this.replace(userId, conversationId, stale);
          throw new AppError(
            ErrorCode.CONFLICT,
            "The memory changed since this suggestion; it was not applied",
          );
        }
        await this.replace(userId, conversationId, { ...record, intent });
        await this.hooks.afterIntent?.();
        await this.memories.applyUnlocked(userId, intent.memoryId, intent.bytes);
        await this.hooks.afterApply?.();
        const accepted: ProposalRecord = {
          ...record,
          status: "accepted",
          decidedAt: this.now().toISOString(),
          intent: null,
        };
        await this.replace(userId, conversationId, accepted);
        return proposalDto(accepted);
      });
    });
  }

  private conflictOr(record: ProposalRecord): ProposalDto {
    if (record.status === "accepted") return proposalDto(record);
    throw new AppError(
      ErrorCode.CONFLICT,
      "The memory changed since this suggestion; it was not applied",
    );
  }

  reject(userId: string, conversationId: string, proposalId: string): Promise<ProposalDto> {
    return this.proposals.withLock(userId, conversationId, async () => {
      const records = await this.proposals.read(userId, conversationId);
      const record = records.find((p) => p.id === proposalId);
      if (!record) throw new AppError(ErrorCode.NOT_FOUND, "Suggestion not found");
      if (record.status === "rejected") return proposalDto(record);
      if (record.status !== "pending" || record.intent)
        throw new AppError(ErrorCode.CONFLICT, "This suggestion is no longer pending");
      const rejected: ProposalRecord = {
        ...record,
        status: "rejected",
        decidedAt: this.now().toISOString(),
      };
      await this.replace(userId, conversationId, rejected);
      return proposalDto(rejected);
    });
  }

  /** The intent for a pending record, or null when its baseline no longer holds. */
  private async planUnlocked(
    userId: string,
    record: ProposalRecord,
  ): Promise<AcceptanceIntent | null> {
    const startedAt = this.now().toISOString();
    if (record.tool === "remember") {
      try {
        const prepared = await this.memories.prepareCreateUnlocked(userId, {
          name: record.name,
          body: record.content ?? "",
        });
        return {
          op: "create",
          memoryId: prepared.memory.id,
          beforeHash: null,
          afterHash: revisionOf(prepared.bytes),
          bytes: prepared.bytes,
          startedAt,
        };
      } catch (error) {
        if (error instanceof MemoryError && error.kind === "duplicate") return null;
        return toAppError(error);
      }
    }
    const target = record.targetMemoryId
      ? await this.memories.get(userId, record.targetMemoryId)
      : null;
    if (!target) return null;
    if (target.revision !== record.baselineRevision) return null;
    if (record.tool === "forget_memory") {
      return {
        op: "delete",
        memoryId: target.id,
        beforeHash: target.revision,
        afterHash: null,
        bytes: null,
        startedAt,
      };
    }
    const prepared = await this.memories
      .prepareUpdateUnlocked(userId, target, record.content ?? "")
      .catch(toAppError);
    return {
      op: "update",
      memoryId: target.id,
      beforeHash: target.revision,
      afterHash: revisionOf(prepared.bytes),
      bytes: prepared.bytes,
      startedAt,
    };
  }

  private async replace(
    userId: string,
    conversationId: string,
    record: ProposalRecord,
  ): Promise<void> {
    const records = await this.proposals.read(userId, conversationId);
    await this.proposals.writeUnlocked(
      userId,
      conversationId,
      records.map((p) => (p.id === record.id ? record : p)),
    );
  }

  /**
   * Startup step 6 and before deletion (contracts §2, §4.3): the after-hash
   * means applied (finalize), the before-hash means not yet applied (apply
   * the recorded bytes, then finalize), anything else is a reported conflict
   * (the suggestion stays pending and is marked stale). Caller holds the
   * sidecar lock.
   */
  private async resolveIntentUnlocked(
    userId: string,
    conversationId: string,
    record: ProposalRecord,
  ): Promise<ProposalRecord> {
    const intent = record.intent;
    if (!intent) return record;
    return this.memories.withLock(userId, async () => {
      const current = await this.memories.revision(userId, intent.memoryId);
      let next: ProposalRecord;
      if (current === intent.afterHash) {
        next = { ...record, status: "accepted", decidedAt: this.now().toISOString(), intent: null };
      } else if (current === intent.beforeHash) {
        await this.memories.applyUnlocked(userId, intent.memoryId, intent.bytes);
        next = { ...record, status: "accepted", decidedAt: this.now().toISOString(), intent: null };
      } else {
        this.logger.warn(
          { proposalId: record.id, conversationId },
          "memory acceptance conflict: the note changed during an interrupted acceptance",
        );
        next = { ...record, stale: true, intent: null };
      }
      await this.replace(userId, conversationId, next);
      return next;
    });
  }

  /** Resolves every acceptance intent of a conversation (under its sidecar lock). */
  resolveIntents(userId: string, conversationId: string): Promise<number> {
    return this.proposals.withLock(userId, conversationId, async () => {
      let resolved = 0;
      for (const record of await this.proposals.read(userId, conversationId)) {
        if (!record.intent) continue;
        await this.resolveIntentUnlocked(userId, conversationId, record);
        resolved++;
      }
      return resolved;
    });
  }

  /** Startup recovery step 6 for one account. */
  async recover(userId: string): Promise<number> {
    let resolved = 0;
    for (const conversationId of await this.proposals.conversations(userId)) {
      resolved += await this.resolveIntents(userId, conversationId);
    }
    return resolved;
  }

  /** After the conversation's Markdown is gone: its sidecar goes too (contracts §4.3). */
  deleteSidecar(userId: string, conversationId: string): Promise<void> {
    return this.proposals.withLock(userId, conversationId, () =>
      this.proposals.deleteUnlocked(userId, conversationId),
    );
  }
}

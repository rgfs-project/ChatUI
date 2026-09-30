import { randomUUID } from "node:crypto";
import { ErrorCode } from "@shared/errors";
import type { ProposalConflict, ProposalDto, ProposalPreview } from "@shared/memories";
import { AppError } from "../errors.ts";
import type { ToolSession } from "../generations/manager.ts";
import type { Logger } from "../logger.ts";
import type { ContinuationMessages } from "../providers/types.ts";
import type { ConversationStore } from "../storage/conversations.ts";
import type { ConversationModel } from "../storage/markdown.ts";
import {
  type MemoryNote,
  type MemorySnapshotEntry,
  type MemoryStore,
} from "../storage/memories.ts";
import { sha256Hex } from "../storage/operations.ts";
import {
  SidecarMalformedError,
  toProposalDto,
  type AcceptanceIntent,
  type ProposalRecord,
  type ProposalStore,
} from "../storage/proposals.ts";
import type { PromptMessage, TokenCounter } from "./prompt.ts";
import { MEMORY_TOOLS, resultFor, validateCalls } from "./memory-tools.ts";
import { isSourceValid } from "./turns.ts";

export interface ProposalHooks {
  /** Crash-simulation hooks at the acceptance write boundaries (tests). */
  afterIntent?: () => void | Promise<void>;
  afterApply?: () => void | Promise<void>;
}

export interface IntentReport {
  applied: number;
  retryable: number;
  conflicts: number;
}

function conflict(reason: ProposalConflict, message: string): AppError {
  return new AppError(ErrorCode.CONFLICT, message, { reason });
}

/** A proposal is answerable only while its exchange stands and its reply is complete. */
export function proposalSourceValid(model: ConversationModel, record: ProposalRecord): boolean {
  if (
    !isSourceValid(model, {
      userMessageId: record.userMessageId,
      assistantMessageId: record.assistantMessageId,
    })
  )
    return false;
  const assistant = model.blocks.find(
    (b) => b.type === "assistant" && b.id === record.assistantMessageId,
  );
  return assistant?.type === "assistant" && assistant.status === "complete";
}

/**
 * Memory proposals (Phase 13b, contracts §4.3). The model only suggests;
 * accepting or rejecting is an authenticated user operation (INV-37) under
 * the §2 lock order conversation → proposal sidecar → memory store, checked
 * against the baseline revision from the generation's prompt snapshot
 * (INV-38), and recoverable through an intent with before/after hashes.
 */
export class ProposalService {
  private readonly o: {
    conversations: ConversationStore;
    proposals: ProposalStore;
    memories: MemoryStore;
    logger: Logger;
    maxToolCalls: number;
    maxToolArgumentBytes: number;
    now?: () => Date;
  };
  hooks: ProposalHooks = {};

  constructor(options: ProposalService["o"]) {
    this.o = options;
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  /**
   * The tool session for one accepted generation. Calls are validated
   * against `snapshot` (the notes its prompt included); duplicates are
   * suppressed against the conversation's sidecar and current memory.
   */
  session(input: {
    userId: string;
    conversationId: string;
    generationId: string;
    userMessageId: string;
    assistantMessageId: string;
    providerId: string;
    model: string;
    snapshot: MemorySnapshotEntry[];
    /** Checks whether the continuation fits (context minus output). */
    fits: (continuation: ContinuationMessages, maxTokens: number) => Promise<boolean>;
  }): ToolSession {
    return {
      tools: MEMORY_TOOLS,
      maxCalls: this.o.maxToolCalls,
      maxArgumentBytes: this.o.maxToolArgumentBytes,
      fits: input.fits,
      record: async (calls) => {
        const current = (await this.o.memories.list(input.userId)).notes;
        const existing = (await this.o.proposals.readUnlocked(input.userId, input.conversationId))
          .records;
        const outcomes = validateCalls(calls, {
          snapshot: input.snapshot,
          current,
          existing,
          base: {
            generationId: input.generationId,
            userMessageId: input.userMessageId,
            assistantMessageId: input.assistantMessageId,
            providerId: input.providerId,
            model: input.model,
          },
          now: this.now(),
          mintId: randomUUID,
        });
        const staged: ProposalRecord[] = [];
        const previews: ProposalPreview[] = [];
        outcomes.forEach((outcome, i) => {
          if (outcome.kind === "invalid") {
            // Logged without content (contracts §4.3).
            this.o.logger.info(
              {
                generationId: input.generationId,
                callIndex: calls[i]?.index,
                reason: outcome.reason,
              },
              "memory proposal call dropped",
            );
            return;
          }
          staged.push(outcome.record);
          previews.push({
            id: outcome.record.id,
            callIndex: outcome.record.callIndex,
            tool: outcome.record.tool,
            name: outcome.record.name,
            content: outcome.record.content,
            status: outcome.kind === "valid" ? "pending" : "suppressed",
          });
        });
        return {
          results: outcomes.map((outcome, i) => ({
            id: calls[i]?.id ?? "",
            content: resultFor(outcome),
          })),
          staged,
          previews,
        };
      },
    };
  }

  /**
   * Terminal sequence step (contracts §4.3): after the assistant write,
   * under the conversation lock, idempotently write the staged proposals —
   * only for a canonically complete reply whose source turn stands.
   */
  async persistStaged(
    userId: string,
    conversationId: string,
    model: ConversationModel,
    staged: readonly ProposalRecord[],
  ): Promise<number> {
    if (staged.length === 0) return 0;
    const first = staged[0];
    if (!first || !proposalSourceValid(model, first)) return 0;
    try {
      return await this.o.proposals.stage(userId, conversationId, staged);
    } catch (error) {
      if (error instanceof SidecarMalformedError) {
        this.o.logger.warn({ conversationId }, "proposals not recorded: sidecar is malformed");
        return 0;
      }
      throw error;
    }
  }

  async list(userId: string, conversationId: string): Promise<ProposalDto[]> {
    if ((await this.o.conversations.readUnlocked(userId, conversationId)).kind === "missing")
      throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
    return (await this.o.proposals.list(userId, conversationId)).map(toProposalDto);
  }

  /** The conversation's proposal DTOs for its conversation DTO (caller checked ownership). */
  async dtos(userId: string, conversationId: string): Promise<ProposalDto[]> {
    return (await this.o.proposals.list(userId, conversationId)).map(toProposalDto);
  }

  /** Edit / regenerate / delete exchange: pending proposals of removed sources become invalid. */
  invalidateStale(userId: string, conversationId: string, model: ConversationModel) {
    return this.o.proposals
      .invalidateStale(userId, conversationId, model, proposalSourceValid, this.now())
      .catch((error: unknown) => {
        // Validity is rechecked at acceptance anyway (contracts §4.2).
        this.o.logger.warn({ err: error, conversationId }, "invalidating proposals failed");
        return 0;
      });
  }

  /** Accept (INV-37, INV-38). Idempotent for an already accepted proposal. */
  accept(userId: string, conversationId: string, proposalId: string): Promise<ProposalDto> {
    return this.o.conversations.withLock(userId, conversationId, () =>
      this.o.proposals.withLock(userId, conversationId, () =>
        this.o.memories.withLock(userId, async () => {
          const read = await this.o.conversations.readUnlocked(userId, conversationId);
          if (read.kind === "missing")
            throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
          const sidecar = await this.o.proposals.readUnlocked(userId, conversationId);
          if (sidecar.malformed)
            throw new AppError(ErrorCode.INTERNAL, "The suggestions of this chat can't be read");
          let records = sidecar.records;
          let record = records.find((r) => r.id === proposalId);
          if (!record) throw new AppError(ErrorCode.NOT_FOUND, "Suggestion not found");
          if (record.intent) {
            // An interrupted earlier attempt: settle it by hashes first.
            records = await this.settleIntents(userId, conversationId, records);
            record = records.find((r) => r.id === proposalId) ?? record;
          }
          if (record.status === "accepted") return toProposalDto(record);
          if (record.status !== "pending")
            throw conflict("not_actionable", "This suggestion can no longer be saved");
          if (read.kind === "malformed" || !proposalSourceValid(read.conversation.model, record)) {
            const invalid = { ...record, status: "invalid" as const, decidedAt: this.now() };
            await this.save(userId, conversationId, records, invalid);
            throw conflict(
              "source_removed",
              "The message this suggestion came from was changed or removed",
            );
          }
          const plan = await this.plan(userId, record);
          const intent: AcceptanceIntent = {
            memoryId: plan.memoryId,
            beforeHash: plan.beforeHash,
            afterHash: plan.bytes ? sha256Hex(plan.bytes) : null,
            startedAt: this.now(),
          };
          const withIntent = await this.save(userId, conversationId, records, {
            ...record,
            intent,
          });
          await this.hooks.afterIntent?.();
          if (plan.bytes) await this.o.memories.writeUnlocked(userId, plan.bytes, plan.memoryId);
          else await this.o.memories.deleteUnlocked(userId, plan.memoryId);
          await this.hooks.afterApply?.();
          const accepted: ProposalRecord = {
            ...record,
            status: "accepted",
            decidedAt: this.now(),
            resultMemoryId: plan.bytes ? plan.memoryId : null,
            intent: null,
          };
          await this.save(userId, conversationId, withIntent, accepted);
          return toProposalDto(accepted);
        }),
      ),
    );
  }

  /** The conditional change an acceptance makes, checked against the baseline. */
  private async plan(
    userId: string,
    record: ProposalRecord,
  ): Promise<{ memoryId: string; beforeHash: string | null; bytes: Buffer | null }> {
    const { notes } = await this.o.memories.list(userId);
    const at = this.now();
    if (record.tool === "create") {
      const note: MemoryNote = {
        id: randomUUID(),
        name: record.name,
        content: record.content ?? "",
        createdAt: at,
        updatedAt: at,
      };
      try {
        this.o.memories.assertFits(notes, note);
      } catch (error) {
        if (error instanceof AppError && error.code === ErrorCode.CONFLICT)
          throw conflict("name_taken", `A memory named "${record.name}" already exists`);
        throw error;
      }
      return { memoryId: note.id, beforeHash: null, bytes: this.o.memories.bytesOf(note) };
    }
    const targetId = record.targetMemoryId ?? "";
    const current = targetId ? await this.o.memories.read(userId, targetId) : null;
    if (!current) throw conflict("note_missing", "The memory this suggestion changes was removed");
    if (current.revision !== record.baselineRevision)
      throw conflict(
        "note_changed",
        "The memory changed since this suggestion was made; it was not overwritten",
      );
    if (record.tool === "forget")
      return { memoryId: current.id, beforeHash: current.revision, bytes: null };
    const note: MemoryNote = {
      id: current.id,
      name: current.name,
      content: record.content ?? current.content,
      createdAt: current.createdAt,
      updatedAt: at,
    };
    this.o.memories.assertFits(notes, note, current.id);
    return {
      memoryId: current.id,
      beforeHash: current.revision,
      bytes: this.o.memories.bytesOf(note),
    };
  }

  /** Reject (INV-37). Idempotent for an already rejected proposal. */
  reject(userId: string, conversationId: string, proposalId: string): Promise<ProposalDto> {
    return this.o.conversations.withLock(userId, conversationId, () =>
      this.o.proposals.withLock(userId, conversationId, async () => {
        if ((await this.o.conversations.readUnlocked(userId, conversationId)).kind === "missing")
          throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
        const sidecar = await this.o.proposals.readUnlocked(userId, conversationId);
        if (sidecar.malformed)
          throw new AppError(ErrorCode.INTERNAL, "The suggestions of this chat can't be read");
        const record = sidecar.records.find((r) => r.id === proposalId);
        if (!record) throw new AppError(ErrorCode.NOT_FOUND, "Suggestion not found");
        if (record.status === "rejected") return toProposalDto(record);
        if (record.status !== "pending" || record.intent)
          throw conflict("not_actionable", "This suggestion can no longer be dismissed");
        const rejected = { ...record, status: "rejected" as const, decidedAt: this.now() };
        await this.save(userId, conversationId, sidecar.records, rejected);
        return toProposalDto(rejected);
      }),
    );
  }

  private async save(
    userId: string,
    conversationId: string,
    records: readonly ProposalRecord[],
    changed: ProposalRecord,
  ): Promise<ProposalRecord[]> {
    const next = records.map((r) => (r.id === changed.id ? changed : r));
    await this.o.proposals.writeUnlocked(userId, conversationId, next);
    return next;
  }

  /**
   * Settles acceptance intents by hashes (contracts §4.3; startup step 6 and
   * conversation deletion). The note equals the after-hash → applied,
   * finalize `accepted`; equals the before-hash → never applied, the
   * proposal stays pending and can be retried; anything else is a reported
   * conflict (left pending, intent cleared; the note is never overwritten).
   * Caller holds the sidecar and memory locks.
   */
  private async settleIntents(
    userId: string,
    conversationId: string,
    records: ProposalRecord[],
    report?: IntentReport,
  ): Promise<ProposalRecord[]> {
    let changed = false;
    const next: ProposalRecord[] = [];
    for (const record of records) {
      const intent = record.intent;
      if (!intent) {
        next.push(record);
        continue;
      }
      changed = true;
      const hash = await this.o.memories.fileHash(userId, intent.memoryId);
      if (hash === intent.afterHash) {
        next.push({
          ...record,
          status: "accepted",
          decidedAt: record.decidedAt ?? this.now(),
          resultMemoryId: intent.afterHash ? intent.memoryId : null,
          intent: null,
        });
        if (report) report.applied++;
      } else if (hash === intent.beforeHash) {
        next.push({ ...record, intent: null });
        if (report) report.retryable++;
      } else {
        this.o.logger.warn(
          { conversationId, proposalId: record.id },
          "memory acceptance recovery conflict: the note matches neither the before nor the after hash; left untouched",
        );
        next.push({ ...record, intent: null });
        if (report) report.conflicts++;
      }
    }
    if (changed) await this.o.proposals.writeUnlocked(userId, conversationId, next);
    return next;
  }

  /**
   * Conversation deletion (contracts §4.3): pending acceptance intents are
   * settled before the Markdown is deleted. Caller holds the conversation lock.
   */
  async reconcileBeforeDelete(userId: string, conversationId: string): Promise<void> {
    await this.o.proposals.withLock(userId, conversationId, () =>
      this.o.memories.withLock(userId, async () => {
        const sidecar = await this.o.proposals.readUnlocked(userId, conversationId);
        if (sidecar.malformed || !sidecar.records.some((r) => r.intent)) return;
        await this.settleIntents(userId, conversationId, sidecar.records);
      }),
    );
  }

  /** Startup recovery step 6 for one account (contracts §2). */
  async recoverIntents(userId: string): Promise<IntentReport> {
    const report: IntentReport = { applied: 0, retryable: 0, conflicts: 0 };
    for (const conversationId of await this.o.proposals.conversations(userId)) {
      await this.o.conversations.withLock(userId, conversationId, () =>
        this.o.proposals.withLock(userId, conversationId, () =>
          this.o.memories.withLock(userId, async () => {
            const sidecar = await this.o.proposals.readUnlocked(userId, conversationId);
            if (sidecar.malformed || !sidecar.records.some((r) => r.intent)) return;
            await this.settleIntents(userId, conversationId, sidecar.records, report);
          }),
        ),
      );
    }
    return report;
  }
}

/** Token cost of the continuation's extra messages (tool-call message + results). */
export async function continuationCost(
  counter: TokenCounter,
  continuation: ContinuationMessages,
): Promise<number> {
  const messages: PromptMessage[] = [
    {
      role: "assistant",
      content: `${continuation.assistantContent}${JSON.stringify(continuation.calls)}`,
    },
    // Tool results are counted like user messages (same template overhead).
    ...continuation.results.map((r) => ({ role: "user" as const, content: r.content })),
  ];
  return counter.countGroup(messages);
}

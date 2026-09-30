// Startup recovery, Phase 3 steps of contracts §2. Loadable natively by Node.
import { readdir } from "node:fs/promises";
import type { ChatIndex, IndexLogger } from "./chat-index.ts";
import { cleanupTempFiles, ensureDir, readOrNull } from "./fs.ts";
import type { CheckpointOutcome, CheckpointStore } from "./checkpoints.ts";
import type { ConversationStore } from "./conversations.ts";
import {
  normalizeBody,
  type AssistantStatus,
  type Block,
  type ConversationModel,
} from "./markdown.ts";
import type { GenerationCheckpoint } from "./checkpoints.ts";
import { sha256Hex, type OperationRecord, type OperationStore } from "./operations.ts";
import { isUuid, SYSTEM_DIR, type DataPaths } from "./paths.ts";

export interface RecoveryReport {
  tempFilesRemoved: number;
  unexpectedEntries: string[];
  operationsCommitted: number;
  operationsRolledBack: number;
  operationConflicts: number;
  operationsExpired: number;
  generations: GenerationRecoveryReport | null;
  attachments: { incompleteRemoved: number; linked: number; collected: number } | null;
  memoryIntents: { applied: number; retryable: number; conflicts: number } | null;
  artifacts: { incompleteRemoved: number; unfinalizedRemoved: number } | null;
}

/** Top-level entries must be user UUIDs, `_system` or `.gitkeep` (logged, never deleted). */
async function unexpectedTopLevel(paths: DataPaths): Promise<string[]> {
  const entries = await readdir(paths.root).catch(() => [] as string[]);
  return entries.filter((name) => !isUuid(name) && name !== SYSTEM_DIR && name !== ".gitkeep");
}

export async function userIds(paths: DataPaths): Promise<string[]> {
  const entries = await readdir(paths.root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && isUuid(entry.name))
    .map((entry) => entry.name);
}

/**
 * Account directories: a UUID directory holding user.json. Anything else
 * (e.g. an old pre-auth demo directory) is never read or written (§6).
 */
export async function accountIds(paths: DataPaths): Promise<string[]> {
  const ids: string[] = [];
  for (const id of await userIds(paths)) {
    if ((await readOrNull(paths.userFile(id))) !== null) ids.push(id);
  }
  return ids;
}

/**
 * Decides one pending acceptance record by hashes (contracts §4.1 step 5).
 * Also used in-process when acceptance fails part-way.
 */
export async function resolvePendingRecord(
  paths: DataPaths,
  operations: OperationStore,
  userId: string,
  record: OperationRecord,
  now: Date,
): Promise<"committed" | "rolled_back" | "conflict"> {
  if (!isUuid(record.conversationId)) return "conflict";
  const bytes = await readOrNull(paths.chatFile(userId, record.conversationId));
  const hash = bytes ? sha256Hex(bytes) : null;
  if (hash === record.afterHash) {
    await operations.write(userId, {
      ...record,
      status: "committed",
      committedAt: now.toISOString(),
    });
    return "committed";
  }
  if (hash === record.beforeHash) {
    await operations.delete(userId, record.operationKey);
    return "rolled_back";
  }
  return "conflict";
}

/**
 * Resolves pending acceptance records by hashes (§4.1 step 5): the
 * conversation equals the after-hash → committed; equals the before-hash (or
 * is absent for a first send) → never happened, delete the record; anything
 * else is a reported conflict and the conversation is never overwritten. A
 * deleted conversation is never recreated.
 */
export async function resolveOperations(
  paths: DataPaths,
  operations: OperationStore,
  userId: string,
  logger: IndexLogger,
  retentionMs: number,
  now: Date,
): Promise<
  Pick<
    RecoveryReport,
    "operationsCommitted" | "operationsRolledBack" | "operationConflicts" | "operationsExpired"
  >
> {
  const report = {
    operationsCommitted: 0,
    operationsRolledBack: 0,
    operationConflicts: 0,
    operationsExpired: 0,
  };
  for (const record of await operations.all(userId)) {
    if (record.status === "committed") {
      const committedAt = Date.parse(record.committedAt ?? record.createdAt);
      if (now.getTime() - committedAt > retentionMs) {
        await operations.delete(userId, record.operationKey);
        report.operationsExpired++;
      }
      continue;
    }
    const outcome = await resolvePendingRecord(paths, operations, userId, record, now);
    if (outcome === "committed") report.operationsCommitted++;
    else if (outcome === "rolled_back") report.operationsRolledBack++;
    else {
      logger.warn(
        { conversationId: record.conversationId, generationId: record.generationId },
        "operation recovery conflict: conversation matches neither the before nor the after hash; left untouched",
      );
      report.operationConflicts++;
    }
  }
  return report;
}

/**
 * Startup recovery in contracts §2 order: (1) temp files, (4) pending
 * operation records, (5) generation checkpoints, (7) attachments, (8) derived
 * indexes. Runs before requests are accepted.
 */
export async function recoverStorage(options: {
  paths: DataPaths;
  operations: OperationStore;
  index: ChatIndex;
  logger: IndexLogger;
  retentionMs: number;
  startedAt: Date;
  now?: Date;
  generations?: {
    store: ConversationStore;
    checkpoints: CheckpointStore;
    retentionMs: number;
    /**
     * Writes a completed checkpoint's staged proposals (13b) and source
     * captures (13c), under the conversation lock after the reply.
     */
    staged?: StageRecords;
  };
  /** Step 6 per account (Phase 13b): settle memory acceptance intents by hashes. */
  memoryIntents?: (
    userId: string,
  ) => Promise<{ applied: number; retryable: number; conflicts: number }>;
  /** Step 7 per account (Phase 12): reconcile links, GC pending attachments. */
  attachments?: (
    userId: string,
  ) => Promise<{ incompleteRemoved: number; linked: number; collected: number }>;
  /** Step 7 per account (Phase 13c): remove interrupted and orphaned artifact captures. */
  artifacts?: (
    userId: string,
  ) => Promise<{ incompleteRemoved: number; unfinalizedRemoved: number }>;
}): Promise<RecoveryReport> {
  const { paths, logger } = options;
  await ensureDir(paths.root);
  const tempFilesRemoved = await cleanupTempFiles(paths.root, options.startedAt);
  const unexpectedEntries = await unexpectedTopLevel(paths);
  for (const name of unexpectedEntries)
    logger.warn({ entry: name }, "ignoring unexpected entry in DATA_DIR");
  const totals = {
    operationsCommitted: 0,
    operationsRolledBack: 0,
    operationConflicts: 0,
    operationsExpired: 0,
  };
  const users = await accountIds(paths);
  for (const userId of users) {
    const r = await resolveOperations(
      paths,
      options.operations,
      userId,
      logger,
      options.retentionMs,
      options.now ?? new Date(),
    );
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += r[key];
  }
  // Step 5: generation checkpoints and committed operations without a reply.
  const generations = options.generations
    ? await recoverGenerations({
        ...options.generations,
        paths,
        operations: options.operations,
        logger,
        now: options.now ?? new Date(),
      })
    : null;
  // Step 6: memory acceptance intents.
  let memoryIntents: RecoveryReport["memoryIntents"] = null;
  if (options.memoryIntents) {
    memoryIntents = { applied: 0, retryable: 0, conflicts: 0 };
    for (const userId of users) {
      const r = await options.memoryIntents(userId);
      memoryIntents.applied += r.applied;
      memoryIntents.retryable += r.retryable;
      memoryIntents.conflicts += r.conflicts;
    }
  }
  let attachments: RecoveryReport["attachments"] = null;
  if (options.attachments) {
    attachments = { incompleteRemoved: 0, linked: 0, collected: 0 };
    for (const userId of users) {
      const r = await options.attachments(userId);
      attachments.incompleteRemoved += r.incompleteRemoved;
      attachments.linked += r.linked;
      attachments.collected += r.collected;
    }
  }
  let artifacts: RecoveryReport["artifacts"] = null;
  if (options.artifacts) {
    artifacts = { incompleteRemoved: 0, unfinalizedRemoved: 0 };
    for (const userId of users) {
      const r = await options.artifacts(userId);
      artifacts.incompleteRemoved += r.incompleteRemoved;
      artifacts.unfinalizedRemoved += r.unfinalizedRemoved;
    }
  }
  // Step 8: derived indexes.
  for (const userId of users) await options.index.load(userId);
  const report = {
    tempFilesRemoved,
    unexpectedEntries,
    ...totals,
    generations,
    memoryIntents,
    attachments,
    artifacts,
  };
  logger.info(report, "storage recovery complete");
  return report;
}

const STATUS: Record<CheckpointOutcome["state"] | "interrupted", AssistantStatus> = {
  completed: "complete",
  cancelled: "cancelled",
  failed: "failed",
  timed_out: "timed_out",
  interrupted: "interrupted",
};

/**
 * Appends the reasoning (if any) and assistant block exactly once, under the
 * conversation lock. Never recreates a missing conversation and never touches
 * a malformed one. Idempotent by assistant id.
 */
async function writeReplyOnce(
  store: ConversationStore,
  input: {
    userId: string;
    conversationId: string;
    assistantMessageId: string;
    providerId: string;
    model: string;
    status: AssistantStatus;
    content: string;
    reasoning: string;
    time: string;
    /** The source user block; the reply is written only while it is still last (INV-35). */
    userMessageId: string | null;
  },
  /** Runs under the same lock once the reply is (or already was) in the file. */
  after?: (model: ConversationModel) => Promise<void>,
): Promise<"written" | "exists" | "missing" | "malformed" | "superseded"> {
  return store.withLock(input.userId, input.conversationId, async () => {
    const read = await store.readUnlocked(input.userId, input.conversationId);
    if (read.kind === "missing") return "missing";
    if (read.kind === "malformed") return "malformed";
    const model = read.conversation.model;
    if (model.blocks.some((b) => b.type === "assistant" && b.id === input.assistantMessageId)) {
      await after?.(model);
      return "exists";
    }
    const last = model.blocks.at(-1);
    if (input.userMessageId !== null && (last?.type !== "user" || last.id !== input.userMessageId))
      return "superseded";
    const blocks: Block[] = [];
    const reasoning = normalizeBody(input.reasoning);
    if (reasoning !== "")
      blocks.push({ type: "reasoning", id: input.assistantMessageId, body: reasoning });
    blocks.push({
      type: "assistant",
      id: input.assistantMessageId,
      status: input.status,
      ...(input.providerId ? { provider: input.providerId } : {}),
      ...(input.model ? { model: input.model } : {}),
      time: input.time,
      body: normalizeBody(input.content),
    });
    const written = await store.writeUnlocked(
      input.userId,
      input.conversationId,
      store.appendBlocks(model, blocks),
    );
    await after?.(written.model);
    return "written";
  });
}

/**
 * Idempotently writes a completed checkpoint's staged records: proposals
 * keyed by `(generationId, callIndex)`, then artifacts keyed by
 * `(assistantMessageId, captureIndex)` (contracts §4.3). Called under the
 * conversation lock with the canonical model after the reply write.
 */
export type StageRecords = (
  checkpoint: GenerationCheckpoint,
  model: ConversationModel,
) => Promise<void>;

export interface GenerationRecoveryReport {
  interrupted: number;
  completedDecided: number;
  orphanCommits: number;
  alreadyWritten: number;
  discarded: number;
  finalizedRemoved: number;
}

/**
 * Startup step 5 (contracts §2, §4, INV-21, INV-60): `running` checkpoints are
 * written once as `interrupted` with their partial output; `terminal-decided`
 * checkpoints are completed once with their recorded outcome; committed
 * operations with `terminalWritten: false` and no checkpoint get one empty
 * `interrupted` reply. The `terminalWritten` flag (not the absence of a block)
 * decides, so a reply the user later deleted is never re-added.
 */
export async function recoverGenerations(options: {
  paths: DataPaths;
  store: ConversationStore;
  operations: OperationStore;
  checkpoints: CheckpointStore;
  logger: IndexLogger;
  retentionMs: number;
  now: Date;
  staged?: StageRecords;
}): Promise<GenerationRecoveryReport> {
  const { store, operations, checkpoints, logger, now } = options;
  const report: GenerationRecoveryReport = {
    interrupted: 0,
    completedDecided: 0,
    orphanCommits: 0,
    alreadyWritten: 0,
    discarded: 0,
    finalizedRemoved: 0,
  };
  const markWritten = async (userId: string, operationKey: string) => {
    if (!operationKey) return;
    const record = await operations.read(userId, operationKey).catch(() => null);
    if (record && !record.terminalWritten)
      await operations.write(userId, { ...record, terminalWritten: true });
  };
  const withCheckpoint = new Set<string>();
  for (const checkpoint of await checkpoints.all()) {
    withCheckpoint.add(checkpoint.generationId);
    if (checkpoint.state === "terminal") {
      if (now.getTime() - Date.parse(checkpoint.updatedAt) > options.retentionMs) {
        await checkpoints.delete(checkpoint.generationId);
        report.finalizedRemoved++;
      }
      continue;
    }
    const decided =
      checkpoint.state === "terminal-decided" && checkpoint.outcome !== null
        ? checkpoint.outcome
        : null;
    const source = checkpoint.operationKey
      ? await operations.read(checkpoint.userId, checkpoint.operationKey).catch(() => null)
      : null;
    // Staged proposals and captures survive only a completed outcome
    // (contracts §4.3); a `running` checkpoint's are discarded with the
    // interrupted reply. Nothing else is ever scanned for captures.
    const stage =
      decided?.state === "completed" &&
      (decided.proposals?.length ?? 0) + (decided.captures?.length ?? 0) > 0 &&
      options.staged
        ? options.staged
        : undefined;
    const result = await writeReplyOnce(
      store,
      {
        userId: checkpoint.userId,
        conversationId: checkpoint.conversationId,
        assistantMessageId: checkpoint.assistantMessageId,
        providerId: checkpoint.providerId,
        model: checkpoint.model,
        status: STATUS[decided ? decided.state : "interrupted"],
        content: decided ? decided.content : checkpoint.content,
        reasoning: decided ? decided.reasoning : checkpoint.reasoning,
        time: decided ? decided.finishedAt : now.toISOString(),
        userMessageId: source?.userMessageId ?? null,
      },
      stage ? (model) => stage(checkpoint, model) : undefined,
    );
    if (result === "written") {
      if (decided) report.completedDecided++;
      else report.interrupted++;
    } else if (result === "exists") {
      report.alreadyWritten++;
    } else {
      report.discarded++;
      logger.info(
        { generationId: checkpoint.generationId, reason: result },
        "recovered reply discarded",
      );
    }
    await markWritten(checkpoint.userId, checkpoint.operationKey);
    await checkpoints.write({ ...checkpoint, state: "terminal", updatedAt: now.toISOString() });
  }
  for (const userId of await accountIds(options.paths)) {
    for (const record of await operations.all(userId)) {
      if (
        record.status !== "committed" ||
        record.terminalWritten ||
        withCheckpoint.has(record.generationId)
      )
        continue;
      const result = await writeReplyOnce(store, {
        userId,
        conversationId: record.conversationId,
        assistantMessageId: record.assistantMessageId,
        providerId: "",
        model: "",
        status: "interrupted",
        content: "",
        reasoning: "",
        time: now.toISOString(),
        userMessageId: record.userMessageId,
      });
      if (result === "written") report.orphanCommits++;
      await operations.write(userId, { ...record, terminalWritten: true });
    }
  }
  if (report.interrupted + report.completedDecided + report.orphanCommits + report.discarded > 0) {
    logger.info({ ...report }, "generation recovery complete");
  }
  return report;
}

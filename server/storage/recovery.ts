// Startup recovery, Phase 3 steps of contracts §2. Loadable natively by Node.
import { readdir } from "node:fs/promises";
import type { ChatIndex, IndexLogger } from "./chat-index.ts";
import { cleanupTempFiles, ensureDir, readOrNull } from "./fs.ts";
import { sha256Hex, type OperationRecord, type OperationStore } from "./operations.ts";
import { isUuid, SYSTEM_DIR, type DataPaths } from "./paths.ts";

export interface RecoveryReport {
  tempFilesRemoved: number;
  unexpectedEntries: string[];
  operationsCommitted: number;
  operationsRolledBack: number;
  operationConflicts: number;
  operationsExpired: number;
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
 * Phase 3 startup recovery in contracts §2 order: (1) temp files, (4) pending
 * operation records, (8) derived indexes. Runs before requests are accepted.
 */
export async function recoverStorage(options: {
  paths: DataPaths;
  operations: OperationStore;
  index: ChatIndex;
  logger: IndexLogger;
  retentionMs: number;
  startedAt: Date;
  now?: Date;
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
  for (const userId of users) await options.index.load(userId);
  const report = { tempFilesRemoved, unexpectedEntries, ...totals };
  logger.info(report, "storage recovery complete");
  return report;
}

// Generated source artifacts (Phase 13c, contracts §1, §12): `artifacts/<uuid>/{blob,meta.json}`.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ArtifactSummary, MessageArtifactDto } from "@shared/artifacts";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { displayMediaType, type StagedCapture } from "../artifacts/capture.ts";
import type { AccountWrites } from "./account.ts";
import { atomicWrite, ensureDir, listDir, readOrNull } from "./fs.ts";
import type { KeyedLocks } from "./locks.ts";
import { sha256Hex } from "./operations.ts";
import { isUuid, type DataPaths } from "./paths.ts";

export interface ArtifactMeta {
  version: 1;
  id: string;
  /** Display only; never a path. */
  name: string;
  language: string | null;
  /** Display media type from the extension; the source is always served as text/plain. */
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
  /** `generated` by a reply (13c); `imported` is reserved for Phase 13d. */
  source: "generated" | "imported";
  /** Backlink and the stable capture key `(assistantMessageId, captureIndex)`. */
  conversationId: string | null;
  assistantMessageId: string | null;
  generationId: string | null;
  captureIndex: number | null;
  /** Listable, viewable and deletable only once finalized (contracts §4.3). */
  finalized: boolean;
}

export interface ArtifactConfig {
  /** One file's bytes. */
  maxBytes: number;
  /** Captures per reply. */
  maxPerReply: number;
  /** All of a user's artifacts. */
  quotaBytes: number;
}

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
  maxBytes: 256 * 1024,
  maxPerReply: 16,
  quotaBytes: 100 * 1024 * 1024,
};

export interface ArtifactHooks {
  /** Test hook: after an artifact's blob and unfinalized metadata are written. */
  afterCreate?: () => void | Promise<void>;
}

function isMeta(value: unknown, id: string): value is ArtifactMeta {
  const m = value as Partial<ArtifactMeta> | null;
  return (
    typeof m === "object" &&
    m !== null &&
    m.version === 1 &&
    m.id === id &&
    typeof m.name === "string" &&
    typeof m.size === "number" &&
    typeof m.sha256 === "string" &&
    typeof m.finalized === "boolean" &&
    (m.source === "generated" || m.source === "imported")
  );
}

export interface CaptureContext {
  conversationId: string;
  assistantMessageId: string;
  generationId: string;
}

export interface ArtifactReconcileReport {
  incompleteRemoved: number;
  unfinalizedRemoved: number;
}

/**
 * A user's artifacts. Every write holds the artifact's lock (after any
 * conversation lock, contracts §2) and the account-write guard. Bytes are
 * written before metadata, so a directory without `meta.json` is an
 * interrupted capture, removed at startup. A per-user catalog of metadata
 * is kept in memory (derived; rebuilt from the files on first use).
 */
export class ArtifactStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly writes: AccountWrites | undefined;
  private readonly logger: Logger;
  private readonly now: () => Date;
  readonly config: ArtifactConfig;
  hooks: ArtifactHooks = {};
  private readonly catalogs = new Map<string, Promise<Map<string, ArtifactMeta>>>();

  constructor(options: {
    paths: DataPaths;
    locks: KeyedLocks;
    writes?: AccountWrites;
    logger: Logger;
    config?: Partial<ArtifactConfig>;
    now?: () => Date;
  }) {
    this.paths = options.paths;
    this.locks = options.locks;
    this.writes = options.writes;
    this.logger = options.logger;
    this.config = { ...DEFAULT_ARTIFACT_CONFIG, ...options.config };
    this.now = options.now ?? (() => new Date());
  }

  private guarded<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.writes ? this.writes.run(userId, fn) : fn();
  }

  private lock<T>(userId: string, id: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(`artifact:${userId}/${id}`, fn);
  }

  async readMeta(userId: string, id: string): Promise<ArtifactMeta | null> {
    const bytes = await readOrNull(this.paths.artifactMeta(userId, id));
    if (!bytes) return null;
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      return isMeta(parsed, id) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Every readable metadata file, finalized or not. */
  private catalog(userId: string): Promise<Map<string, ArtifactMeta>> {
    let loaded = this.catalogs.get(userId);
    if (!loaded) {
      loaded = (async () => {
        const map = new Map<string, ArtifactMeta>();
        for (const name of await listDir(this.paths.artifactsDir(userId))) {
          if (!isUuid(name)) continue;
          const meta = await this.readMeta(userId, name);
          if (meta) map.set(meta.id, meta);
        }
        return map;
      })();
      this.catalogs.set(userId, loaded);
      loaded.catch(() => {
        this.catalogs.delete(userId);
      });
    }
    return loaded;
  }

  /** Account closure or tests: forget the derived catalog. */
  forget(userId: string): void {
    this.catalogs.delete(userId);
  }

  /** Finalized artifacts, newest first; one reply's files in capture order. */
  async list(userId: string): Promise<ArtifactMeta[]> {
    return [...(await this.catalog(userId)).values()]
      .filter((m) => m.finalized)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          (a.assistantMessageId ?? "").localeCompare(b.assistantMessageId ?? "") ||
          (a.captureIndex ?? 0) - (b.captureIndex ?? 0) ||
          a.id.localeCompare(b.id),
      );
  }

  async usedBytes(userId: string): Promise<number> {
    let total = 0;
    for (const meta of (await this.catalog(userId)).values()) total += meta.size;
    return total;
  }

  /** A finalized artifact, or null (unfinalized ones don't exist for users). */
  async get(userId: string, id: string): Promise<ArtifactMeta | null> {
    const meta = await this.readMeta(userId, id);
    return meta?.finalized ? meta : null;
  }

  async require(userId: string, id: string): Promise<ArtifactMeta> {
    const meta = await this.get(userId, id);
    if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "File not found");
    return meta;
  }

  async readSource(userId: string, id: string): Promise<Buffer | null> {
    return readOrNull(this.paths.artifactBlob(userId, id));
  }

  /** Transcript cards of a conversation: finalized artifacts it produced. */
  async forConversation(userId: string, conversationId: string): Promise<MessageArtifactDto[]> {
    const out: MessageArtifactDto[] = [];
    for (const meta of (await this.catalog(userId)).values()) {
      if (
        !meta.finalized ||
        meta.conversationId !== conversationId ||
        meta.assistantMessageId === null ||
        meta.captureIndex === null
      )
        continue;
      out.push({
        id: meta.id,
        name: meta.name,
        language: meta.language,
        size: meta.size,
        assistantMessageId: meta.assistantMessageId,
        captureIndex: meta.captureIndex,
      });
    }
    return out.sort((a, b) =>
      a.assistantMessageId === b.assistantMessageId
        ? a.captureIndex - b.captureIndex
        : a.assistantMessageId < b.assistantMessageId
          ? -1
          : 1,
    );
  }

  /** The artifact with the capture key `(assistantMessageId, captureIndex)`, if any. */
  private async byKey(
    userId: string,
    assistantMessageId: string,
    captureIndex: number,
  ): Promise<ArtifactMeta | undefined> {
    for (const meta of (await this.catalog(userId)).values())
      if (meta.assistantMessageId === assistantMessageId && meta.captureIndex === captureIndex)
        return meta;
    return undefined;
  }

  private async writeMeta(userId: string, meta: ArtifactMeta): Promise<void> {
    await this.guarded(userId, () =>
      atomicWrite(this.paths.artifactMeta(userId, meta.id), `${JSON.stringify(meta, null, 2)}\n`),
    );
    (await this.catalog(userId)).set(meta.id, meta);
  }

  /**
   * Terminal sequence step (contracts §4.3), caller holds the conversation
   * lock: writes each staged capture idempotently by `(assistantMessageId,
   * captureIndex)` — an existing artifact with that key is kept — bytes
   * first, then unfinalized metadata; then finalizes them all. Captures over
   * the user's quota are skipped (logged without content).
   */
  async captureStaged(
    userId: string,
    context: CaptureContext,
    staged: readonly StagedCapture[],
  ): Promise<ArtifactMeta[]> {
    const written: ArtifactMeta[] = [];
    // One reply's files share a timestamp (they list together, in capture order).
    const createdAt = this.now().toISOString();
    for (const capture of staged) {
      const existing = await this.byKey(userId, context.assistantMessageId, capture.captureIndex);
      if (existing) {
        written.push(existing);
        continue;
      }
      const bytes = Buffer.from(capture.content, "utf8");
      if ((await this.usedBytes(userId)) + bytes.length > this.config.quotaBytes) {
        this.logger.warn(
          { userId, assistantMessageId: context.assistantMessageId, index: capture.captureIndex },
          "artifact not captured: storage quota reached",
        );
        continue;
      }
      const meta: ArtifactMeta = {
        version: 1,
        id: randomUUID(),
        name: capture.name,
        language: capture.language,
        mediaType: displayMediaType(capture.name),
        size: bytes.length,
        sha256: sha256Hex(bytes),
        createdAt,
        source: "generated",
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        generationId: context.generationId,
        captureIndex: capture.captureIndex,
        finalized: false,
      };
      await this.lock(userId, meta.id, async () => {
        await this.guarded(userId, async () => {
          await ensureDir(this.paths.artifactDir(userId, meta.id));
          await atomicWrite(this.paths.artifactBlob(userId, meta.id), bytes);
        });
        await this.writeMeta(userId, meta);
      });
      await this.hooks.afterCreate?.();
      written.push(meta);
    }
    for (const meta of written) {
      if (meta.finalized) continue;
      await this.lock(userId, meta.id, async () => {
        const current = await this.readMeta(userId, meta.id);
        if (current && !current.finalized)
          await this.writeMeta(userId, { ...current, finalized: true });
      });
    }
    return written;
  }

  /**
   * Deletes a finalized artifact. `beforeRemove` runs under the artifact lock
   * first: it marks the originating generation's checkpoint `terminal`, so
   * no recovery can recreate what the user deleted (INV-40).
   */
  async delete(
    userId: string,
    id: string,
    beforeRemove?: (meta: ArtifactMeta) => Promise<void>,
  ): Promise<void> {
    await this.lock(userId, id, async () => {
      const meta = await this.get(userId, id);
      if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "File not found");
      await beforeRemove?.(meta);
      await this.guarded(userId, () =>
        rm(this.paths.artifactDir(userId, id), { recursive: true, force: true }),
      );
      (await this.catalog(userId)).delete(id);
    });
  }

  /**
   * Startup cleanup (after generation recovery, contracts §2 step 7):
   * directories without metadata are interrupted captures and are removed;
   * unfinalized artifacts whose generation has no open `terminal-decided`
   * checkpoint can never be finalized and are removed too.
   */
  async reconcile(userId: string, open: ReadonlySet<string>): Promise<ArtifactReconcileReport> {
    const report: ArtifactReconcileReport = { incompleteRemoved: 0, unfinalizedRemoved: 0 };
    for (const name of await listDir(this.paths.artifactsDir(userId))) {
      if (!isUuid(name)) continue;
      const hasMeta = (await readOrNull(this.paths.artifactMeta(userId, name))) !== null;
      const meta = hasMeta ? await this.readMeta(userId, name) : null;
      if (!hasMeta) {
        await this.guarded(userId, () =>
          rm(this.paths.artifactDir(userId, name), { recursive: true, force: true }),
        );
        report.incompleteRemoved++;
      } else if (meta && !meta.finalized && !(meta.generationId && open.has(meta.generationId))) {
        await this.guarded(userId, () =>
          rm(this.paths.artifactDir(userId, name), { recursive: true, force: true }),
        );
        report.unfinalizedRemoved++;
      }
    }
    this.forget(userId);
    if (report.incompleteRemoved + report.unfinalizedRemoved > 0)
      this.logger.info({ userId, ...report }, "artifacts reconciled");
    return report;
  }
}

export function toArtifactSummary(meta: ArtifactMeta, backlinkAvailable: boolean): ArtifactSummary {
  return {
    id: meta.id,
    name: meta.name,
    language: meta.language,
    size: meta.size,
    sha256: meta.sha256,
    createdAt: meta.createdAt,
    conversationId: meta.conversationId,
    assistantMessageId: meta.assistantMessageId,
    captureIndex: meta.captureIndex,
    backlinkAvailable,
  };
}

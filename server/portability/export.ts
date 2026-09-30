import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { ErrorCode } from "@shared/errors";
import type { ExportResult } from "@shared/portability";
import { AppError } from "../errors.ts";
import type { GenerationManager } from "../generations/manager.ts";
import type { Logger } from "../logger.ts";
import type { AccountWrites } from "../storage/account.ts";
import { ensureDir, listDir, readOrNull } from "../storage/fs.ts";
import { sha256Hex } from "../storage/operations.ts";
import { isUuid, type DataPaths } from "../storage/paths.ts";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, entryName, type Manifest } from "./archive.ts";

/** Exports are kept this long for download, then removed. */
export const EXPORT_RETENTION_MS = 60 * 60_000;

export interface ExportHooks {
  /** Test hook: after the barrier is released, before blobs are copied. */
  beforeBlobs?: () => void | Promise<void>;
  /** Test hook: while the barrier is held exclusively. */
  duringSnapshot?: () => void | Promise<void>;
}

interface BlobRef {
  entry: string;
  file: string;
  length: number;
  sha256: string;
}

/** Hashes what passes through. */
function hasher(): Transform & { digest: () => string; bytes: () => number } {
  const hash = createHash("sha256");
  let bytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return Object.assign(transform, { digest: () => hash.digest("hex"), bytes: () => bytes });
}

/**
 * Portable export (Phase 13d, INV-43) and single-chat export.
 *
 * Snapshot: the per-user barrier is held **exclusively** only while the
 * small mutable files (conversation Markdown, attachment and artifact
 * metadata, memories, proposal sidecars, skills, preferences) are copied into
 * `import-staging/exports/<id>/`, and each referenced blob's length and
 * SHA-256 is taken from its metadata. Canonical writes hold the barrier
 * shared per file, so each copied file is a complete version and no write is
 * in progress during the window. Blobs are immutable once committed: they are
 * copied afterwards and verified; one deleted or changed since the snapshot
 * fails the export with a retryable error rather than shipping a dangling
 * reference (an already opened blob stays readable after an unlink).
 */
export class ExportService {
  private readonly o: {
    paths: DataPaths;
    writes: AccountWrites;
    generations: GenerationManager;
    logger: Logger;
    version: string;
    now?: () => Date;
  };
  hooks: ExportHooks = {};
  private readonly running = new Set<string>();

  constructor(options: ExportService["o"]) {
    this.o = options;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** The exact canonical bytes of one conversation (malformed files too); never reserialized. */
  async conversationBytes(userId: string, conversationId: string): Promise<Buffer> {
    const bytes = await readOrNull(this.o.paths.chatFile(userId, conversationId));
    if (!bytes) throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
    return bytes;
  }

  archivePath(userId: string, exportId: string): string {
    return path.join(this.o.paths.exportDir(userId, exportId), "archive.zip");
  }

  async create(userId: string): Promise<ExportResult> {
    if (this.running.has(userId))
      throw new AppError(ErrorCode.RATE_LIMITED, "An export is already being prepared", undefined, {
        "Retry-After": "5",
      });
    this.running.add(userId);
    const exportId = randomUUID();
    const dir = this.o.paths.exportDir(userId, exportId);
    try {
      return await this.build(userId, exportId, dir);
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      this.running.delete(userId);
    }
  }

  private async build(userId: string, exportId: string, dir: string): Promise<ExportResult> {
    const { paths } = this.o;
    const files = path.join(dir, "files");
    const small: { entry: string; file: string; length: number; sha256: string }[] = [];
    const blobs: BlobRef[] = [];
    const counts: Record<string, number> = {
      conversations: 0,
      attachments: 0,
      artifacts: 0,
      memories: 0,
      proposals: 0,
    };
    const active: string[] = [];
    const createdAt = this.now().toISOString();

    // Snapshot of the small mutable files, under the exclusive barrier.
    await this.o.writes.exclusive(userId, async () => {
      await ensureDir(files);
      let seq = 0;
      const keep = async (entry: string, bytes: Buffer) => {
        const file = path.join(files, String(seq++));
        const handle = await open(file, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        small.push({ entry, file, length: bytes.length, sha256: sha256Hex(bytes) });
      };
      for (const name of await listDir(paths.chatsDir(userId))) {
        const id = name.endsWith(".md") ? name.slice(0, -3) : "";
        if (!isUuid(id)) continue;
        const bytes = await readOrNull(paths.chatFile(userId, id));
        if (!bytes) continue;
        await keep(entryName("conversation", id), bytes);
        counts.conversations = (counts.conversations ?? 0) + 1;
        const running = this.o.generations.activeFor(`${userId}/${id}`);
        if (running) active.push(id);
      }
      for (const [kind, dirOf, metaOf, blobOf] of [
        [
          "attachment",
          paths.attachmentsDir(userId),
          (id: string) => paths.attachmentMeta(userId, id),
          (id: string) => paths.attachmentBlob(userId, id),
        ],
        [
          "artifact",
          paths.artifactsDir(userId),
          (id: string) => paths.artifactMeta(userId, id),
          (id: string) => paths.artifactBlob(userId, id),
        ],
      ] as const) {
        for (const id of await listDir(dirOf)) {
          if (!isUuid(id)) continue;
          const bytes = await readOrNull(metaOf(id));
          if (!bytes) continue;
          let meta: { size?: unknown; sha256?: unknown; messageId?: unknown; finalized?: unknown };
          try {
            meta = JSON.parse(bytes.toString("utf8")) as typeof meta;
          } catch {
            continue;
          }
          if (typeof meta.size !== "number" || typeof meta.sha256 !== "string") continue;
          // Pending uploads (unsent drafts) and unfinalized captures are not content yet.
          if (kind === "attachment" && meta.messageId === null) continue;
          if (kind === "artifact" && meta.finalized !== true) continue;
          await keep(entryName(`${kind}-meta`, id), bytes);
          blobs.push({
            entry: entryName(`${kind}-blob`, id),
            file: blobOf(id),
            length: meta.size,
            sha256: meta.sha256,
          });
          counts[`${kind}s`] = (counts[`${kind}s`] ?? 0) + 1;
        }
      }
      for (const name of await listDir(paths.memoriesDir(userId))) {
        const id = name.endsWith(".md") ? name.slice(0, -3) : "";
        if (!isUuid(id)) continue;
        const bytes = await readOrNull(paths.memoryFile(userId, id));
        if (!bytes) continue;
        await keep(entryName("memory", id), bytes);
        counts.memories = (counts.memories ?? 0) + 1;
      }
      for (const name of await listDir(paths.proposalsDir(userId))) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!isUuid(id)) continue;
        const bytes = await readOrNull(paths.proposalsFile(userId, id));
        if (!bytes) continue;
        await keep(entryName("proposals", id), bytes);
        counts.proposals = (counts.proposals ?? 0) + 1;
      }
      for (const [kind, file] of [
        ["skills", paths.skillsFile(userId)],
        ["preferences", paths.preferencesFile(userId)],
      ] as const) {
        const bytes = await readOrNull(file);
        if (bytes) await keep(entryName(kind), bytes);
      }
      await this.hooks.duringSnapshot?.();
    });
    await this.hooks.beforeBlobs?.();

    const manifest: Manifest = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportId,
      createdAt,
      generator: { app: "chatui", version: this.o.version.slice(0, 64) },
      entries: [
        ...small.map((s) => ({ path: s.entry, length: s.length, sha256: s.sha256 })),
        ...blobs.map((b) => ({ path: b.entry, length: b.length, sha256: b.sha256 })),
      ],
      activeGenerations: active,
    };

    // Blobs are opened before zipping: one deleted since the snapshot fails now.
    const handles: { ref: BlobRef; handle: Awaited<ReturnType<typeof open>> }[] = [];
    try {
      for (const ref of blobs) {
        try {
          handles.push({ ref, handle: await open(ref.file, "r") });
        } catch {
          throw new AppError(
            ErrorCode.CONFLICT,
            "A file was deleted while the export was prepared; try again",
            { retryable: true },
          );
        }
      }
      const zip = new yazl.ZipFile();
      const archive = this.archivePath(userId, exportId);
      const written = pipeline(zip.outputStream, createWriteStream(archive, { mode: 0o600 }));
      zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), entryName("manifest"), {
        mtime: new Date(createdAt),
      });
      for (const s of small) zip.addFile(s.file, s.entry, { mtime: new Date(createdAt) });
      const checks: { ref: BlobRef; hash: ReturnType<typeof hasher> }[] = [];
      for (const { ref, handle } of handles) {
        const hash = hasher();
        checks.push({ ref, hash });
        zip.addReadStream(handle.createReadStream().pipe(hash), ref.entry, {
          mtime: new Date(createdAt),
          size: ref.length,
        });
      }
      zip.end();
      try {
        await written;
      } catch {
        // yazl refuses a blob whose length differs from its metadata.
        throw new AppError(
          ErrorCode.CONFLICT,
          "A file changed while the export was prepared; try again",
          { retryable: true },
        );
      }
      for (const { ref, hash } of checks) {
        if (hash.bytes() !== ref.length || hash.digest() !== ref.sha256)
          throw new AppError(
            ErrorCode.CONFLICT,
            "A file changed while the export was prepared; try again",
            { retryable: true },
          );
      }
      // The copied small files are no longer needed.
      await rm(files, { recursive: true, force: true });
      const size = (await stat(archive)).size;
      this.o.logger.info({ userId, exportId, size }, "export prepared");
      return { exportId, createdAt, size, counts, activeGenerations: active.length };
    } finally {
      for (const { handle } of handles) await handle.close().catch(() => undefined);
    }
  }

  /** The archive to download, or 404. */
  async archive(userId: string, exportId: string): Promise<{ file: string; size: number }> {
    const file = this.archivePath(userId, exportId);
    try {
      return { file, size: (await stat(file)).size };
    } catch {
      throw new AppError(ErrorCode.NOT_FOUND, "Export not found or expired");
    }
  }

  /** Removes expired exports (all of them at startup). */
  async sweep(userId: string, startup: boolean): Promise<number> {
    let removed = 0;
    const root = this.o.paths.exportsDir(userId);
    for (const id of await listDir(root)) {
      if (!isUuid(id)) continue;
      const dir = this.o.paths.exportDir(userId, id);
      const age = await stat(dir).then(
        (s) => this.now().getTime() - s.mtimeMs,
        () => Number.POSITIVE_INFINITY,
      );
      if (startup || age > EXPORT_RETENTION_MS) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}

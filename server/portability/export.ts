// Portable export (Phase 13d, contracts §12, INV-43). A consistent snapshot of
// every canonical store the user owns: the small mutable files are copied
// while the per-user export barrier is held exclusively; immutable blobs are
// copied afterwards and verified against the checksums recorded then.
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ErrorCode } from "@shared/errors";
import type { AttachmentStore } from "../attachments/store.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import { AppError } from "../errors.ts";
import type { GenerationManager } from "../generations/manager.ts";
import { ensureDir, listDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import { parseConversation } from "../storage/markdown.ts";
import { isUuid, type DataPaths } from "../storage/paths.ts";
import { ZipWriter } from "./zip.ts";

export const ARCHIVE_FORMAT = "chatui-archive";
export const ARCHIVE_VERSION = 1;

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  exportedAt: string;
  entries: ManifestEntry[];
  conversations: { id: string; malformed: boolean; activeGeneration: boolean }[];
}

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Where export files and import staging live (transient; never exported). */
export function stagingDir(paths: DataPaths, userId: string): string {
  return path.join(paths.userDir(userId), "import-staging");
}

export interface ExportDeps {
  paths: DataPaths;
  locks: KeyedLocks;
  generations: GenerationManager;
  attachments: AttachmentStore;
  artifacts: ArtifactStore;
  /** Temporary chats are never exported (Phase 13f). */
  temporary?: ReadonlySet<string>;
  now: () => Date;
  /** Test hooks: inside the exclusive window, and after it (before blobs are copied). */
  hooks?: { inSnapshot?: () => Promise<void>; afterSnapshot?: () => Promise<void> };
}

interface BlobRef {
  path: string;
  source: string;
  size: number;
  sha256: string;
}

/**
 * Builds the archive in the user's staging directory and returns its path.
 * The caller streams it and deletes it. A blob that changed or vanished after
 * the snapshot fails the export (retryable): no dangling references.
 */
export async function exportArchive(userId: string, deps: ExportDeps): Promise<string> {
  const { paths } = deps;
  const small = new Map<string, Buffer>();
  const blobs: BlobRef[] = [];
  const conversations: Manifest["conversations"] = [];

  await deps.locks.barrier.withExclusive(userId, async () => {
    for (const name of await listDir(paths.chatsDir(userId))) {
      const id = name.endsWith(".md") ? name.slice(0, -3) : "";
      if (!isUuid(id) || deps.temporary?.has(id)) continue;
      const bytes = await readOrNull(paths.chatFile(userId, id));
      if (!bytes) continue;
      small.set(`chats/${id}.md`, bytes);
      conversations.push({
        id,
        malformed: !parseConversation(bytes.toString("utf8")).ok,
        // Exported in its accepted state: the user block without its reply.
        activeGeneration: deps.generations.activeFor(`${userId}/${id}`) !== undefined,
      });
    }
    for (const meta of await deps.attachments.list(userId)) {
      // Pending uploads are transient; linked and Library files are user content.
      if (meta.messageId === null && !meta.saved) continue;
      if (meta.conversationId !== null && deps.temporary?.has(meta.conversationId)) continue;
      const metaBytes = await readOrNull(paths.attachmentMeta(userId, meta.id));
      if (!metaBytes) continue;
      small.set(`attachments/${meta.id}/meta.json`, metaBytes);
      blobs.push({
        path: `attachments/${meta.id}/blob`,
        source: paths.attachmentBlob(userId, meta.id),
        size: meta.size,
        sha256: meta.sha256,
      });
    }
    for (const meta of await deps.artifacts.list(userId)) {
      const dir = path.dirname(deps.artifacts.blobPath(userId, meta.id));
      const metaBytes = await readOrNull(path.join(dir, "meta.json"));
      if (!metaBytes) continue;
      small.set(`artifacts/${meta.id}/meta.json`, metaBytes);
      blobs.push({
        path: `artifacts/${meta.id}/blob`,
        source: deps.artifacts.blobPath(userId, meta.id),
        size: meta.size,
        sha256: meta.sha256,
      });
    }
    for (const name of await listDir(paths.memoriesDir(userId))) {
      const id = name.endsWith(".md") ? name.slice(0, -3) : "";
      if (!isUuid(id)) continue;
      const bytes = await readOrNull(paths.memoryFile(userId, id));
      if (bytes) small.set(`memories/${id}.md`, bytes);
    }
    for (const name of await listDir(paths.proposalsDir(userId))) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isUuid(id) || deps.temporary?.has(id)) continue;
      const bytes = await readOrNull(paths.proposalFile(userId, id));
      if (bytes) small.set(`proposals/${id}.json`, bytes);
    }
    const preferences = await readOrNull(paths.preferencesFile(userId));
    if (preferences) small.set("preferences.json", preferences);
    await deps.hooks?.inSnapshot?.();
  });
  await deps.hooks?.afterSnapshot?.();

  const dir = stagingDir(paths, userId);
  await ensureDir(dir);
  const file = path.join(dir, `export-${randomBytes(8).toString("hex")}.zip`);
  const zip = await ZipWriter.create(file);
  const entries: ManifestEntry[] = [];
  try {
    for (const [name, bytes] of [...small.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      await zip.add(name, bytes);
      entries.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
    }
    for (const blob of blobs) {
      const bytes = await readFile(blob.source).catch(() => null);
      if (bytes?.length !== blob.size || sha256(bytes) !== blob.sha256) {
        throw new AppError(
          ErrorCode.CONFLICT,
          "A file changed or was deleted during the export; try again",
        );
      }
      await zip.add(blob.path, bytes);
      entries.push({ path: blob.path, size: bytes.length, sha256: blob.sha256 });
    }
    const manifest: Manifest = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportedAt: deps.now().toISOString(),
      entries,
      conversations,
    };
    await zip.add("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    await zip.close();
    return file;
  } catch (error) {
    await zip.abort();
    await rm(file, { force: true });
    throw error;
  }
}

/** Single-chat export: the exact canonical bytes, malformed files included (no repair). */
export async function exportConversation(
  paths: DataPaths,
  userId: string,
  conversationId: string,
): Promise<{ bytes: Buffer; title: string | null }> {
  const bytes = await readOrNull(paths.chatFile(userId, conversationId));
  if (!bytes) throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
  const parsed = parseConversation(bytes.toString("utf8"));
  return { bytes, title: parsed.ok ? parsed.conversation.title : null };
}

/** A download name from a title: safe characters, `.md`. */
export function markdownFilename(title: string | null): string {
  const base = (title ?? "conversation")
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "conversation"}.md`;
}

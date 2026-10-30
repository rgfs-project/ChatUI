// Canonical attachments (Phase 12, contracts §1, §7):
// data/<user>/attachments/<attachment-uuid>/{blob,meta.json}.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { atomicWrite, ensureDirUnder, FILE_MODE, listDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import { isUuid, type DataPaths } from "../storage/paths.ts";
import { sniff, SniffError, TextProbe, type AttachmentKind } from "./sniff.ts";

export const attachmentMetaSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  ownerId: z.uuid(),
  /** Both null while pending; set together when a sent message links it. */
  conversationId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  /** Display only; never part of any path (INV-28). */
  filename: z.string().min(1).max(255),
  /** Sniffed from the bytes (INV-27). */
  mediaType: z.string().min(1).max(100),
  kind: z.enum(["image", "audio", "text"]),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  /** Images only. */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Uploaded to the Library (Phase 12b): kept until deleted, never expired or linked. */
  saved: z.boolean().default(false),
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

export interface AttachmentLimits {
  maxBytes: number;
  quotaBytes: number;
}

export interface AttachmentStoreOptions {
  paths: DataPaths;
  locks: KeyedLocks;
  logger: Logger;
  /** Current limits (environment, lowered or changed by admin settings). */
  limits: () => AttachmentLimits;
  maxConcurrentUploads: number;
  maxImagePixels: number;
  pendingTtlMs: number;
  now?: () => Date;
}

const lockKey = (userId: string, id: string) => `attachment:${userId}/${id}`;

/** Bidirectional overrides and other format controls make names display misleadingly. */
const UNSAFE_NAME_CHARS = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/**
 * Display filename from the client's name: last path segment only, controls
 * and bidi overrides removed, at most 200 characters (keeping the extension).
 * It is metadata; storage paths never use it (INV-28).
 */
export function displayName(raw: string): string {
  const base = (raw.normalize("NFC").split(/[\\/]/).pop() ?? "")
    .replace(UNSAFE_NAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(base);
  if (chars.length === 0) return "file";
  if (chars.length <= 200) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? Array.from(base.slice(dot)).slice(0, 16).join("") : "";
  return chars.slice(0, 200 - Array.from(ext).length).join("") + ext;
}

function sniffToAppError(error: SniffError): AppError {
  if (error.reason === "too_large") return new AppError(ErrorCode.PAYLOAD_TOO_LARGE, error.message);
  if (error.reason === "empty") return new AppError(ErrorCode.VALIDATION, error.message);
  return new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, error.message);
}

/**
 * Attachment storage. Uploads stream to a temp file inside the attachment's
 * own directory with the size limit enforced per chunk; the type is sniffed
 * from the received bytes, the blob is renamed into place and `meta.json` is
 * written last, so a directory without it is an incomplete upload. Quota is
 * reserved before any byte is stored, so parallel uploads cannot exceed it
 * (INV-62).
 */
export class AttachmentStore {
  private readonly o: AttachmentStoreOptions;
  private readonly now: () => Date;
  private readonly usageCache = new Map<string, number>();
  private readonly reserved = new Map<string, number>();
  private readonly uploading = new Map<string, number>();

  constructor(options: AttachmentStoreOptions) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
  }

  /** Holds the locks of `ids` in ascending order (contracts §2 global order). */
  async withLocks<T>(userId: string, ids: readonly string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(ids)].sort();
    const run = (index: number): Promise<T> => {
      const id = sorted[index];
      return id === undefined ? fn() : this.o.locks.run(lockKey(userId, id), () => run(index + 1));
    };
    return run(0);
  }

  async get(userId: string, id: string): Promise<AttachmentMeta | null> {
    if (!isUuid(id)) return null;
    const raw = await readOrNull(this.o.paths.attachmentMeta(userId, id));
    if (!raw) return null;
    try {
      const parsed = attachmentMetaSchema.safeParse(JSON.parse(raw.toString("utf8")));
      // Ownership is the directory and the record together; a mismatch is not this user's.
      return parsed.success && parsed.data.ownerId === userId && parsed.data.id === id
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  }

  async list(userId: string): Promise<AttachmentMeta[]> {
    const ids = (await listDir(this.o.paths.attachmentsDir(userId))).filter(isUuid);
    const metas = await Promise.all(ids.map((id) => this.get(userId, id)));
    return metas.filter((m): m is AttachmentMeta => m !== null);
  }

  blobPath(userId: string, id: string): string {
    return this.o.paths.attachmentBlob(userId, id);
  }

  async readBlob(userId: string, id: string): Promise<Buffer | null> {
    return readOrNull(this.o.paths.attachmentBlob(userId, id));
  }

  /** Stored bytes (pending and linked) for the quota. */
  async usage(userId: string): Promise<number> {
    const cached = this.usageCache.get(userId);
    if (cached !== undefined) return cached;
    const total = (await this.list(userId)).reduce((sum, m) => sum + m.size, 0);
    this.usageCache.set(userId, total);
    return total;
  }

  private adjustUsage(userId: string, delta: number): void {
    const cached = this.usageCache.get(userId);
    if (cached !== undefined) this.usageCache.set(userId, Math.max(0, cached + delta));
  }

  /** Forgets cached usage (account removal). */
  forgetUser(userId: string): void {
    this.usageCache.delete(userId);
  }

  /**
   * Receives one upload. `declaredBytes` (the request length, when known)
   * bounds the quota reservation; the limit itself is enforced on the bytes.
   */
  async ingest(
    userId: string,
    source: Readable,
    info: {
      filename: string;
      clientType: string;
      declaredBytes: number | undefined;
      /** A Library upload (kept) rather than a message attachment (pending). */
      saved?: boolean;
    },
  ): Promise<AttachmentMeta> {
    const { maxBytes, quotaBytes } = this.o.limits();
    const active = this.uploading.get(userId) ?? 0;
    if (active >= this.o.maxConcurrentUploads) {
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        "Too many uploads at once; wait for one to finish",
      );
    }
    if (info.declaredBytes !== undefined && info.declaredBytes > maxBytes + 64 * 1024) {
      throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "The file is too large");
    }
    const reservation = Math.min(maxBytes, info.declaredBytes ?? maxBytes);
    const used = await this.usage(userId);
    const others = this.reserved.get(userId) ?? 0;
    if (used + others + reservation > quotaBytes) {
      throw new AppError(ErrorCode.QUOTA_EXCEEDED, "Your file storage is full");
    }
    this.uploading.set(userId, active + 1);
    this.reserved.set(userId, others + reservation);
    const id = randomUUID();
    const dir = this.o.paths.attachmentDir(userId, id);
    try {
      return await this.receive(userId, id, dir, source, info, {
        maxBytes,
        // Bytes beyond the reservation are re-checked against the quota as they arrive.
        quotaRoom: quotaBytes - used - others,
      });
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SniffError) throw sniffToAppError(error);
      throw error;
    } finally {
      this.uploading.set(userId, (this.uploading.get(userId) ?? 1) - 1);
      this.reserved.set(userId, Math.max(0, (this.reserved.get(userId) ?? 0) - reservation));
    }
  }

  private async receive(
    userId: string,
    id: string,
    dir: string,
    source: Readable,
    info: { filename: string; clientType: string; saved?: boolean },
    bounds: { maxBytes: number; quotaRoom: number },
  ): Promise<AttachmentMeta> {
    await ensureDirUnder(this.o.paths.userDir(userId), this.o.paths.attachmentsDir(userId));
    await mkdir(dir, { mode: 0o700 });
    const temp = path.join(dir, `.blob.${randomBytes(8).toString("hex")}.tmp`);
    const hash = createHash("sha256");
    const probe = new TextProbe();
    let size = 0;
    // Read back for sniffing; "x" fails if the name somehow exists.
    let handle: FileHandle | null = await open(temp, "wx+", FILE_MODE);
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        size += chunk.length;
        // Enforced while streaming: the first byte over the limit aborts.
        if (size > bounds.maxBytes) {
          throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "The file is too large");
        }
        if (size > bounds.quotaRoom) {
          throw new AppError(ErrorCode.QUOTA_EXCEEDED, "Your file storage is full");
        }
        hash.update(chunk);
        probe.push(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      const reader = handle;
      const sniffed = await sniff({
        size,
        read: async (offset, length) => {
          const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
          if (buffer.length === 0) return buffer;
          const { bytesRead } = await reader.read(buffer, 0, buffer.length, offset);
          return buffer.subarray(0, bytesRead);
        },
        text: probe.finish(),
        filename: info.filename,
        clientType: info.clientType,
        maxImagePixels: this.o.maxImagePixels,
      });
      await handle.close();
      handle = null;
      await rename(temp, this.o.paths.attachmentBlob(userId, id));
      const meta: AttachmentMeta = {
        version: 1,
        id,
        ownerId: userId,
        conversationId: null,
        messageId: null,
        filename: displayName(info.filename),
        mediaType: sniffed.mediaType,
        kind: sniffed.kind satisfies AttachmentKind,
        size,
        sha256: hash.digest("hex"),
        createdAt: this.now().toISOString(),
        width: sniffed.width,
        height: sniffed.height,
        saved: info.saved === true,
      };
      // meta.json last: its presence marks a complete upload.
      await atomicWrite(this.o.paths.attachmentMeta(userId, id), `${JSON.stringify(meta)}\n`);
      this.adjustUsage(userId, size);
      return meta;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async removeUnlocked(userId: string, meta: AttachmentMeta): Promise<void> {
    await rm(this.o.paths.attachmentDir(userId, meta.id), { recursive: true, force: true });
    this.adjustUsage(userId, -meta.size);
  }

  /** Deletes an upload that no message references (pending or saved in the Library). */
  async removePending(userId: string, id: string): Promise<void> {
    await this.withLocks(userId, [id], async () => {
      const meta = await this.get(userId, id);
      if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "Attachment not found");
      if (meta.messageId !== null) {
        throw new AppError(ErrorCode.CONFLICT, "This file is part of a sent message");
      }
      await this.removeUnlocked(userId, meta);
    });
  }

  /** Links pending attachments to a persisted user message. Caller holds their locks. */
  async linkUnlocked(
    userId: string,
    metas: readonly AttachmentMeta[],
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    for (const meta of metas) {
      const linked: AttachmentMeta = { ...meta, conversationId, messageId };
      await atomicWrite(
        this.o.paths.attachmentMeta(userId, meta.id),
        `${JSON.stringify(linked)}\n`,
      );
    }
  }

  /** After a conversation's Markdown is deleted: its linked attachments (contracts §7). */
  async deleteForConversation(userId: string, conversationId: string): Promise<number> {
    const linked = (await this.list(userId)).filter((m) => m.conversationId === conversationId);
    let removed = 0;
    await this.withLocks(
      userId,
      linked.map((m) => m.id),
      async () => {
        for (const meta of linked) {
          const current = await this.get(userId, meta.id);
          if (current?.conversationId !== conversationId) continue;
          await this.removeUnlocked(userId, current);
          removed++;
        }
      },
    );
    return removed;
  }

  /** Files of removed user turns (edit, delete exchange): only those linked to this conversation. */
  async deleteIds(userId: string, conversationId: string, ids: readonly string[]): Promise<number> {
    let removed = 0;
    await this.withLocks(userId, ids, async () => {
      for (const id of ids) {
        const current = await this.get(userId, id);
        if (current?.conversationId !== conversationId) continue;
        await this.removeUnlocked(userId, current);
        removed++;
      }
    });
    return removed;
  }

  /** Removes pending uploads older than the TTL (each rechecked under its lock). */
  async collectExpired(userId: string): Promise<number> {
    const cutoff = this.now().getTime() - this.o.pendingTtlMs;
    const expired = (await this.list(userId)).filter(
      (m) => m.messageId === null && !m.saved && Date.parse(m.createdAt) < cutoff,
    );
    let removed = 0;
    for (const meta of expired) {
      await this.withLocks(userId, [meta.id], async () => {
        const current = await this.get(userId, meta.id);
        if (current?.messageId !== null || current.saved) return;
        await this.removeUnlocked(userId, current);
        removed++;
      });
    }
    return removed;
  }

  /**
   * Startup reconciliation (contracts §2 step 7), before requests are served:
   * removes incomplete uploads (no meta.json), links pending attachments that
   * a persisted message references (a crash between the Markdown write and
   * the link), removes linked attachments whose conversation is gone (a crash
   * between the Markdown delete and the cleanup) and expired pending uploads.
   */
  async reconcile(
    userId: string,
    conversations: ReadonlyMap<string, { messageId: string; attachments: string[] }[]>,
  ): Promise<{ incomplete: number; linked: number; orphans: number; expired: number }> {
    const report = { incomplete: 0, linked: 0, orphans: 0, expired: 0 };
    const references = new Map<string, { conversationId: string; messageId: string }>();
    for (const [conversationId, messages] of conversations) {
      for (const message of messages) {
        for (const id of message.attachments)
          references.set(id, { conversationId, messageId: message.messageId });
      }
    }
    for (const name of await listDir(this.o.paths.attachmentsDir(userId))) {
      if (!isUuid(name)) continue;
      const raw = await readOrNull(this.o.paths.attachmentMeta(userId, name));
      if (raw === null) {
        await rm(this.o.paths.attachmentDir(userId, name), { recursive: true, force: true });
        report.incomplete++;
      }
    }
    this.usageCache.delete(userId);
    for (const meta of await this.list(userId)) {
      const ref = references.get(meta.id);
      if (meta.messageId === null && !meta.saved && ref) {
        await this.linkUnlocked(userId, [meta], ref.conversationId, ref.messageId);
        report.linked++;
      } else if (meta.conversationId !== null && !conversations.has(meta.conversationId)) {
        await this.removeUnlocked(userId, meta);
        report.orphans++;
      }
    }
    report.expired = await this.collectExpired(userId);
    if (Object.values(report).some((n) => n > 0))
      this.o.logger.info({ ...report }, "attachments reconciled");
    return report;
  }
}

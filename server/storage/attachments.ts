// Attachment storage (contracts §1, §2, §7; INV-27, INV-28, INV-62).
//
//   data/<user>/attachments/<attachment-uuid>/blob       raw bytes
//   data/<user>/attachments/<attachment-uuid>/meta.json  canonical metadata, written last
//
// Uploads stream into a temp file inside the attachment directory with the
// size enforced while streaming, are hashed and sniffed, then renamed into
// place; meta.json is written last, so a directory without it is an
// incomplete upload (removed at startup). Ids are server-minted; the uploaded
// filename is display metadata only.
//
// Bundled with the app (it uses path aliases); unlike most storage modules the
// natively run CLI never loads it: startup recovery receives it as a callback.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import busboy from "busboy";
import { z } from "zod";
import {
  ATTACHMENT_KINDS,
  MEDIA_TYPES,
  type AttachmentDto,
  type AttachmentMediaType,
  type MessageAttachmentDto,
} from "@shared/attachments";
import { ErrorCode } from "@shared/errors";
import { displayFilename, SNIFF_HEAD_BYTES, sniff, TextProbe } from "../attachments/sniff.ts";
import type { AttachmentConfig } from "../config.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { AccountWrites } from "./account.ts";
import { atomicWrite, ensureDir, FILE_MODE, listDir, readOrNull } from "./fs.ts";
import type { KeyedLocks } from "./locks.ts";
import { parseConversation } from "./markdown.ts";
import { isUuid, type DataPaths } from "./paths.ts";

export const attachmentMetaSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  ownerId: z.uuid(),
  conversationId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  filename: z.string().min(1).max(1_000),
  mediaType: z.enum(MEDIA_TYPES as [AttachmentMediaType, ...AttachmentMediaType[]]),
  kind: z.enum(ATTACHMENT_KINDS),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  /** Images only: pixel size from the sniffed header (lets the UI reserve space). */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

/** The limits in effect now: environment defaults with admin overrides applied. */
export type EffectiveLimits = Pick<
  AttachmentConfig,
  "maxFileBytes" | "maxPerMessage" | "quotaBytes" | "textInlineBytes"
>;

/** Multipart framing allowed on top of the file itself before Content-Length is refused. */
const MULTIPART_OVERHEAD = 64 * 1024;

export const lockKey = (userId: string, attachmentId: string) =>
  `attachment:${userId}/${attachmentId}`;

export function toAttachmentDto(meta: AttachmentMeta): AttachmentDto {
  return {
    id: meta.id,
    filename: meta.filename,
    mediaType: meta.mediaType,
    kind: meta.kind,
    size: meta.size,
    width: meta.width ?? null,
    height: meta.height ?? null,
    linked: meta.messageId !== null,
  };
}

export function toMessageAttachment(id: string, meta: AttachmentMeta | null): MessageAttachmentDto {
  if (!meta)
    return {
      id,
      missing: true,
      filename: null,
      mediaType: null,
      kind: null,
      size: null,
      width: null,
      height: null,
    };
  return {
    id,
    missing: false,
    filename: meta.filename,
    mediaType: meta.mediaType,
    kind: meta.kind,
    size: meta.size,
    width: meta.width ?? null,
    height: meta.height ?? null,
  };
}

export interface AttachmentStoreHooks {
  /** Test hook: after the blob is streamed and sniffed, before it is committed. */
  beforeCommit?: () => void | Promise<void>;
}

export interface ReconcileReport {
  incompleteRemoved: number;
  linked: number;
  collected: number;
}

const REJECTION: Record<string, string> = {
  unsupported:
    "This file type isn't supported. Attach PNG, JPEG, WebP or GIF images, WAV, MP3 or FLAC audio, or UTF-8 text files.",
  mismatch: "The file's contents don't match its name or type.",
  malformed: "The file is damaged or incomplete.",
  active: "HTML and SVG files can't be attached.",
};

export class AttachmentStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly writes: AccountWrites;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly config: AttachmentConfig;
  private readonly limits: () => EffectiveLimits;
  private readonly hooks: AttachmentStoreHooks;
  /** Committed bytes per user, computed lazily from meta.json files. */
  private readonly used = new Map<string, number>();
  /** Bytes reserved by uploads in flight, per user (contracts §7). */
  private readonly reserved = new Map<string, number>();
  /** Uploads in flight, per user, so account closure can cancel them. */
  private readonly inflight = new Map<string, Set<AbortController>>();
  private inflightTotal = 0;

  constructor(options: {
    paths: DataPaths;
    locks: KeyedLocks;
    writes: AccountWrites;
    logger: Logger;
    config: AttachmentConfig;
    limits?: () => EffectiveLimits;
    now?: () => Date;
    hooks?: AttachmentStoreHooks;
  }) {
    this.paths = options.paths;
    this.locks = options.locks;
    this.writes = options.writes;
    this.logger = options.logger;
    this.config = options.config;
    this.limits = options.limits ?? (() => options.config);
    this.now = options.now ?? (() => new Date());
    this.hooks = options.hooks ?? {};
  }

  /** The environment defaults (admins see them next to their overrides). */
  defaults(): EffectiveLimits {
    const { maxFileBytes, maxPerMessage, quotaBytes, textInlineBytes } = this.config;
    return { maxFileBytes, maxPerMessage, quotaBytes, textInlineBytes };
  }

  effective(): EffectiveLimits {
    return this.limits();
  }

  get mediaTokenReserve(): number {
    return this.config.mediaTokenReserve;
  }

  /** Runs `fn` holding the locks of `ids` in ascending order (contracts §2 lock order). */
  withLocks<T>(userId: string, ids: readonly string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(ids)].sort();
    const step = (index: number): Promise<T> => {
      const id = sorted[index];
      if (id === undefined) return fn();
      return this.locks.run(lockKey(userId, id), () => step(index + 1));
    };
    return step(0);
  }

  /** Canonical metadata, or null when missing or unreadable (never "malformed" for a message). */
  async readMeta(userId: string, id: string): Promise<AttachmentMeta | null> {
    if (!isUuid(id)) return null;
    const bytes = await readOrNull(this.paths.attachmentMeta(userId, id));
    if (!bytes) return null;
    try {
      const meta = attachmentMetaSchema.parse(JSON.parse(bytes.toString("utf8")));
      return meta.id === id && meta.ownerId === userId ? meta : null;
    } catch {
      this.logger.warn({ attachmentId: id }, "unreadable attachment metadata");
      return null;
    }
  }

  /** Owned attachment metadata; anything else (missing, another user's) is 404. */
  async get(userId: string, id: string): Promise<AttachmentMeta> {
    const meta = await this.readMeta(userId, id);
    if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "Attachment not found");
    return meta;
  }

  private async writeMeta(userId: string, meta: AttachmentMeta): Promise<void> {
    await atomicWrite(
      this.paths.attachmentMeta(userId, meta.id),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
  }

  /** Committed attachment bytes of a user. */
  async usage(userId: string): Promise<number> {
    const cached = this.used.get(userId);
    if (cached !== undefined) return cached;
    let total = 0;
    for (const meta of await this.all(userId)) total += meta.size;
    this.used.set(userId, total);
    return total;
  }

  /** Every readable attachment of a user. */
  async all(userId: string): Promise<AttachmentMeta[]> {
    const out: AttachmentMeta[] = [];
    for (const name of await listDir(this.paths.attachmentsDir(userId))) {
      if (!isUuid(name)) continue;
      const meta = await this.readMeta(userId, name);
      if (meta) out.push(meta);
    }
    return out;
  }

  private invalidateUsage(userId: string): void {
    this.used.delete(userId);
  }

  /**
   * Admission (INV-62): bounded concurrent uploads, and a quota reservation of
   * the declared size (else the maximum) taken before any byte is streamed.
   */
  private async admit(
    userId: string,
    declared: number | undefined,
    limits: EffectiveLimits,
  ): Promise<{ release: () => void; controller: AbortController }> {
    const mine = this.inflight.get(userId) ?? new Set<AbortController>();
    if (
      mine.size >= this.config.maxUploadsPerUser ||
      this.inflightTotal >= this.config.maxUploadsTotal
    )
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        "Too many uploads at once; wait for the others to finish",
        undefined,
        { "Retry-After": "2" },
      );
    const reservation = Math.min(declared ?? limits.maxFileBytes, limits.maxFileBytes);
    const used = await this.usage(userId);
    const reserved = this.reserved.get(userId) ?? 0;
    if (used + reserved + reservation > limits.quotaBytes)
      throw new AppError(
        ErrorCode.QUOTA_EXCEEDED,
        "Your attachment storage is full. Delete conversations with attachments to free space.",
        { quotaBytes: limits.quotaBytes, usedBytes: used },
      );
    const controller = new AbortController();
    mine.add(controller);
    this.inflight.set(userId, mine);
    this.inflightTotal++;
    this.reserved.set(userId, reserved + reservation);
    let released = false;
    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        mine.delete(controller);
        if (mine.size === 0) this.inflight.delete(userId);
        this.inflightTotal--;
        const left = (this.reserved.get(userId) ?? 0) - reservation;
        if (left > 0) this.reserved.set(userId, left);
        else this.reserved.delete(userId);
      },
    };
  }

  /** Account closure: abort every upload in flight for the user (contracts §6 step 3). */
  cancelUploads(userId: string): void {
    for (const controller of this.inflight.get(userId) ?? []) controller.abort();
  }

  /** Uploads in flight (tests and diagnostics). */
  uploadsInFlight(userId?: string): number {
    return userId ? (this.inflight.get(userId)?.size ?? 0) : this.inflightTotal;
  }

  /**
   * Receives one multipart upload (field `file`) from the request stream.
   * Rejections: VALIDATION (not a single-file multipart body), PAYLOAD_TOO_LARGE
   * (over the size limit, checked while streaming; image pixels),
   * QUOTA_EXCEEDED, UNSUPPORTED_MEDIA_TYPE (sniffing), RATE_LIMITED.
   */
  async upload(userId: string, req: IncomingMessage): Promise<AttachmentMeta> {
    const limits = this.limits();
    const contentType = req.headers["content-type"] ?? "";
    if (!/^multipart\/form-data\b/i.test(contentType))
      throw new AppError(ErrorCode.VALIDATION, "Upload a file as multipart/form-data");
    const lengthHeader = req.headers["content-length"];
    const declared =
      lengthHeader !== undefined && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
    if (declared !== undefined && declared > limits.maxFileBytes + MULTIPART_OVERHEAD)
      throw tooLarge(limits.maxFileBytes);
    const admission = await this.admit(
      userId,
      declared === undefined ? undefined : Math.max(0, declared - 256),
      limits,
    );
    try {
      return await this.receive(userId, req, limits, admission.controller.signal);
    } finally {
      admission.release();
    }
  }

  private receive(
    userId: string,
    req: IncomingMessage,
    limits: EffectiveLimits,
    signal: AbortSignal,
  ): Promise<AttachmentMeta> {
    return new Promise<AttachmentMeta>((resolve, reject) => {
      let parser: busboy.Busboy;
      try {
        parser = busboy({
          headers: req.headers,
          defParamCharset: "utf8",
          limits: {
            files: 1,
            fields: 0,
            // One byte over the limit lets the stream loop see the overflow.
            fileSize: limits.maxFileBytes + 1,
            headerPairs: 16,
          },
        });
      } catch {
        reject(new AppError(ErrorCode.VALIDATION, "Upload a file as multipart/form-data"));
        return;
      }
      let settled = false;
      let file: Readable | null = null;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        req.unpipe(parser);
        file?.destroy();
        drain(req, limits.maxFileBytes);
        reject(error);
      };
      const onAbort = () => {
        fail(new AppError(ErrorCode.VALIDATION, "The upload was cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      req.once("close", () => {
        if (!req.complete) file?.destroy(new Error("client disconnected"));
      });
      parser.on("file", (field, stream, info) => {
        file = stream;
        if (field !== "file") {
          stream.resume();
          fail(new AppError(ErrorCode.VALIDATION, "Send the file in the `file` field"));
          return;
        }
        this.store(userId, stream, info.filename, info.mimeType, limits).then(
          (meta) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(meta);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            fail(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
      parser.on("field", () => {
        fail(new AppError(ErrorCode.VALIDATION, "Only one file is accepted"));
      });
      for (const event of ["filesLimit", "fieldsLimit"] as const)
        parser.on(event, () => {
          fail(new AppError(ErrorCode.VALIDATION, "Upload exactly one file"));
        });
      parser.on("error", (error: unknown) => {
        if (file) file.destroy(error instanceof Error ? error : new Error("multipart error"));
        else fail(new AppError(ErrorCode.VALIDATION, "The upload was incomplete"));
      });
      parser.on("close", () => {
        if (!file) fail(new AppError(ErrorCode.VALIDATION, "No file was uploaded"));
      });
      req.pipe(parser);
    });
  }

  /** Streams one file into place: temp file → size/hash/sniff → rename → meta.json last. */
  private async store(
    userId: string,
    stream: Readable,
    rawFilename: string | undefined,
    declaredType: string | undefined,
    limits: EffectiveLimits,
  ): Promise<AttachmentMeta> {
    const id = randomUUID();
    const dir = this.paths.attachmentDir(userId, id);
    // Created under the account barrier: a closing or removed account never
    // gets its root recreated (contracts §6).
    await this.writes.run(userId, () => ensureDir(dir));
    const temp = path.join(dir, `.blob.${randomBytes(8).toString("hex")}.tmp`);
    let committed = false;
    try {
      const handle = await open(temp, "wx", FILE_MODE);
      const hash = createHash("sha256");
      const probe = new TextProbe();
      const head: Buffer[] = [];
      let headBytes = 0;
      let size = 0;
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > limits.maxFileBytes) throw tooLarge(limits.maxFileBytes);
          hash.update(chunk);
          probe.push(chunk);
          if (headBytes < SNIFF_HEAD_BYTES) {
            const part = chunk.subarray(0, SNIFF_HEAD_BYTES - headBytes);
            head.push(part);
            headBytes += part.length;
          }
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((stream as { truncated?: boolean }).truncated) throw tooLarge(limits.maxFileBytes);
      probe.end();
      const filename = displayFilename(rawFilename);
      const sniffed = sniff({
        head: Buffer.concat(head),
        size,
        validUtf8: probe.valid,
        hasNul: probe.hasNul,
        filename,
        declaredType,
        maxImagePixels: this.config.maxImagePixels,
      });
      if (!sniffed.ok) {
        if (sniffed.reason === "too_many_pixels")
          throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "The image has too many pixels", {
            maxPixels: this.config.maxImagePixels,
          });
        throw new AppError(
          ErrorCode.UNSUPPORTED_MEDIA_TYPE,
          REJECTION[sniffed.reason] ?? REJECTION.unsupported ?? "",
        );
      }
      if (sniffed.mediaType === "application/json") {
        try {
          JSON.parse(await readFile(temp, "utf8"));
        } catch {
          throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "The file is not valid JSON");
        }
      }
      await this.hooks.beforeCommit?.();
      const meta: AttachmentMeta = {
        version: 1,
        id,
        ownerId: userId,
        conversationId: null,
        messageId: null,
        filename,
        mediaType: sniffed.mediaType,
        kind: sniffed.kind,
        size,
        sha256: hash.digest("hex"),
        createdAt: this.now().toISOString(),
        ...(sniffed.width !== null && sniffed.height !== null
          ? { width: sniffed.width, height: sniffed.height }
          : {}),
      };
      await this.writes.run(userId, () =>
        this.locks.run(lockKey(userId, id), async () => {
          await rename(temp, this.paths.attachmentBlob(userId, id));
          await this.writeMeta(userId, meta); // last: its presence marks a complete upload
        }),
      );
      committed = true;
      const used = this.used.get(userId);
      if (used !== undefined) this.used.set(userId, used + size);
      return meta;
    } finally {
      if (!committed) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Bytes for download (the caller has checked ownership through `get`). */
  openBlob(
    userId: string,
    meta: AttachmentMeta,
    range?: { start: number; end: number },
  ): ReadStream {
    return createReadStream(this.paths.attachmentBlob(userId, meta.id), range);
  }

  async readBlob(userId: string, id: string): Promise<Buffer | null> {
    return readOrNull(this.paths.attachmentBlob(userId, id));
  }

  /** The first `bytes` bytes of a blob (text inlining reads no more than it uses). */
  async readHead(userId: string, id: string, bytes: number): Promise<Buffer | null> {
    let handle;
    try {
      handle = await open(this.paths.attachmentBlob(userId, id), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** Deletes a pending (unlinked) attachment; linked ones go with their conversation. */
  async deletePending(userId: string, id: string): Promise<void> {
    await this.writes.run(userId, () =>
      this.locks.run(lockKey(userId, id), async () => {
        const meta = await this.readMeta(userId, id);
        if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "Attachment not found");
        if (meta.messageId !== null)
          throw new AppError(
            ErrorCode.CONFLICT,
            "This attachment belongs to a sent message; delete the conversation to remove it",
          );
        await this.removeUnlocked(userId, id);
      }),
    );
  }

  private async removeUnlocked(userId: string, id: string): Promise<void> {
    // meta.json first: a directory without it is an incomplete upload, never a valid attachment.
    await rm(this.paths.attachmentMeta(userId, id), { force: true });
    await rm(this.paths.attachmentDir(userId, id), { recursive: true, force: true });
    this.invalidateUsage(userId);
  }

  /**
   * Send step 3 check (caller holds the attachment locks): every id is owned
   * and pending. A capability or context rejection leaves them pending.
   */
  async requirePending(userId: string, ids: readonly string[]): Promise<AttachmentMeta[]> {
    const metas: AttachmentMeta[] = [];
    for (const id of ids) {
      const meta = await this.readMeta(userId, id);
      if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "Attachment not found");
      if (meta.messageId !== null)
        throw new AppError(
          ErrorCode.CONFLICT,
          "This attachment was already sent with another message; attach it again",
        );
      metas.push(meta);
    }
    return metas;
  }

  /** Links pending attachments to the persisted user message (caller holds the locks). */
  async link(
    userId: string,
    metas: readonly AttachmentMeta[],
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    for (const meta of metas)
      await this.writes.run(userId, () =>
        this.writeMeta(userId, { ...meta, conversationId, messageId }),
      );
  }

  /**
   * Conversation deletion (contracts §7): after the Markdown is gone, remove
   * the attachments linked to it. An orphan is safe and GC-able; a dangling
   * reference is not, so this always runs after the Markdown delete.
   */
  async deleteForConversation(userId: string, conversationId: string): Promise<number> {
    const linked = (await this.all(userId)).filter((m) => m.conversationId === conversationId);
    let removed = 0;
    for (const meta of linked) {
      await this.writes.run(userId, () =>
        this.locks.run(lockKey(userId, meta.id), async () => {
          const current = await this.readMeta(userId, meta.id);
          if (current?.conversationId !== conversationId) return;
          await this.removeUnlocked(userId, meta.id);
          removed++;
        }),
      );
    }
    return removed;
  }

  /**
   * Removes linked attachments no longer referenced by a canonical user block
   * (edit, delete exchange, regenerate truncation), after the Markdown write.
   * Only attachments linked to `conversationId` are touched.
   */
  async deleteLinked(
    userId: string,
    conversationId: string,
    ids: Iterable<string>,
  ): Promise<number> {
    let removed = 0;
    for (const id of [...new Set(ids)].sort()) {
      await this.writes.run(userId, () =>
        this.locks.run(lockKey(userId, id), async () => {
          const meta = await this.readMeta(userId, id);
          if (meta?.conversationId !== conversationId) return;
          await this.removeUnlocked(userId, id);
          removed++;
        }),
      );
    }
    return removed;
  }

  /**
   * Startup step 7 (and hourly): link pending attachments that a user message
   * in the canonical Markdown already references (a crash between the
   * Markdown write and the link), then garbage-collect pending attachments
   * older than ATTACHMENT_PENDING_TTL. At startup only, directories without
   * meta.json are incomplete uploads and are removed.
   */
  async reconcile(
    userId: string,
    options: { startup: boolean; now?: Date },
  ): Promise<ReconcileReport> {
    const now = (options.now ?? this.now()).getTime();
    const report: ReconcileReport = { incompleteRemoved: 0, linked: 0, collected: 0 };
    const pending: AttachmentMeta[] = [];
    for (const name of await listDir(this.paths.attachmentsDir(userId))) {
      if (!isUuid(name)) continue;
      const meta = await this.readMeta(userId, name);
      if (!meta) {
        const hasMeta = (await readOrNull(this.paths.attachmentMeta(userId, name))) !== null;
        if (options.startup && !hasMeta) {
          await this.writes.run(userId, () =>
            rm(this.paths.attachmentDir(userId, name), { recursive: true, force: true }),
          );
          report.incompleteRemoved++;
        }
        continue;
      }
      if (meta.messageId === null) pending.push(meta);
    }
    if (pending.length === 0) return report;
    const references = await this.references(userId);
    for (const meta of pending) {
      const ref = references.get(meta.id);
      const expired = now - Date.parse(meta.createdAt) > this.config.pendingTtlMs;
      if (!ref && !expired) continue;
      await this.writes.run(userId, () =>
        this.locks.run(lockKey(userId, meta.id), async () => {
          const current = await this.readMeta(userId, meta.id);
          if (current === null) return;
          if (current.messageId !== null) return; // linked meanwhile
          if (ref) {
            await this.writeMeta(userId, { ...current, ...ref });
            report.linked++;
          } else {
            await this.removeUnlocked(userId, meta.id);
            report.collected++;
          }
        }),
      );
    }
    if (report.linked + report.collected + report.incompleteRemoved > 0)
      this.logger.info({ userId, ...report }, "attachments reconciled");
    return report;
  }

  /** attachment id → the user message that references it, from canonical Markdown. */
  private async references(
    userId: string,
  ): Promise<Map<string, { conversationId: string; messageId: string }>> {
    const refs = new Map<string, { conversationId: string; messageId: string }>();
    for (const name of await listDir(this.paths.chatsDir(userId))) {
      const conversationId = name.endsWith(".md") ? name.slice(0, -3) : "";
      if (!isUuid(conversationId)) continue;
      const bytes = await readOrNull(this.paths.chatFile(userId, conversationId));
      if (!bytes) continue;
      const parsed = parseConversation(bytes.toString("utf8"));
      if (!parsed.ok) continue;
      for (const block of parsed.conversation.blocks)
        if (block.type === "user")
          for (const id of block.attachments ?? [])
            if (!refs.has(id)) refs.set(id, { conversationId, messageId: block.id });
    }
    return refs;
  }
}

function tooLarge(maxFileBytes: number): AppError {
  return new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "The file is too large", { maxFileBytes });
}

/**
 * After an early rejection, reads (and discards) a bounded amount of the rest
 * of the body so the client receives the error response; a client that keeps
 * sending past that is disconnected.
 */
function drain(req: IncomingMessage, maxFileBytes: number): void {
  let drained = 0;
  const cap = maxFileBytes + MULTIPART_OVERHEAD;
  req.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > cap) req.destroy();
  });
  req.resume();
}

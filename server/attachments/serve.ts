// Serving attachment bytes (Phase 12, INV-27): never as an active document.
import type { NextFunction, Response } from "express";
import type { AttachmentDto, AttachmentRef } from "@shared/attachments";
import type { AttachmentMeta, AttachmentStore } from "./store.ts";

/** The four raster image types may be shown inline; everything else downloads. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function attachmentDto(meta: AttachmentMeta): AttachmentDto {
  return {
    id: meta.id,
    filename: meta.filename,
    mediaType: meta.mediaType,
    kind: meta.kind,
    size: meta.size,
    width: meta.width,
    height: meta.height,
    createdAt: meta.createdAt,
    status: meta.messageId === null ? "pending" : "linked",
    conversationId: meta.conversationId,
  };
}

/** Message references; missing or unreadable files become placeholders (contracts §7). */
export async function attachmentRefs(
  store: AttachmentStore,
  userId: string,
  ids: readonly string[],
): Promise<AttachmentRef[]> {
  return Promise.all(
    ids.map(async (id): Promise<AttachmentRef> => {
      const meta = await store.get(userId, id);
      return meta
        ? {
            id,
            missing: false,
            filename: meta.filename,
            mediaType: meta.mediaType,
            kind: meta.kind,
            size: meta.size,
            width: meta.width,
            height: meta.height,
          }
        : { id, missing: true };
    }),
  );
}

/**
 * Sends the stored bytes with the sniffed type, `nosniff`, a sandboxing CSP
 * and a download disposition for everything but raster images. Range
 * requests (audio seeking) are served by `sendFile`.
 */
export function sendAttachment(
  res: Response,
  next: NextFunction,
  store: AttachmentStore,
  userId: string,
  meta: AttachmentMeta,
  download: boolean,
): void {
  const inline = !download && INLINE_TYPES.has(meta.mediaType);
  res.set({
    "Content-Type": meta.kind === "text" ? `${meta.mediaType}; charset=utf-8` : meta.mediaType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", meta.filename),
    // Private to this browser; revalidated (ETag) so a deleted file stops being served.
    "Cache-Control": "private, no-cache",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.sendFile(
    store.blobPath(userId, meta.id),
    { dotfiles: "allow", lastModified: false, etag: true, cacheControl: false },
    (error) => {
      if (error && !res.headersSent) {
        res.removeHeader("Content-Disposition");
        next(error);
      }
    },
  );
}

import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { attachmentDtoSchema, attachmentLimitsSchema } from "@shared/attachments";
import { ErrorCode } from "@shared/errors";
import { canonicalUuid } from "@shared/ids";
import { AppError } from "../errors.ts";
import { defineRawRoute, defineRoute, userOf } from "../registry.ts";
import { toAttachmentDto } from "../storage/attachments.ts";

const idParams = z.strictObject({ id: canonicalUuid });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

/** RFC 6266 / 8187: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** A single `bytes=` range within `size`, "invalid" when unsatisfiable, null when absent/ignored. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multiple or malformed ranges: send the whole file
  const [, a = "", b = ""] = match;
  if (a === "" && b === "") return null;
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

export const uploadAttachmentRoute = defineRoute({
  method: "post",
  path: "/api/attachments",
  auth: "user",
  csrf: "token",
  rateLimit: "upload",
  // multipart/form-data with one `file` part, streamed by the store (not JSON).
  request: {},
  response: attachmentDtoSchema,
  status: 201,
  handler: async (_input, ctx) =>
    toAttachmentDto(await ctx.services.attachments.upload(userOf(ctx).userId, ctx.req)),
  // A request that is not multipart/form-data is rejected before anything is stored.
  fixture: { expectStatus: 400 },
});

export const attachmentLimitsRoute = defineRoute({
  method: "get",
  path: "/api/attachments/limits",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: attachmentLimitsSchema,
  handler: async (_input, ctx) => {
    const limits = ctx.services.attachments.effective();
    return {
      maxFileBytes: limits.maxFileBytes,
      maxPerMessage: limits.maxPerMessage,
      quotaBytes: limits.quotaBytes,
      usedBytes: await ctx.services.attachments.usage(userOf(ctx).userId),
    };
  },
  fixture: {},
});

export const getAttachmentRoute = defineRoute({
  method: "get",
  path: "/api/attachments/:id",
  auth: "user",
  csrf: "none",
  request: { params: idParams },
  response: attachmentDtoSchema,
  handler: async ({ params }, ctx) =>
    toAttachmentDto(await ctx.services.attachments.get(userOf(ctx).userId, params.id)),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const deleteAttachmentRoute = defineRoute({
  method: "delete",
  path: "/api/attachments/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: async ({ params }, ctx) => {
    await ctx.services.attachments.deletePending(userOf(ctx).userId, params.id);
    return { deleted: true as const };
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

/**
 * Attachment bytes (INV-27): the sniffed type with nosniff, a sandboxing CSP,
 * `attachment` disposition except for the four raster image types, private
 * caching validated by the content hash. Never HTML.
 */
export const attachmentContentRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/attachments/:id/content",
  auth: "user",
  csrf: "none",
  request: {
    params: idParams,
    query: z.strictObject({ download: z.literal("1").optional() }),
  },
  handler: async ({ params, query }, ctx) => {
    const { req, res, services } = ctx;
    const userId = userOf(ctx).userId;
    const meta = await services.attachments.get(userId, params.id);
    const inline = meta.kind === "image" && query.download === undefined;
    const etag = `"${meta.sha256}"`;
    res.set({
      "Content-Type": meta.kind === "text" ? `${meta.mediaType}; charset=utf-8` : meta.mediaType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", meta.filename),
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "private, no-cache",
      Vary: "Cookie",
      ETag: etag,
      "Accept-Ranges": "bytes",
    });
    if (req.get("if-none-match") === etag) {
      res.status(304).end();
      return;
    }
    const range = parseRange(req.get("range"), meta.size);
    if (range === "invalid") {
      res
        .status(416)
        .set("Content-Range", `bytes */${String(meta.size)}`)
        .end();
      return;
    }
    const stream = services.attachments.openBlob(userId, meta, range ?? undefined);
    try {
      await once(stream, "open");
    } catch {
      // The blob vanished after the metadata read (deleted concurrently).
      res.removeHeader("Content-Disposition");
      throw new AppError(ErrorCode.NOT_FOUND, "Attachment not found");
    }
    if (range)
      res.status(206).set({
        "Content-Range": `bytes ${String(range.start)}-${String(range.end)}/${String(meta.size)}`,
        "Content-Length": String(range.end - range.start + 1),
      });
    else res.status(200).set("Content-Length", String(meta.size));
    await pipeline(stream, res).catch(() => {
      res.destroy();
    });
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

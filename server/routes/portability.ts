import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import {
  exportResultSchema,
  importCommitSchema,
  importParamsSchema,
  importPreviewSchema,
  importUploadQuerySchema,
} from "@shared/portability";
import { defineRawRoute, defineRoute, userOf } from "../registry.ts";
import { contentDisposition } from "./attachments.ts";

/**
 * Export and import (Phase 13d, INV-42/INV-43). The destination and source
 * are always the session's user; nothing in an archive chooses a path.
 */

const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

/** A file name from a conversation title: printable, no separators, bounded. */
function exportName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${cleaned || "conversation"}.md`;
}

/**
 * The exact canonical Markdown bytes (never parsed and reserialized),
 * malformed files included. No attachments or artifacts: the portable
 * archive has those.
 */
export const exportConversationRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/conversations/:id/export",
  auth: "user",
  csrf: "none",
  request: { params: z.strictObject({ id: canonicalUuid }) },
  handler: async ({ params }, ctx) => {
    const userId = userOf(ctx).userId;
    const bytes = await ctx.services.exports.conversationBytes(userId, params.id);
    const title =
      ctx.services.conversations.list(userId).find((entry) => entry.id === params.id)?.title ??
      "conversation";
    ctx.res
      .status(200)
      .set({
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": contentDisposition("attachment", exportName(title)),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
        "Cache-Control": "private, no-store",
        "Content-Length": String(bytes.length),
      })
      .end(bytes);
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

export const createExportRoute = defineRoute({
  method: "post",
  path: "/api/exports",
  auth: "user",
  csrf: "token",
  request: { body: z.strictObject({}) },
  response: exportResultSchema,
  status: 201,
  handler: (_input, ctx) => ctx.services.exports.create(userOf(ctx).userId),
  fixture: { body: {}, expectStatus: 201 },
});

export const downloadExportRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/exports/:id/download",
  auth: "user",
  csrf: "none",
  request: { params: importParamsSchema },
  handler: async ({ params }, ctx) => {
    const { file, size } = await ctx.services.exports.archive(userOf(ctx).userId, params.id);
    const date = new Date().toISOString().slice(0, 10);
    ctx.res.status(200).set({
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition("attachment", `chatui-export-${date}.zip`),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Length": String(size),
    });
    await pipeline(createReadStream(file), ctx.res).catch(() => {
      ctx.res.destroy();
    });
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

/** The request body is the archive itself (`application/zip`), streamed into staging. */
export const uploadImportRoute = defineRawRoute({
  kind: "raw",
  method: "post",
  path: "/api/imports",
  auth: "user",
  csrf: "token",
  rateLimit: "upload",
  request: { query: importUploadQuerySchema },
  handler: async ({ query }, ctx) => {
    const declared = ctx.req.get("content-length");
    const preview = await ctx.services.imports.receive(
      userOf(ctx).userId,
      ctx.req,
      declared && /^\d+$/.test(declared) ? Number(declared) : null,
      query.tz ?? null,
    );
    ctx.res.status(201).set("Cache-Control", "no-store").json(importPreviewSchema.parse(preview));
  },
  fixture: { expectStatus: 400 },
});

export const getImportRoute = defineRoute({
  method: "get",
  path: "/api/imports/:id",
  auth: "user",
  csrf: "none",
  request: { params: importParamsSchema },
  response: importPreviewSchema,
  handler: ({ params }, ctx) => ctx.services.imports.get(userOf(ctx).userId, params.id),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const commitImportRoute = defineRoute({
  method: "post",
  path: "/api/imports/:id/commit",
  auth: "user",
  csrf: "token",
  request: {
    params: importParamsSchema,
    body: importCommitSchema.extend({ allowRepeat: z.boolean().default(false) }),
  },
  response: importPreviewSchema,
  status: 202,
  handler: ({ params, body }, ctx) =>
    ctx.services.imports.commit(userOf(ctx).userId, params.id, body),
  fixture: { params: unknownId, body: {}, expectStatus: 404 },
});

export const cancelImportRoute = defineRoute({
  method: "delete",
  path: "/api/imports/:id",
  auth: "user",
  csrf: "token",
  request: { params: importParamsSchema },
  response: z.strictObject({ cancelled: z.literal(true) }),
  handler: async ({ params }, ctx) => {
    await ctx.services.imports.cancel(userOf(ctx).userId, params.id);
    return { cancelled: true as const };
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

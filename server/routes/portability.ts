import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import { importCommitSchema, importPreviewSchema, importReportSchema } from "@shared/portability";
import { contentDisposition } from "../attachments/serve.ts";
import { receiveUpload } from "../attachments/upload.ts";
import { exportConversation, markdownFilename } from "../portability/export.ts";
import { defineRawRoute, defineRoute, userOf } from "../registry.ts";

const unknownId = "00000000-0000-4000-8000-000000000000";
const importParams = z.strictObject({ importId: z.string().regex(/^[0-9a-f]{32}$/) });
const unknownImport = { importId: "0".repeat(32) };

/**
 * Single-chat export (Phase 13d): the exact canonical Markdown bytes, a
 * malformed file included as it is. It carries no attached files or files
 * from replies; the full archive does.
 */
export const exportConversationRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/conversations/:id/export",
  auth: "user",
  csrf: "none",
  request: { params: z.strictObject({ id: canonicalUuid }) },
  handler: async ({ params }, ctx) => {
    const { bytes, title } = await exportConversation(
      ctx.services.dataPaths,
      userOf(ctx).userId,
      params.id,
    );
    ctx.res.set({
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": contentDisposition("attachment", markdownFilename(title)),
      "Cache-Control": "no-store",
    });
    ctx.res.end(bytes);
  },
  fixture: { params: { id: unknownId }, expectStatus: 404 },
});

/** The portable archive of everything the user owns (contracts §12, INV-43). */
export const exportArchiveRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/export",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  handler: async (_input, ctx, next) => {
    const file = await ctx.services.exportArchive(userOf(ctx).userId);
    const day = new Date().toISOString().slice(0, 10);
    ctx.res.set({
      "Content-Type": "application/zip",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": contentDisposition("attachment", `chatui-export-${day}.zip`),
      "Cache-Control": "no-store",
    });
    const stream = createReadStream(file);
    const cleanup = () => {
      void rm(file, { force: true });
    };
    stream.on("error", (error) => {
      cleanup();
      next(error);
    });
    stream.on("close", cleanup);
    stream.pipe(ctx.res);
  },
  fixture: { expectStatus: 200 },
});

/** Upload an archive: it is staged and validated, and a preview comes back. Nothing is imported yet. */
export const previewImportRoute = defineRoute({
  method: "post",
  path: "/api/import",
  auth: "user",
  csrf: "token",
  request: { query: z.strictObject({}) },
  response: importPreviewSchema,
  status: 201,
  handler: (_input, ctx) =>
    receiveUpload(ctx.req, ctx.res, (stream) =>
      ctx.services.imports.receive(userOf(ctx).userId, stream),
    ),
  fixture: { expectStatus: 400 },
});

export const commitImportRoute = defineRoute({
  method: "post",
  path: "/api/import/:importId/commit",
  auth: "user",
  csrf: "token",
  request: { params: importParams, body: importCommitSchema },
  response: importReportSchema,
  handler: ({ params, body }, ctx) =>
    ctx.services.imports.commit(userOf(ctx).userId, params.importId, body),
  fixture: {
    params: unknownImport,
    body: { conflicts: "skip", memories: [], preferences: false },
    expectStatus: 404,
  },
});

export const cancelImportRoute = defineRoute({
  method: "delete",
  path: "/api/import/:importId",
  auth: "user",
  csrf: "token",
  request: { params: importParams },
  response: z.strictObject({ cancelled: z.literal(true) }),
  handler: async ({ params }, ctx) => {
    await ctx.services.imports.cancel(userOf(ctx).userId, params.importId);
    return { cancelled: true as const };
  },
  fixture: { params: unknownImport },
});

import { z } from "zod";
import { artifactDtoSchema, artifactListSchema, type ArtifactDto } from "@shared/artifacts";
import { canonicalUuid } from "@shared/ids";
import { ErrorCode } from "@shared/errors";
import { contentDisposition } from "../attachments/serve.ts";
import type { ArtifactMeta } from "../artifacts/store.ts";
import { AppError } from "../errors.ts";
import { defineRawRoute, defineRoute, userOf, type RouteContext } from "../registry.ts";

const idParams = z.strictObject({ id: canonicalUuid });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

function dto(meta: ArtifactMeta, ctx: RouteContext): ArtifactDto {
  return {
    id: meta.id,
    filename: meta.filename,
    mediaType: meta.mediaType,
    size: meta.size,
    createdAt: meta.createdAt,
    conversationId: meta.conversationId,
    conversationAvailable: ctx.services.conversations
      .list(userOf(ctx).userId)
      .some((entry) => entry.id === meta.conversationId),
    assistantMessageId: meta.assistantMessageId,
  };
}

async function owned(ctx: RouteContext, id: string): Promise<ArtifactMeta> {
  const meta = await ctx.services.artifacts.get(userOf(ctx).userId, id);
  // Another account's artifact is indistinguishable from none (INV-15).
  if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "File not found");
  return meta;
}

/** Captured files (Phase 13c): only the signed-in user's, only once finalized. */
export const listArtifactsRoute = defineRoute({
  method: "get",
  path: "/api/artifacts",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: artifactListSchema,
  handler: async (_input, ctx) => ({
    artifacts: (await ctx.services.artifacts.list(userOf(ctx).userId)).map((m) => dto(m, ctx)),
  }),
  fixture: {},
});

export const getArtifactRoute = defineRoute({
  method: "get",
  path: "/api/artifacts/:id",
  auth: "user",
  csrf: "none",
  request: { params: idParams },
  response: artifactDtoSchema,
  handler: async ({ params }, ctx) => dto(await owned(ctx, params.id), ctx),
  fixture: { params: unknownId, expectStatus: 404 },
});

/**
 * The source as inert text (INV-41): always `text/plain`, `nosniff`, a
 * sandboxing CSP and a safe Content-Disposition, so HTML, SVG or scripts
 * never run on the application origin.
 */
export const artifactSourceRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/artifacts/:id/source",
  auth: "user",
  csrf: "none",
  request: { params: idParams, query: z.strictObject({ download: z.literal("1").optional() }) },
  handler: async ({ params, query }, ctx, next) => {
    const meta = await owned(ctx, params.id);
    const res = ctx.res;
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": contentDisposition(
        query.download === "1" ? "attachment" : "inline",
        meta.filename,
      ),
      "Cache-Control": "private, no-cache",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.sendFile(
      ctx.services.artifacts.blobPath(userOf(ctx).userId, meta.id),
      { dotfiles: "allow", lastModified: false, etag: true, cacheControl: false },
      (error) => {
        if (error && !res.headersSent) {
          res.removeHeader("Content-Disposition");
          next(error);
        }
      },
    );
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

/** Deleting a file never touches its chat; it is never captured again (INV-40). */
export const deleteArtifactRoute = defineRoute({
  method: "delete",
  path: "/api/artifacts/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: async ({ params }, ctx) => {
    if (!(await ctx.services.artifacts.delete(userOf(ctx).userId, params.id)))
      throw new AppError(ErrorCode.NOT_FOUND, "File not found");
    return { deleted: true as const };
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

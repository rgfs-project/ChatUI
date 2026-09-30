import { z } from "zod";
import {
  artifactListSchema,
  artifactParamsSchema,
  artifactSourceQuerySchema,
  artifactSummarySchema,
} from "@shared/artifacts";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import { defineRawRoute, defineRoute, userOf } from "../registry.ts";
import { toArtifactSummary } from "../storage/artifacts.ts";
import { contentDisposition } from "./attachments.ts";

/**
 * Generated source artifacts (Phase 13c). Every route is the signed-in
 * user's own: store paths are per user, so another account's id is a 404
 * (INV-39). Source is inert text (INV-41). There is no upload endpoint.
 */

const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

export const listArtifactsRoute = defineRoute({
  method: "get",
  path: "/api/artifacts",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: artifactListSchema,
  handler: async (_input, ctx) => {
    const userId = userOf(ctx).userId;
    const { artifacts, conversations } = ctx.services;
    const live = new Set(conversations.list(userId).map((entry) => entry.id));
    const list = await artifacts.list(userId);
    return {
      artifacts: list.map((meta) =>
        toArtifactSummary(meta, meta.conversationId !== null && live.has(meta.conversationId)),
      ),
      usedBytes: await artifacts.usedBytes(userId),
      quotaBytes: artifacts.config.quotaBytes,
    };
  },
  fixture: {},
});

export const getArtifactRoute = defineRoute({
  method: "get",
  path: "/api/artifacts/:id",
  auth: "user",
  csrf: "none",
  request: { params: artifactParamsSchema },
  response: artifactSummarySchema,
  handler: async ({ params }, ctx) => {
    const userId = userOf(ctx).userId;
    const meta = await ctx.services.artifacts.require(userId, params.id);
    const live =
      meta.conversationId !== null &&
      ctx.services.conversations.list(userId).some((entry) => entry.id === meta.conversationId);
    return toArtifactSummary(meta, live);
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

/**
 * The source as inert text (INV-41): always `text/plain; charset=utf-8`
 * whatever the name says (HTML, SVG and JS never render or run), with
 * `nosniff`, a sandbox CSP that allows nothing, and a safe
 * Content-Disposition built from the display name.
 */
export const artifactSourceRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/artifacts/:id/source",
  auth: "user",
  csrf: "none",
  request: { params: artifactParamsSchema, query: artifactSourceQuerySchema },
  handler: async ({ params, query }, ctx) => {
    const userId = userOf(ctx).userId;
    const meta = await ctx.services.artifacts.require(userId, params.id);
    const bytes = await ctx.services.artifacts.readSource(userId, meta.id);
    if (!bytes) throw new AppError(ErrorCode.NOT_FOUND, "File not found");
    const etag = `"${meta.sha256}"`;
    ctx.res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": contentDisposition(
        query.download === "1" ? "attachment" : "inline",
        meta.name,
      ),
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "private, no-cache",
      Vary: "Cookie",
      ETag: etag,
    });
    if (ctx.req.get("if-none-match") === etag) {
      ctx.res.status(304).end();
      return;
    }
    ctx.res.status(200).set("Content-Length", String(bytes.length)).end(bytes);
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

export const deleteArtifactRoute = defineRoute({
  method: "delete",
  path: "/api/artifacts/:id",
  auth: "user",
  csrf: "token",
  request: { params: artifactParamsSchema },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: async ({ params }, ctx) => {
    const { artifacts, finalizeGeneration } = ctx.services;
    await artifacts.delete(userOf(ctx).userId, params.id, async (meta) => {
      if (meta.generationId) await finalizeGeneration(meta.generationId);
    });
    return { deleted: true as const };
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

import { z } from "zod";
import { artifactDtoSchema, artifactListSchema, type ArtifactDto } from "@shared/artifacts";
import { canonicalUuid } from "@shared/ids";
import { ErrorCode } from "@shared/errors";
import { contentDisposition } from "../attachments/serve.ts";
import { readFile } from "node:fs/promises";
import { isPreviewable } from "../artifacts/preview.ts";
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

/**
 * A single-use link to run one of the user's HTML/SVG files in a sandboxed
 * preview (Phase 19, INV-51, docs/threat-model-19.md). Only with previews on.
 */
export const mintPreviewRoute = defineRoute({
  method: "post",
  path: "/api/artifacts/:id/preview",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: z.strictObject({ url: z.string(), expiresAt: z.string() }),
  handler: async ({ params }, ctx) => {
    const auth = userOf(ctx);
    const prefs = await ctx.services.preferences.get(auth.userId);
    if (prefs.previews !== true)
      throw new AppError(ErrorCode.FORBIDDEN, "Turn on file previews in Settings → Appearance");
    const meta = await owned(ctx, params.id);
    if (!isPreviewable(meta.filename, meta.size))
      throw new AppError(
        ErrorCode.VALIDATION,
        "Only HTML and SVG files up to 512 KB can be previewed",
      );
    const { token, expiresAt } = ctx.services.preview.tokens.mint(auth.userId, meta.id);
    return { url: `${ctx.services.preview.origin ?? ""}/api/preview/${token}`, expiresAt };
  },
  // Previews are off by default, so the fixture is refused before any lookup.
  fixture: { params: unknownId, expectStatus: 403 },
});

/** The preview document's own policy: scripts run, but in an opaque origin with no network. */
function previewPolicy(embedder: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    `frame-ancestors ${embedder}`,
  ].join("; ");
}

/** Every powerful feature off for the preview, the microphone and clipboard included. */
const PREVIEW_PERMISSIONS = [
  "accelerometer=()",
  "camera=()",
  "clipboard-write=()",
  "display-capture=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/**
 * The previewed file, by token only (no session needed or used): exactly the
 * captured bytes, sandboxed by its CSP even when opened directly.
 */
export const previewRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/preview/:token",
  auth: "public",
  csrf: "none",
  request: { params: z.strictObject({ token: z.string().min(1).max(1_024) }) },
  handler: async ({ params }, ctx) => {
    const { preview, artifacts } = ctx.services;
    const claim = preview.tokens.redeem(params.token);
    const meta = claim ? await artifacts.get(claim.userId, claim.artifactId) : null;
    if (!claim || !meta || !isPreviewable(meta.filename, meta.size))
      throw new AppError(ErrorCode.NOT_FOUND, "Preview not found");
    const bytes = await readFile(artifacts.blobPath(claim.userId, meta.id));
    const res = ctx.res;
    // Framing is governed by frame-ancestors (the app only); helmet's DENY would block it.
    res.removeHeader("X-Frame-Options");
    res.set({
      "Content-Type": meta.filename.toLowerCase().endsWith(".svg")
        ? "image/svg+xml; charset=utf-8"
        : "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": previewPolicy(preview.embedder),
      "Permissions-Policy": PREVIEW_PERMISSIONS,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    ctx.services.logger.info({ artifactId: meta.id }, "file preview served");
    res.status(200).end(bytes);
  },
  fixture: { params: { token: "nope" }, expectStatus: 404 },
});

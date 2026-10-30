import { z } from "zod";
import { ErrorCode } from "@shared/errors";
import { PHOTO_SHAPES, profileDtoSchema, profileStatsSchema } from "@shared/profile";
import { contentDisposition } from "../attachments/serve.ts";
import { receiveUpload } from "../attachments/upload.ts";
import { validTimeZone } from "../admin/settings.ts";
import { AppError } from "../errors.ts";
import { defineRawRoute, defineRoute, userOf } from "../registry.ts";

export const getProfileRoute = defineRoute({
  method: "get",
  path: "/api/profile",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: profileDtoSchema,
  handler: (_input, ctx) => ctx.services.profile.dto(userOf(ctx).userId),
  fixture: {},
});

export const updateProfileRoute = defineRoute({
  method: "patch",
  path: "/api/profile",
  auth: "user",
  csrf: "token",
  request: { body: z.strictObject({ shape: z.enum(PHOTO_SHAPES) }) },
  response: profileDtoSchema,
  handler: async ({ body }, ctx) => {
    const { userId } = userOf(ctx);
    await ctx.services.profileStore.setShape(userId, body.shape);
    return ctx.services.profile.dto(userId);
  },
  fixture: { body: { shape: "flower" } },
});

export const uploadPhotoRoute = defineRoute({
  method: "put",
  path: "/api/profile/photo",
  auth: "user",
  csrf: "token",
  rateLimit: "upload",
  // multipart/form-data with one `file` part (cropped to a square in the browser).
  request: {},
  response: profileDtoSchema,
  handler: async (_input, ctx) => {
    const { userId } = userOf(ctx);
    await receiveUpload(ctx.req, ctx.res, (stream, part) =>
      ctx.services.profileStore.setPhoto(userId, stream, part),
    );
    return ctx.services.profile.dto(userId);
  },
  fixture: { expectStatus: 400 },
});

export const deletePhotoRoute = defineRoute({
  method: "delete",
  path: "/api/profile/photo",
  auth: "user",
  csrf: "token",
  request: {},
  response: profileDtoSchema,
  handler: async (_input, ctx) => {
    const { userId } = userOf(ctx);
    await ctx.services.profileStore.removePhoto(userId);
    return ctx.services.profile.dto(userId);
  },
  fixture: {},
});

export const photoContentRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/profile/photo",
  auth: "user",
  csrf: "none",
  // `v` only busts caches; any value is accepted.
  request: { query: z.strictObject({ v: z.string().max(64).optional() }) },
  handler: async (_input, ctx, next) => {
    const { userId } = userOf(ctx);
    const profile = await ctx.services.profileStore.get(userId);
    if (!profile.photo) throw new AppError(ErrorCode.NOT_FOUND, "No profile photo");
    ctx.res.set({
      "Content-Type": profile.photo.mediaType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": contentDisposition("inline", "photo"),
      "Cache-Control": "private, no-cache",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    ctx.res.sendFile(
      ctx.services.profilePhotoPath(userId),
      { lastModified: false, etag: true, cacheControl: false },
      (error) => {
        if (error && !ctx.res.headersSent) next(error);
      },
    );
  },
  fixture: { expectStatus: 404 },
});

export const profileStatsRoute = defineRoute({
  method: "get",
  path: "/api/profile/stats",
  auth: "user",
  csrf: "none",
  request: {
    query: z.strictObject({
      timeZone: z.string().max(64).refine(validTimeZone, "must be an IANA time zone").optional(),
    }),
  },
  response: profileStatsSchema,
  handler: ({ query }, ctx) =>
    ctx.services.profile.stats(userOf(ctx).userId, query.timeZone ?? "UTC"),
  fixture: { query: { timeZone: "Europe/London" } },
});

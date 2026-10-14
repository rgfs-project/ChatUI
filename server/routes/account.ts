import type { Request } from "express";
import { z } from "zod";
import {
  accountDtoSchema,
  ACCOUNT_LIMITS,
  updateAccountSchema,
  type AccountDto,
} from "@shared/account";
import { ErrorCode } from "@shared/errors";
import { canonicalUuid } from "@shared/ids";
import { AppError } from "../errors.ts";
import { defineRawRoute, defineRoute, userOf, type RouteContext } from "../registry.ts";
import { sniffPhoto } from "../storage/profiles.ts";
import { UserError } from "../storage/users.ts";

/**
 * Settings → Account: the signed-in user's own profile. A display name,
 * email and photo are presentation only; the username is how they sign in.
 */

async function accountDto(ctx: RouteContext, userId: string): Promise<AccountDto> {
  const user = await ctx.services.users.get(userId);
  if (!user) throw new AppError(ErrorCode.NOT_FOUND, "Account not found");
  const profile = await ctx.services.profiles.get(userId);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: profile.displayName,
    email: profile.email,
    avatarColor: profile.avatarColor,
    photoVersion: profile.photo?.version ?? null,
    createdAt: user.createdAt,
  };
}

export const getAccountRoute = defineRoute({
  method: "get",
  path: "/api/account",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: accountDtoSchema,
  handler: (_input, ctx) => accountDto(ctx, userOf(ctx).userId),
  fixture: {},
});

export const updateAccountRoute = defineRoute({
  method: "patch",
  path: "/api/account",
  auth: "user",
  csrf: "token",
  request: { body: updateAccountSchema },
  response: accountDtoSchema,
  handler: async ({ body }, ctx) => {
    const userId = userOf(ctx).userId;
    const { username, ...profile } = body;
    if (username !== undefined) {
      try {
        await ctx.services.users.rename(userId, username);
      } catch (error) {
        if (error instanceof UserError && error.kind === "taken")
          throw new AppError(ErrorCode.CONFLICT, "That username is taken");
        if (error instanceof UserError && error.kind === "invalid")
          throw new AppError(ErrorCode.VALIDATION, error.message);
        throw error;
      }
    }
    if (Object.keys(profile).length > 0) await ctx.services.profiles.update(userId, profile);
    return accountDto(ctx, userId);
  },
  fixture: { body: {} },
});

/** Reads the request body, refusing anything over the photo limit. */
async function readPhotoBody(req: Request): Promise<Buffer> {
  const declared = Number(req.get("content-length") ?? "0");
  if (declared > ACCOUNT_LIMITS.photoBytes)
    throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "That photo is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > ACCOUNT_LIMITS.photoBytes) {
      req.destroy();
      throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "That photo is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const putPhotoRoute = defineRoute({
  method: "put",
  path: "/api/account/photo",
  auth: "user",
  csrf: "token",
  rateLimit: "upload",
  // The image bytes themselves (PNG, JPEG or WebP), not JSON.
  request: {},
  response: accountDtoSchema,
  handler: async (_input, ctx) => {
    const userId = userOf(ctx).userId;
    if (!/^image\/(png|jpeg|webp)$/.test(ctx.req.get("content-type") ?? ""))
      throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Photos are PNG, JPEG or WebP");
    const bytes = await readPhotoBody(ctx.req);
    const type = sniffPhoto(bytes);
    if (!type)
      throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "That isn’t a PNG, JPEG or WebP image");
    await ctx.services.profiles.setPhoto(userId, bytes, type);
    return accountDto(ctx, userId);
  },
  fixture: { expectStatus: 415 },
});

export const deletePhotoRoute = defineRoute({
  method: "delete",
  path: "/api/account/photo",
  auth: "user",
  csrf: "token",
  request: {},
  response: accountDtoSchema,
  handler: async (_input, ctx) => {
    const userId = userOf(ctx).userId;
    await ctx.services.profiles.clearPhoto(userId);
    return accountDto(ctx, userId);
  },
  fixture: {},
});

/** The photo bytes: only your own; versioned URLs cache for good. */
export const getPhotoRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/account/photo",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({ u: canonicalUuid, v: z.string().max(64).optional() }) },
  handler: async ({ query }, ctx) => {
    const userId = userOf(ctx).userId;
    const photo = query.u === userId ? await ctx.services.profiles.readPhoto(userId) : null;
    if (!photo) throw new AppError(ErrorCode.NOT_FOUND, "No photo");
    ctx.res.set({
      "Content-Type": photo.type,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control":
        query.v === photo.version ? "private, max-age=31536000, immutable" : "private, no-cache",
      Vary: "Cookie",
      ETag: `"${photo.version}"`,
    });
    ctx.res.status(200).end(photo.bytes);
  },
  fixture: { query: { u: "00000000-0000-4000-8000-000000000000" }, expectStatus: 404 },
});

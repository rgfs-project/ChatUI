import { z } from "zod";
import { attachmentDtoSchema, attachmentListSchema } from "@shared/attachments";
import { ErrorCode } from "@shared/errors";
import { canonicalUuid } from "@shared/ids";
import { attachmentDto, sendAttachment } from "../attachments/serve.ts";
import { receiveUpload } from "../attachments/upload.ts";
import { AppError } from "../errors.ts";
import { defineRawRoute, defineRoute, userOf, type RouteContext } from "../registry.ts";

const idParams = z.strictObject({ id: canonicalUuid });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

/** Another user's attachment and an unknown id look the same (INV-15). */
async function owned(ctx: RouteContext, id: string) {
  const meta = await ctx.services.attachments.get(userOf(ctx).userId, id);
  if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "Attachment not found");
  return meta;
}

export const uploadAttachmentRoute = defineRoute({
  method: "post",
  path: "/api/attachments",
  auth: "user",
  csrf: "token",
  // multipart/form-data with one `file` part; the JSON body parser leaves it unread.
  request: {},
  response: attachmentDtoSchema,
  status: 201,
  handler: async (_input, ctx) =>
    attachmentDto(
      await receiveUpload(ctx.req, ctx.res, ctx.services.attachments, userOf(ctx).userId),
    ),
  fixture: { expectStatus: 400 },
});

export const listAttachmentsRoute = defineRoute({
  method: "get",
  path: "/api/attachments",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: attachmentListSchema,
  handler: async (_input, ctx) => {
    const { userId } = userOf(ctx);
    const limits = ctx.services.attachmentLimits();
    const metas = await ctx.services.attachments.list(userId);
    metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      attachments: metas.map(attachmentDto),
      usedBytes: await ctx.services.attachments.usage(userId),
      quotaBytes: limits.quotaBytes,
      maxBytes: limits.maxBytes,
      maxPerMessage: limits.maxPerMessage,
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
  handler: async ({ params }, ctx) => attachmentDto(await owned(ctx, params.id)),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const attachmentContentRoute = defineRawRoute({
  kind: "raw",
  method: "get",
  path: "/api/attachments/:id/content",
  auth: "user",
  csrf: "none",
  request: { params: idParams, query: z.strictObject({ download: z.literal("1").optional() }) },
  handler: async ({ params, query }, ctx, next) => {
    const meta = await owned(ctx, params.id);
    sendAttachment(
      ctx.res,
      next,
      ctx.services.attachments,
      userOf(ctx).userId,
      meta,
      query.download === "1",
    );
  },
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
    await ctx.services.attachments.removePending(userOf(ctx).userId, params.id);
    return { deleted: true as const };
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

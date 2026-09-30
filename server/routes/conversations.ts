import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import {
  conversationDtoSchema,
  conversationListSchema,
  conversationSummarySchema,
  createConversationSchema,
  renameConversationSchema,
  type ConversationDto,
  type MessageDto,
} from "@shared/conversations";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import { defineRoute, userOf, type RouteServices } from "../registry.ts";
import { toMessageAttachment } from "../storage/attachments.ts";
import { StorageError, type LoadedConversation } from "../storage/conversations.ts";

const idParams = z.strictObject({ id: canonicalUuid });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

export function storageToAppError(error: unknown): unknown {
  if (!(error instanceof StorageError)) return error;
  switch (error.kind) {
    case "not_found":
      return new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
    case "malformed":
      return new AppError(ErrorCode.CONVERSATION_MALFORMED, "This conversation file is malformed");
    case "conflict":
      return new AppError(ErrorCode.CONFLICT, "The conversation changed; reload and try again");
    case "invalid":
      return new AppError(ErrorCode.VALIDATION, error.message);
  }
}

async function mapStorage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw storageToAppError(error);
  }
}

/**
 * Explicit DTO from canonical storage (INV-03): no paths, no raw file text.
 * Attachment metadata comes along; bytes are demand-loaded (Phase 12).
 */
export async function toConversationDto(
  conversation: LoadedConversation,
  services: RouteServices,
  userId: string,
): Promise<ConversationDto> {
  const ids = new Set(
    conversation.model.blocks.flatMap((block) =>
      block.type === "user" ? (block.attachments ?? []) : [],
    ),
  );
  const metas = new Map(
    await Promise.all(
      [...ids].map(async (id) => [id, await services.attachments.readMeta(userId, id)] as const),
    ),
  );
  const messages: MessageDto[] = [];
  let pendingReasoning: string | null = null;
  for (const block of conversation.model.blocks) {
    if (block.type === "reasoning") {
      pendingReasoning = block.body;
      continue;
    }
    messages.push({
      id: block.id,
      role: block.type,
      content: block.body,
      reasoning: block.type === "assistant" ? pendingReasoning : null,
      status: block.type === "assistant" ? block.status : null,
      provider: block.type === "assistant" ? (block.provider ?? null) : null,
      model: block.type === "assistant" ? (block.model ?? null) : null,
      attachments:
        block.type === "user"
          ? (block.attachments ?? []).map((id) => toMessageAttachment(id, metas.get(id) ?? null))
          : [],
      time: block.type === "user" || block.type === "assistant" ? (block.time ?? null) : null,
    });
    pendingReasoning = null;
  }
  const active = services.generations.activeFor(`${userId}/${conversation.id}`);
  return {
    id: conversation.id,
    title: conversation.model.title,
    createdAt: conversation.model.createdAt,
    updatedAt: conversation.model.updatedAt,
    revision: conversation.revision,
    messages,
    activeGeneration: active && !active.startsWith("reserved:") ? { generationId: active } : null,
  };
}

export const listConversationsRoute = defineRoute({
  method: "get",
  path: "/api/conversations",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: conversationListSchema,
  handler: (_input, ctx) => ({
    conversations: ctx.services.conversations.list(userOf(ctx).userId).map((entry) =>
      conversationSummarySchema.parse({
        id: entry.id,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        messageCount: entry.messageCount,
        malformed: entry.malformed,
      }),
    ),
  }),
  fixture: {},
});

export const createConversationRoute = defineRoute({
  method: "post",
  path: "/api/conversations",
  auth: "user",
  csrf: "token",
  request: { body: createConversationSchema },
  response: conversationDtoSchema,
  status: 201,
  handler: ({ body }, ctx) =>
    mapStorage(async () =>
      toConversationDto(
        await ctx.services.conversations.create(userOf(ctx).userId, body.title),
        ctx.services,
        userOf(ctx).userId,
      ),
    ),
  fixture: { body: {} },
});

export const getConversationRoute = defineRoute({
  method: "get",
  path: "/api/conversations/:id",
  auth: "user",
  csrf: "none",
  request: { params: idParams },
  response: conversationDtoSchema,
  handler: ({ params }, ctx) =>
    mapStorage(async () =>
      toConversationDto(
        await ctx.services.conversations.get(userOf(ctx).userId, params.id),
        ctx.services,
        userOf(ctx).userId,
      ),
    ),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const renameConversationRoute = defineRoute({
  method: "patch",
  path: "/api/conversations/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams, body: renameConversationSchema },
  response: conversationDtoSchema,
  handler: ({ params, body }, ctx) =>
    mapStorage(async () =>
      toConversationDto(
        await ctx.services.conversations.rename(
          userOf(ctx).userId,
          params.id,
          body.title,
          body.expectedRevision,
        ),
        ctx.services,
        userOf(ctx).userId,
      ),
    ),
  fixture: { params: unknownId, body: { title: "Renamed" }, expectStatus: 404 },
});

export const deleteConversationRoute = defineRoute({
  method: "delete",
  path: "/api/conversations/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: ({ params }, ctx) =>
    mapStorage(async () => {
      await ctx.services.conversations.delete(userOf(ctx).userId, params.id);
      return { deleted: true as const };
    }),
  fixture: { params: unknownId, expectStatus: 404 },
});

import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import {
  conversationDtoSchema,
  conversationListSchema,
  createConversationSchema,
  deleteExchangeSchema,
  editMessageSchema,
  regenerateSchema,
  renameConversationSchema,
  type ConversationDto,
  type MessageDto,
} from "@shared/conversations";
import { ErrorCode } from "@shared/errors";
import { startGenerationResponseSchema } from "@shared/generations";
import { searchResultsSchema } from "@shared/search";
import { SEARCH_MAX_CHATS, SEARCH_MAX_QUERY } from "../chat/search.ts";
import { attachmentRefs } from "../attachments/serve.ts";
import { AppError } from "../errors.ts";
import { defineRoute, userOf, type RouteServices } from "../registry.ts";
import { conversationSummaries } from "../services/bootstrap.ts";
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
 * Attachment metadata comes along; the bytes are fetched on demand.
 */
export async function toConversationDto(
  conversation: LoadedConversation,
  services: RouteServices,
  userId: string,
): Promise<ConversationDto> {
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
        block.type === "user" && block.attachments
          ? await attachmentRefs(services.attachments, userId, block.attachments)
          : [],
      time: block.type === "user" || block.type === "assistant" ? (block.time ?? null) : null,
      tools: block.type === "assistant" ? (block.tools ?? []) : [],
      artifacts:
        block.type === "assistant"
          ? (await services.artifacts.forMessage(userId, block.id)).map((a) => ({
              id: a.id,
              filename: a.filename,
              mediaType: a.mediaType,
              size: a.size,
            }))
          : [],
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
    proposals: await services.memory.proposalsFor(userId, conversation.id),
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
    conversations: conversationSummaries(ctx.services, userOf(ctx).userId),
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
      await ctx.services.mutations.deleteConversation(userOf(ctx).userId, params.id);
      return { deleted: true as const };
    }),
  fixture: { params: unknownId, expectStatus: 404 },
});

const messageParams = z.strictObject({ id: canonicalUuid, messageId: canonicalUuid });
const unknownMessage = { ...unknownId, messageId: "00000000-0000-4000-8000-0000000000aa" };
const fixtureRevision = "0".repeat(64);

/** Edit a user turn (contracts §4.2): later blocks go; no reply is started. */
export const editMessageRoute = defineRoute({
  method: "patch",
  path: "/api/conversations/:id/messages/:messageId",
  auth: "user",
  csrf: "token",
  request: { params: messageParams, body: editMessageSchema },
  response: conversationDtoSchema,
  handler: async ({ params, body }, ctx) => {
    const { userId } = userOf(ctx);
    return toConversationDto(
      await ctx.services.mutations.edit(userId, params.id, params.messageId, body),
      ctx.services,
      userId,
    );
  },
  fixture: {
    params: unknownMessage,
    body: { content: "x", expectedRevision: fixtureRevision },
    expectStatus: 404,
  },
});

/** Delete exactly one exchange (contracts §4.2). */
export const deleteExchangeRoute = defineRoute({
  method: "delete",
  path: "/api/conversations/:id/messages/:messageId",
  auth: "user",
  csrf: "token",
  request: { params: messageParams, body: deleteExchangeSchema },
  response: conversationDtoSchema,
  handler: async ({ params, body }, ctx) => {
    const { userId } = userOf(ctx);
    return toConversationDto(
      await ctx.services.mutations.deleteExchange(
        userId,
        params.id,
        params.messageId,
        body.expectedRevision,
      ),
      ctx.services,
      userId,
    );
  },
  fixture: {
    params: unknownMessage,
    body: { expectedRevision: fixtureRevision },
    expectStatus: 404,
  },
});

/** Regenerate the reply to a user turn (contracts §4.2); 202 like a send. */
export const regenerateRoute = defineRoute({
  method: "post",
  path: "/api/conversations/:id/messages/:messageId/regenerate",
  auth: "user",
  csrf: "token",
  request: { params: messageParams, body: regenerateSchema },
  response: startGenerationResponseSchema,
  status: 202,
  handler: ({ params, body }, ctx) => {
    const auth = userOf(ctx);
    return ctx.services.send.regenerate(
      auth.userId,
      { ...body, conversationId: params.id, messageId: params.messageId },
      { role: auth.role, username: auth.username },
    );
  },
  fixture: {
    params: unknownMessage,
    body: {
      providerId: "local",
      model: "fixture-missing-model",
      expectedRevision: fixtureRevision,
      operationKey: "00000000-0000-4000-8000-00000000f2f2",
      operationIssuedAt: new Date().toISOString(),
    },
    expectStatus: 400,
  },
});

/** Clear history: every conversation, its files and pins (contracts §4.2). */
export const clearHistoryRoute = defineRoute({
  method: "post",
  path: "/api/conversations/clear",
  auth: "user",
  csrf: "token",
  request: { body: z.strictObject({ confirm: z.literal(true) }) },
  response: z.strictObject({ deleted: z.number().int().nonnegative() }),
  handler: async (_input, ctx) => ({
    deleted: await ctx.services.mutations.clearHistory(userOf(ctx).userId),
  }),
  fixture: { body: { confirm: true } },
});

export const searchRoute = defineRoute({
  method: "get",
  path: "/api/search",
  auth: "user",
  csrf: "none",
  request: {
    query: z.strictObject({
      q: z.string().max(SEARCH_MAX_QUERY),
      limit: z.coerce.number().int().min(1).max(SEARCH_MAX_CHATS).optional(),
    }),
  },
  response: searchResultsSchema,
  handler: ({ query }, ctx) => ctx.services.search.search(userOf(ctx).userId, query.q, query.limit),
  fixture: { query: { q: "hello" } },
});

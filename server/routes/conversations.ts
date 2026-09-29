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
import { defineRoute, type RouteServices } from "../registry.ts";
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

/** Explicit DTO from canonical storage (INV-03): no paths, no raw file text. */
export function toConversationDto(
  conversation: LoadedConversation,
  services: RouteServices,
): ConversationDto {
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
      attachments: block.type === "user" ? (block.attachments ?? []) : [],
      time: block.type === "user" || block.type === "assistant" ? (block.time ?? null) : null,
    });
    pendingReasoning = null;
  }
  const active = services.generations.activeFor(`${services.userId}/${conversation.id}`);
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
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { query: z.strictObject({}) },
  response: conversationListSchema,
  handler: (_input, { services }) => ({
    conversations: services.conversations.list(services.userId).map((entry) =>
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
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { body: createConversationSchema },
  response: conversationDtoSchema,
  status: 201,
  handler: ({ body }, { services }) =>
    mapStorage(async () =>
      toConversationDto(await services.conversations.create(services.userId, body.title), services),
    ),
  fixture: { body: {} },
});

export const getConversationRoute = defineRoute({
  method: "get",
  path: "/api/conversations/:id",
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { params: idParams },
  response: conversationDtoSchema,
  handler: ({ params }, { services }) =>
    mapStorage(async () =>
      toConversationDto(await services.conversations.get(services.userId, params.id), services),
    ),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const renameConversationRoute = defineRoute({
  method: "patch",
  path: "/api/conversations/:id",
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { params: idParams, body: renameConversationSchema },
  response: conversationDtoSchema,
  handler: ({ params, body }, { services }) =>
    mapStorage(async () =>
      toConversationDto(
        await services.conversations.rename(
          services.userId,
          params.id,
          body.title,
          body.expectedRevision,
        ),
        services,
      ),
    ),
  fixture: { params: unknownId, body: { title: "Renamed" }, expectStatus: 404 },
});

export const deleteConversationRoute = defineRoute({
  method: "delete",
  path: "/api/conversations/:id",
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { params: idParams },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: ({ params }, { services }) =>
    mapStorage(async () => {
      await services.conversations.delete(services.userId, params.id);
      return { deleted: true as const };
    }),
  fixture: { params: unknownId, expectStatus: 404 },
});

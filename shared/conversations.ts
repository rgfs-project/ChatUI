import { z } from "zod";
import { artifactRefSchema } from "./artifacts";
import { proposalDtoSchema } from "./memories";
import { attachmentRefSchema } from "./attachments";

/** Conversation DTOs (Phase 3). Browser code imports only the types. */

export const conversationSummarySchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  malformed: z.boolean(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListSchema = z.strictObject({
  conversations: z.array(conversationSummarySchema),
});
export type ConversationList = z.infer<typeof conversationListSchema>;

export const messageDtoSchema = z.strictObject({
  id: z.uuid(),
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
  /** Assistant only: the reasoning block stored with it, if any. */
  reasoning: z.string().nullable(),
  /** Assistant only. */
  status: z.enum(["complete", "cancelled", "failed", "timed_out", "interrupted"]).nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** User messages: attached files (metadata only; missing files are placeholders). */
  attachments: z.array(attachmentRefSchema),
  time: z.string().nullable(),
  /** Assistant only: tools the reply used, as chips (D2). */
  tools: z.array(z.string()),
  /** Assistant only: files captured from the reply (Phase 13c). */
  artifacts: z.array(artifactRefSchema),
});
export type MessageDto = z.infer<typeof messageDtoSchema>;

export const conversationDtoSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** SHA-256 of the canonical file bytes (contracts §4.1). */
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  messages: z.array(messageDtoSchema),
  /** The running generation for this conversation, if any. */
  activeGeneration: z.strictObject({ generationId: z.uuid() }).nullable(),
  /** Memory suggestions from this conversation's replies (Phase 13b). */
  proposals: z.array(proposalDtoSchema),
});
export type ConversationDto = z.infer<typeof conversationDtoSchema>;

const title = z
  .string()
  .refine(
    (value) => Array.from(value).length >= 1 && Array.from(value).length <= 200,
    "must be 1-200 characters",
  )
  .refine((value) => !/[\n\r\u0085\u2028\u2029]/.test(value), "must not contain line breaks");

export const createConversationSchema = z.strictObject({ title: title.optional() });
export const renameConversationSchema = z.strictObject({
  title,
  expectedRevision: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const operationResultSchema = z.strictObject({
  conversationId: z.uuid(),
  generationId: z.uuid(),
  userMessageId: z.uuid(),
  assistantMessageId: z.uuid(),
});

/**
 * A conversation read as a query result (Phase 7): a missing or malformed
 * conversation is a displayable outcome, not a thrown error, so it can be
 * server-rendered and dehydrated like any other result.
 */
export type ConversationResult =
  | { ok: true; conversation: ConversationDto }
  | { ok: false; code: "NOT_FOUND" | "CONVERSATION_MALFORMED" };

const revision = z.string().regex(/^[0-9a-f]{64}$/);

/** Edit a user turn (Phase 13a, contracts §4.2): later blocks are removed. */
export const editMessageSchema = z.strictObject({
  content: z.string().max(100_000),
  /** A subset of the message's current files (omit to keep them all). */
  attachmentIds: z.array(z.uuid()).max(10).optional(),
  expectedRevision: revision,
});

export const deleteExchangeSchema = z.strictObject({ expectedRevision: revision });

/** Regenerate the reply to a user turn (contracts §4.2), idempotent by key (§4.1). */
export const regenerateSchema = z.strictObject({
  providerId: z.string().min(1).max(64),
  model: z.string().trim().min(1).max(200),
  expectedRevision: revision,
  operationKey: z.uuid(),
  operationIssuedAt: z.iso.datetime({ offset: false }),
});

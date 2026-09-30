import { z } from "zod";
import { messageAttachmentSchema } from "./attachments";

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
  /** User only: attachment metadata (bytes are demand-loaded; contracts §7). */
  attachments: z.array(messageAttachmentSchema),
  time: z.string().nullable(),
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

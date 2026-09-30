import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachment-media";
import { messageAttachmentSchema } from "./attachments";
import { canonicalUuid } from "./ids";
import { proposalDtoSchema } from "./memories";

/** Conversation DTOs (Phase 3). Browser code imports only the types. */

export const conversationSummarySchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  malformed: z.boolean(),
  /** Position in the user's pins (Phase 13a), or null when not pinned. */
  pinnedRank: z.number().int().nonnegative().nullable(),
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
  /** Memory suggestions made in this conversation (Phase 13b), oldest first. */
  proposals: z.array(proposalDtoSchema).optional(),
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

const revision = z.string().regex(/^[0-9a-f]{64}$/);

/** Edit user turn k (contracts §4.2): new body/attachments; later blocks are removed. */
export const editMessageSchema = z
  .strictObject({
    content: z.string().max(100_000),
    /** The turn's attachments afterwards: kept ones plus owned pending ones. */
    attachmentIds: z
      .array(canonicalUuid)
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .refine((ids) => new Set(ids).size === ids.length, "must not repeat an attachment")
      .optional(),
    expectedRevision: revision,
  })
  .refine((v) => v.content.trim() !== "" || (v.attachmentIds?.length ?? 0) > 0, {
    path: ["content"],
    message: "must not be empty",
  });
export type EditMessageRequest = z.infer<typeof editMessageSchema>;

/** Regenerate user turn k (contracts §4.2): starts a generation like a send (§4.1). */
export const regenerateSchema = z.strictObject({
  userMessageId: canonicalUuid,
  providerId: z.string().min(1).max(64),
  model: z.string().trim().min(1).max(200),
  expectedRevision: revision,
  operationKey: z.uuid(),
  operationIssuedAt: z.iso.datetime({ offset: false }),
});
export type RegenerateRequest = z.infer<typeof regenerateSchema>;

export const pinsSchema = z.strictObject({ pins: z.array(z.uuid()) });

/** Full-text search (INV-36): bounded query and results. */
export const SEARCH_LIMITS = { maxQuery: 200, maxResults: 50, perConversation: 3 } as const;

export const searchQuerySchema = z.strictObject({
  q: z
    .string()
    .max(SEARCH_LIMITS.maxQuery)
    .refine((q) => q.trim().length > 0, "must not be empty"),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMITS.maxResults).optional(),
});

export const searchResultSchema = z.strictObject({
  conversationId: z.uuid(),
  title: z.string(),
  /** The matching message, or null for a title match. */
  messageId: z.uuid().nullable(),
  role: z.enum(["user", "assistant"]).nullable(),
  /** A bounded snippet around the first match in that text. */
  snippet: z.strictObject({ before: z.string(), match: z.string(), after: z.string() }),
  updatedAt: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.strictObject({
  results: z.array(searchResultSchema),
  /** More matches exist than were returned. */
  truncated: z.boolean(),
  /** Conversations skipped because their files are unreadable. */
  skippedMalformed: z.number().int().nonnegative(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

import { z } from "zod";
import { canonicalUuid } from "./ids";

/** Approved memory (Phase 13b). Browser code imports only the types. */
export const memoryDtoSchema = z.strictObject({
  id: canonicalUuid,
  name: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.string(),
  /** Left out of replies by the memory prompt budget (contracts §12). */
  omitted: z.boolean(),
});
export type MemoryDto = z.infer<typeof memoryDtoSchema>;

export const memoryListSchema = z.strictObject({ memories: z.array(memoryDtoSchema) });
export type MemoryList = z.infer<typeof memoryListSchema>;

export const createMemorySchema = z.strictObject({
  name: z.string().min(1).max(200),
  body: z.string().min(1).max(4_000),
});

export const updateMemorySchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(4_000).optional(),
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
});

export const deleteMemorySchema = z.strictObject({
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
});

/** A model's memory suggestion as the browser sees it (contracts §4.3). */
export const proposalDtoSchema = z.strictObject({
  id: canonicalUuid,
  tool: z.enum(["remember", "update_memory", "forget_memory"]),
  name: z.string(),
  content: z.string().nullable(),
  status: z.enum(["pending", "accepted", "rejected", "invalid", "suppressed"]),
  /** The note changed since the reply: accepting is refused. */
  stale: z.boolean(),
  sourceAssistantMessageId: canonicalUuid,
  createdAt: z.string(),
});
export type ProposalDto = z.infer<typeof proposalDtoSchema>;

export const proposalListSchema = z.strictObject({ proposals: z.array(proposalDtoSchema) });

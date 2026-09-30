import { z } from "zod";
import { canonicalUuid } from "./ids";

/**
 * Approved memories and memory proposals (Phase 13b, contracts §4.3, §12).
 * The browser imports the types and limits; the server validates with the
 * schemas.
 */

export const MEMORY_LIMITS = {
  /** Name length in characters, after trimming. */
  nameMax: 64,
  /** One note's body, UTF-8 bytes. */
  contentMaxBytes: 4_096,
  /** All of a user's notes together, UTF-8 bytes. */
  totalMaxBytes: 65_536,
  /** Notes per user. */
  maxCount: 200,
} as const;

/** Characters a memory name may not contain: line breaks and other control characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Why a name is unacceptable, or undefined (shared by the server's store and the form). */
export function memoryNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > MEMORY_LIMITS.nameMax)
    return `must be 1–${String(MEMORY_LIMITS.nameMax)} characters`;
  if (FORBIDDEN_NAME.test(trimmed)) return "must not contain line breaks or control characters";
  return undefined;
}

/** Unicode NFC plus case folding: the key names are unique by (contracts §12). */
export function memoryNameKey(name: string): string {
  return name.trim().normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const memoryName = z
  .string()
  .max(512)
  .superRefine((value, ctx) => {
    const problem = memoryNameProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .transform((value) => value.trim());

const memoryContent = z
  .string()
  .max(MEMORY_LIMITS.contentMaxBytes)
  .refine((value) => value.trim() !== "", "must not be empty")
  .refine(
    (value) => utf8Bytes(value) <= MEMORY_LIMITS.contentMaxBytes,
    `must be at most ${String(MEMORY_LIMITS.contentMaxBytes)} bytes`,
  );

export const memoryDtoSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** SHA-256 of the file bytes; send it back as `expectedRevision`. */
  revision: z.string(),
});
export type MemoryDto = z.infer<typeof memoryDtoSchema>;

export const memoryListSchema = z.strictObject({
  memories: z.array(memoryDtoSchema),
  /** Notes left out of prompts by `MEMORY_PROMPT_BUDGET` (whole notes, name then id order). */
  omittedIds: z.array(z.uuid()),
  promptBudgetBytes: z.number().int().nonnegative(),
  /** Files that could not be read (never shown to the model). */
  unreadable: z.number().int().nonnegative(),
  limits: z.strictObject({
    nameMax: z.number(),
    contentMaxBytes: z.number(),
    totalMaxBytes: z.number(),
    maxCount: z.number(),
  }),
});
export type MemoryList = z.infer<typeof memoryListSchema>;

export const createMemorySchema = z.strictObject({ name: memoryName, content: memoryContent });
export type CreateMemoryRequest = z.infer<typeof createMemorySchema>;

export const updateMemorySchema = z
  .strictObject({
    name: memoryName.optional(),
    content: memoryContent.optional(),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .refine((value) => value.name !== undefined || value.content !== undefined, {
    message: "name or content is required",
  });
export type UpdateMemoryRequest = z.infer<typeof updateMemorySchema>;

export const deleteMemoryQuerySchema = z.strictObject({
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
});

export const memoryParamsSchema = z.strictObject({ id: canonicalUuid });

// ---------------------------------------------------------------------------
// Proposals

export const PROPOSAL_TOOLS = ["create", "update", "forget"] as const;
export type ProposalTool = (typeof PROPOSAL_TOOLS)[number];

export const PROPOSAL_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "invalid",
  "suppressed",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const proposalDtoSchema = z.strictObject({
  id: z.uuid(),
  generationId: z.uuid(),
  callIndex: z.number().int().nonnegative(),
  userMessageId: z.uuid(),
  assistantMessageId: z.uuid(),
  tool: z.enum(PROPOSAL_TOOLS),
  name: z.string(),
  /** New body for create/update; null for forget. */
  content: z.string().nullable(),
  /** The note an update/forget targets (from the prompt snapshot). */
  targetMemoryId: z.uuid().nullable(),
  status: z.enum(PROPOSAL_STATUSES),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** The note an accepted create/update wrote. */
  resultMemoryId: z.uuid().nullable(),
});
export type ProposalDto = z.infer<typeof proposalDtoSchema>;

export const proposalListSchema = z.strictObject({ proposals: z.array(proposalDtoSchema) });
export type ProposalList = z.infer<typeof proposalListSchema>;

export const proposalParamsSchema = z.strictObject({
  id: canonicalUuid,
  proposalId: canonicalUuid,
});

/** Non-actionable preview sent over SSE while a generation streams (contracts §4.3). */
export const proposalPreviewSchema = z.strictObject({
  id: z.uuid(),
  callIndex: z.number().int().nonnegative(),
  tool: z.enum(PROPOSAL_TOOLS),
  name: z.string(),
  content: z.string().nullable(),
  status: z.enum(["pending", "suppressed"]),
});
export type ProposalPreview = z.infer<typeof proposalPreviewSchema>;

/** Why an acceptance could not be applied (409 CONFLICT `details.reason`). */
export type ProposalConflict =
  "note_changed" | "note_missing" | "name_taken" | "source_removed" | "not_actionable" | "limit";

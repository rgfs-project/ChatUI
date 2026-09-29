import { z } from "zod";
import { ErrorCode } from "./errors";
import { canonicalUuid } from "./ids";
import { GENERATION_STATES, type TerminalState } from "./generation-state";

export * from "./generation-state";

/**
 * Generation and model DTOs (Phase 2). Browser code imports only the types;
 * the schemas are used by the server to validate requests and shape responses.
 */

export const modelDtoSchema = z.strictObject({
  id: z.string(),
  /** Context window in tokens: discovered from the provider, else the configured default. */
  contextTokens: z.number().int().positive(),
  /** Router-mode load state; `unknown` when the provider does not report it. */
  status: z.enum(["loaded", "unloaded", "loading", "unknown"]),
});
export type ModelDto = z.infer<typeof modelDtoSchema>;

export const modelListDtoSchema = z.strictObject({ models: z.array(modelDtoSchema) });
export type ModelListDto = z.infer<typeof modelListDtoSchema>;

export const chatMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(100_000),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const startGenerationRequestSchema = z.strictObject({
  /** Omit for a draft: the server mints the conversation on first send (§4.1). */
  conversationId: canonicalUuid.optional(),
  model: z.string().trim().min(1).max(200),
  content: z
    .string()
    .max(100_000)
    .refine((value) => value.trim() !== "", "must not be empty"),
  /** Client-minted idempotency key for this send (INV-58). */
  operationKey: z.uuid(),
  operationIssuedAt: z.iso.datetime({ offset: false }),
});
export type StartGenerationRequest = z.infer<typeof startGenerationRequestSchema>;

export const startGenerationResponseSchema = z.strictObject({
  conversationId: z.uuid(),
  generationId: z.uuid(),
  userMessageId: z.uuid(),
  assistantMessageId: z.uuid(),
});
export type StartGenerationResponse = z.infer<typeof startGenerationResponseSchema>;

const errorCodes = Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]];

export const generationErrorSchema = z.strictObject({
  code: z.enum(errorCodes),
  message: z.string(),
});
export type GenerationError = z.infer<typeof generationErrorSchema>;

export const generationSnapshotSchema = z.strictObject({
  generationId: z.uuid(),
  assistantMessageId: z.uuid(),
  conversationId: z.uuid(),
  model: z.string(),
  state: z.enum(GENERATION_STATES),
  content: z.string(),
  reasoning: z.string(),
  /** Provider finish reason once completed (e.g. `stop`, `length`). */
  finishReason: z.string().nullable(),
  error: generationErrorSchema.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Conversation revision after the terminal write (null while running or if discarded). */
  revision: z.string().nullable(),
  /** Id of the last event applied to this snapshot (SSE `id`). */
  lastEventId: z.number().int().nonnegative(),
});
export type GenerationSnapshot = z.infer<typeof generationSnapshotSchema>;

/** SSE events on `GET /api/generations/:id/stream`. */
export type GenerationEvent =
  | { type: "snapshot"; id: number; data: GenerationSnapshot }
  | { type: "state"; id: number; data: { state: "streaming" } }
  | { type: "delta"; id: number; data: { content?: string; reasoning?: string } }
  | {
      type: "terminal";
      id: number;
      data: {
        state: TerminalState;
        finishReason: string | null;
        error: GenerationError | null;
        /** Conversation revision computed after the assistant write and any auto-title. */
        revision: string | null;
      };
    };

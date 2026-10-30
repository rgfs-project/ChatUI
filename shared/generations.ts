import { z } from "zod";
import { ErrorCode } from "./errors";
import { canonicalUuid } from "./ids";
import { GENERATION_STATES, type TerminalState } from "./generation-state";

export * from "./generation-state";

/**
 * Generation and model DTOs (Phase 2). Browser code imports only the types;
 * the schemas are used by the server to validate requests and shape responses.
 */

export const capabilitiesSchema = z.strictObject({
  inputModalities: z.array(z.enum(["text", "image", "audio"])),
  reasoning: z.boolean(),
  tools: z.boolean(),
});

export const modelDtoSchema = z.strictObject({
  providerId: z.string(),
  /** Opaque model id: never parsed. */
  id: z.string(),
  /** Context window in tokens: discovered, else provider config, else the default. */
  contextTokens: z.number().int().positive(),
  /** Router-mode load state; `unknown` when the provider does not report it. */
  status: z.enum(["loaded", "unloaded", "loading", "unknown"]),
  capabilities: capabilitiesSchema,
  /** Where each capability came from. */
  capabilitySources: z.strictObject({
    inputModalities: z.enum(["discovery", "config"]),
    reasoning: z.enum(["discovery", "config"]),
    tools: z.enum(["discovery", "config"]),
  }),
});
export type ModelDto = z.infer<typeof modelDtoSchema>;

export const providerDtoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** pending: not yet contacted; stale: last refresh failed; invalid: bad configuration. */
  status: z.enum(["pending", "ok", "stale", "unavailable", "invalid"]),
  capabilities: capabilitiesSchema,
});
export type ProviderDto = z.infer<typeof providerDtoSchema>;

export const providerListDtoSchema = z.strictObject({ providers: z.array(providerDtoSchema) });

export const providerModelsDtoSchema = z.strictObject({
  provider: providerDtoSchema,
  stale: z.boolean(),
  models: z.array(modelDtoSchema),
});
export type ProviderModelsDto = z.infer<typeof providerModelsDtoSchema>;

export const modelListDtoSchema = z.strictObject({ providers: z.array(providerModelsDtoSchema) });
export type ModelListDto = z.infer<typeof modelListDtoSchema>;

export const startGenerationRequestSchema = z
  .strictObject({
    /** Omit for a draft: the server mints the conversation on first send (§4.1). */
    conversationId: canonicalUuid.optional(),
    /** The pair is validated server-side on every send (INV-18). */
    providerId: z.string().min(1).max(64),
    model: z.string().trim().min(1).max(200),
    /** May be empty only when the message carries attachments. */
    content: z.string().max(100_000),
    /** Pending uploads to send with this message (Phase 12), in display order. */
    attachmentIds: z
      .array(canonicalUuid)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length, "must not repeat an attachment")
      .optional(),
    /** Client-minted idempotency key for this send (INV-58). */
    operationKey: z.uuid(),
    operationIssuedAt: z.iso.datetime({ offset: false }),
  })
  .refine((request) => request.content.trim() !== "" || (request.attachmentIds?.length ?? 0) > 0, {
    path: ["content"],
    message: "must not be empty",
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
  providerId: z.string(),
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
  /** The cursor was outside the replay window (or unknown): full state, then live events. */
  | { type: "resync"; id: number; data: GenerationSnapshot }
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

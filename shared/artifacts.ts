import { z } from "zod";
import { canonicalUuid } from "./ids";

/**
 * Generated source artifacts (Phase 13c, contracts §12). The browser imports
 * the types; the server validates and shapes responses with the schemas.
 * Artifacts are inert source: never executed (INV-41).
 */

export const artifactSummarySchema = z.strictObject({
  id: z.uuid(),
  /** Display only; never a filesystem path. */
  name: z.string(),
  /** Info-string language of the fence, if any (display only). */
  language: z.string().nullable(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  conversationId: z.uuid().nullable(),
  assistantMessageId: z.uuid().nullable(),
  captureIndex: z.number().int().nonnegative().nullable(),
  /** The originating conversation still exists (the backlink may be dead). */
  backlinkAvailable: z.boolean(),
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactListSchema = z.strictObject({
  artifacts: z.array(artifactSummarySchema),
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative(),
});
export type ArtifactList = z.infer<typeof artifactListSchema>;

export const artifactParamsSchema = z.strictObject({ id: canonicalUuid });

export const artifactSourceQuerySchema = z.strictObject({
  /** `1`: Content-Disposition attachment (a download); otherwise inline text. */
  download: z.enum(["1"]).optional(),
});

/** Transcript cards: the artifacts one reply produced. */
export const messageArtifactSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  language: z.string().nullable(),
  size: z.number().int().nonnegative(),
  assistantMessageId: z.uuid(),
  captureIndex: z.number().int().nonnegative(),
});
export type MessageArtifactDto = z.infer<typeof messageArtifactSchema>;

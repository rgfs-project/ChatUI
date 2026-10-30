import { z } from "zod";
import { canonicalUuid } from "./ids";

/** A captured file (Phase 13c). Browser code imports only the types. */
export const artifactDtoSchema = z.strictObject({
  id: canonicalUuid,
  filename: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** Backlink; the chat may have been deleted (then `conversationAvailable` is false). */
  conversationId: canonicalUuid,
  conversationAvailable: z.boolean(),
  assistantMessageId: canonicalUuid,
});
export type ArtifactDto = z.infer<typeof artifactDtoSchema>;

export const artifactListSchema = z.strictObject({ artifacts: z.array(artifactDtoSchema) });
export type ArtifactList = z.infer<typeof artifactListSchema>;

/** A reply's files, as listed under it. */
export const artifactRefSchema = z.strictObject({
  id: canonicalUuid,
  filename: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

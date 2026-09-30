import { z } from "zod";
import { ATTACHMENT_KINDS, MEDIA_TYPES, type AttachmentMediaType } from "./attachment-media";

export * from "./attachment-media";

/**
 * Attachment DTOs (Phase 12, contracts §7). Browser code imports only the
 * types from here; values live in `./attachment-media` (no zod).
 */

export const attachmentDtoSchema = z.strictObject({
  id: z.uuid(),
  /** Display only: never used in a path (INV-28). */
  filename: z.string(),
  mediaType: z.enum(MEDIA_TYPES as [AttachmentMediaType, ...AttachmentMediaType[]]),
  kind: z.enum(ATTACHMENT_KINDS),
  size: z.number().int().nonnegative(),
  /** Pixel size of images (null for other kinds). */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Linked to a sent message (no longer deletable on its own). */
  linked: z.boolean(),
});
export type AttachmentDto = z.infer<typeof attachmentDtoSchema>;

/** An attachment as referenced by a message; `missing` when its files are gone (contracts §7). */
export const messageAttachmentSchema = z.strictObject({
  id: z.uuid(),
  missing: z.boolean(),
  filename: z.string().nullable(),
  mediaType: z.string().nullable(),
  kind: z.enum(ATTACHMENT_KINDS).nullable(),
  size: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type MessageAttachmentDto = z.infer<typeof messageAttachmentSchema>;

export const attachmentLimitsSchema = z.strictObject({
  maxFileBytes: z.number().int().positive(),
  maxPerMessage: z.number().int().min(1).max(10),
  quotaBytes: z.number().int().positive(),
  usedBytes: z.number().int().nonnegative(),
});
export type AttachmentLimitsDto = z.infer<typeof attachmentLimitsSchema>;

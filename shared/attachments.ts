import { z } from "zod";

/** Attachment DTOs (Phase 12). Browser code imports only the types. */

export const attachmentKindSchema = z.enum(["image", "audio", "text"]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const attachmentDtoSchema = z.strictObject({
  id: z.uuid(),
  /** Display only. */
  filename: z.string(),
  /** Sniffed from the bytes. */
  mediaType: z.string(),
  kind: attachmentKindSchema,
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  createdAt: z.string(),
  /** `pending` until a sent message links it; `saved`: uploaded to the Library. */
  status: z.enum(["pending", "linked", "saved"]),
  conversationId: z.uuid().nullable(),
});
export type AttachmentDto = z.infer<typeof attachmentDtoSchema>;

export const attachmentListSchema = z.strictObject({
  attachments: z.array(attachmentDtoSchema),
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().nonnegative(),
  maxPerMessage: z.number().int().positive(),
});
export type AttachmentList = z.infer<typeof attachmentListSchema>;

/** An attachment as a message shows it; a missing file is a placeholder, never an error. */
export const attachmentRefSchema = z.discriminatedUnion("missing", [
  z.strictObject({
    id: z.uuid(),
    missing: z.literal(false),
    filename: z.string(),
    mediaType: z.string(),
    kind: attachmentKindSchema,
    size: z.number().int().nonnegative(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }),
  z.strictObject({ id: z.uuid(), missing: z.literal(true) }),
]);
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

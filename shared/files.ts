import { z } from "zod";

/**
 * The Files page: every file a user has on the server, in one list. Uploads
 * (attached to a message, or kept from the Files page) and reply files (source
 * captured from replies). Each names the chat it came from, if any.
 */
export const FILE_CATEGORIES = ["image", "document", "code", "audio", "data", "other"] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const fileItemSchema = z.strictObject({
  id: z.uuid(),
  /** "upload": an attachment; "reply": a file a reply produced. */
  origin: z.enum(["upload", "reply"]),
  name: z.string(),
  mediaType: z.string(),
  /** A short kind for people ("PDF", "Image", "Python"). */
  kindLabel: z.string(),
  category: z.enum(FILE_CATEGORIES),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
  conversationId: z.uuid().nullable(),
  /** The chat's title now, or null when the file has no chat or the chat is gone. */
  conversationTitle: z.string().nullable(),
  /** The message to scroll to in that chat. */
  messageId: z.uuid().nullable(),
  /** Where the bytes download from. */
  downloadUrl: z.string(),
});
export type FileItem = z.infer<typeof fileItemSchema>;

export const fileListSchema = z.strictObject({
  files: z.array(fileItemSchema),
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative(),
});
export type FileList = z.infer<typeof fileListSchema>;

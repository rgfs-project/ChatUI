import { z } from "zod";

/**
 * Settings → Usage: what this account has done and keeps on the server,
 * worked out from its own files. Counts only, never content.
 */
export const usageDtoSchema = z.strictObject({
  chats: z.number().int().nonnegative(),
  archivedChats: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  messages: z.strictObject({
    sent: z.number().int().nonnegative(),
    replies: z.number().int().nonnegative(),
  }),
  /** Messages per day for the last 30 days, oldest first (UTC dates). */
  days: z.array(
    z.strictObject({
      date: z.string(),
      sent: z.number().int().nonnegative(),
      replies: z.number().int().nonnegative(),
    }),
  ),
  /** Replies per model, most used first. */
  models: z.array(
    z.strictObject({
      provider: z.string(),
      model: z.string(),
      replies: z.number().int().nonnegative(),
    }),
  ),
  storage: z.strictObject({
    chatsBytes: z.number().int().nonnegative(),
    attachmentsBytes: z.number().int().nonnegative(),
    filesBytes: z.number().int().nonnegative(),
    /** The attachment quota (files count against their own quota). */
    attachmentQuotaBytes: z.number().int().nonnegative(),
    filesQuotaBytes: z.number().int().nonnegative(),
  }),
  memories: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
});
export type UsageDto = z.infer<typeof usageDtoSchema>;

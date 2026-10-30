import { z } from "zod";

/** What an archive would import (Phase 13d). Browser code imports only the types. */
export const importPreviewSchema = z.strictObject({
  importId: z.string().regex(/^[0-9a-f]{32}$/),
  /** Derived from the manifest: the same archive always has the same key. */
  idempotencyKey: z.string(),
  alreadyImported: z.boolean(),
  exportedAt: z.string().nullable(),
  chats: z.strictObject({
    new: z.number().int(),
    present: z.number().int(),
    conflict: z.number().int(),
    malformed: z.number().int(),
  }),
  files: z.number().int(),
  filesFromReplies: z.number().int(),
  suggestions: z.number().int(),
  memories: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      body: z.string(),
      status: z.enum(["new", "present", "conflict", "name_taken"]),
    }),
  ),
  hasPreferences: z.boolean(),
  conflicts: z.array(z.strictObject({ kind: z.string(), id: z.string(), label: z.string() })),
  skipped: z.array(z.strictObject({ kind: z.string(), id: z.string(), reason: z.string() })),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const importCommitSchema = z.strictObject({
  conflicts: z.enum(["skip", "copy"]),
  memories: z.array(z.string().max(64)).max(1_000),
  preferences: z.boolean(),
});

export const importReportSchema = z.strictObject({
  counts: z.strictObject({
    conversations: z.number().int(),
    files: z.number().int(),
    filesFromReplies: z.number().int(),
    memories: z.number().int(),
    suggestions: z.number().int(),
    present: z.number().int(),
    rewritten: z.number().int(),
  }),
  skipped: z.array(z.strictObject({ kind: z.string(), id: z.string(), reason: z.string() })),
  /** Chats whose bytes changed because their file ids were remapped. */
  rewrittenChats: z.array(z.string()),
});
export type ImportReport = z.infer<typeof importReportSchema>;

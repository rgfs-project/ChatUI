import { z } from "zod";
import { attachmentKindSchema } from "./attachments";

/** Search DTOs (Phase 13a). Browser code imports only the types. */
export const searchResultsSchema = z.strictObject({
  /** The normalized query the results are for. */
  query: z.string(),
  chats: z.array(
    z.strictObject({
      conversationId: z.uuid(),
      title: z.string(),
      updatedAt: z.string(),
      /** Occurrences in the title and messages. */
      matches: z.number().int().positive(),
      /** The first matching message, if the match is not only in the title. */
      first: z
        .strictObject({
          messageId: z.uuid(),
          text: z.string(),
          /** Start and end of the match within `text`. */
          match: z.tuple([z.number().int(), z.number().int()]),
        })
        .nullable(),
    }),
  ),
  files: z.array(
    z.strictObject({
      id: z.uuid(),
      filename: z.string(),
      kind: attachmentKindSchema,
      conversationId: z.uuid().nullable(),
    }),
  ),
});
export type SearchResults = z.infer<typeof searchResultsSchema>;

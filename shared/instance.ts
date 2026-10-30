import { z } from "zod";

/** Public instance information (Phase 10): what every signed-in page may show. */
export const instanceDtoSchema = z.strictObject({
  /** Admin-set banner, or null. */
  notice: z.string().nullable(),
  /** Admin default model for new chats, or null. */
  defaultModel: z.strictObject({ providerId: z.string(), modelId: z.string() }).nullable(),
});
export type InstanceDto = z.infer<typeof instanceDtoSchema>;

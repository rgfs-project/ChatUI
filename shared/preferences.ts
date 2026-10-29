import { z } from "zod";
import { canonicalUuid } from "./ids";

/** Preferences DTO (Phase 4). Browser code imports only the type. */
export const preferencesDtoSchema = z.strictObject({
  pins: z.array(canonicalUuid).max(500),
  defaultProvider: z.string().max(200).nullable(),
  defaultModel: z.string().max(200).nullable(),
  historyImages: z.enum(["include", "omit"]).nullable(),
  imageMaxEdge: z.number().int().min(0).max(16_384).nullable(),
});
export type PreferencesDto = z.infer<typeof preferencesDtoSchema>;

import { z } from "zod";
import { canonicalUuid } from "./ids";

/** Preferences DTO (Phase 4). Browser code imports only the type. */
export const preferencesDtoSchema = z.strictObject({
  pins: z.array(canonicalUuid).max(500),
  defaultProvider: z.string().max(200).nullable(),
  defaultModel: z.string().max(200).nullable(),
  historyImages: z.enum(["include", "omit"]).nullable(),
  imageMaxEdge: z.number().int().min(0).max(16_384).nullable(),
  /** Render ```ui blocks (Phase 14b); null = default (on). */
  uiBlocks: z.boolean().nullable(),
  /** Thumbs up/down on replies (Phase 14b), changed through the feedback endpoint. */
  feedback: z.record(canonicalUuid, z.enum(["up", "down"])),
  /** Projects (Phase 13g), changed only through the project endpoints. */
  projects: z.array(z.strictObject({ id: canonicalUuid, name: z.string(), createdAt: z.string() })),
  chatProjects: z.record(canonicalUuid, canonicalUuid),
});
export type PreferencesDto = z.infer<typeof preferencesDtoSchema>;

/** What PATCH /api/preferences may change (projects have their own endpoints). */
export const preferencesPatchSchema = preferencesDtoSchema
  .omit({ projects: true, chatProjects: true, feedback: true })
  .partial();

export const projectNameSchema = z.strictObject({ name: z.string().min(1).max(200) });
export const moveToProjectSchema = z.strictObject({ projectId: canonicalUuid.nullable() });

export const feedbackSchema = z.strictObject({ value: z.enum(["up", "down"]).nullable() });

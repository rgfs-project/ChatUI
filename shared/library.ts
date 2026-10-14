import { z } from "zod";
import { LIBRARY_LIMITS } from "./library-limits";

export { LIBRARY_LIMITS };

/**
 * How a user organises chats: projects that group them, and an archive that
 * keeps them out of the sidebar without deleting them. Canonical per user in
 * `library.json` (like pins in preferences), joined into the chat list.
 */
export const projectNameSchema = z.string().trim().min(1).max(LIBRARY_LIMITS.projectName);

export const projectDtoSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  /** Added to the system prompt of every chat in the project. */
  instructions: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Chats in it (archived ones included). */
  chatCount: z.number().int().nonnegative(),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

export const projectListSchema = z.strictObject({ projects: z.array(projectDtoSchema) });

const projectDescriptionSchema = z.string().trim().max(LIBRARY_LIMITS.projectDescription);
const projectInstructionsSchema = z.string().trim().max(LIBRARY_LIMITS.projectInstructions);

export const createProjectSchema = z.strictObject({
  name: projectNameSchema,
  description: projectDescriptionSchema.optional(),
  instructions: projectInstructionsSchema.optional(),
});
/** Changes any of a project's name, description and instructions. */
export const updateProjectSchema = z
  .strictObject({
    name: projectNameSchema.optional(),
    description: projectDescriptionSchema.optional(),
    instructions: projectInstructionsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "nothing to change");
export type ProjectChanges = z.infer<typeof updateProjectSchema>;
/** Moves a chat into a project, or out of every project (null). */
export const moveChatSchema = z.strictObject({ projectId: z.uuid().nullable() });

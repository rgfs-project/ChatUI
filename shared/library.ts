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
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Chats in it (archived ones included). */
  chatCount: z.number().int().nonnegative(),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

export const projectListSchema = z.strictObject({ projects: z.array(projectDtoSchema) });

export const createProjectSchema = z.strictObject({ name: projectNameSchema });
export const renameProjectSchema = z.strictObject({ name: projectNameSchema });
/** Moves a chat into a project, or out of every project (null). */
export const moveChatSchema = z.strictObject({ projectId: z.uuid().nullable() });

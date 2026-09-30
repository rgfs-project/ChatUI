import { z } from "zod";

/**
 * Skills (user request, Phase 10): per-user named instruction sets. Typing
 * "/name" at the start of a message applies the skill to that message; the
 * server expands it when assembling the prompt.
 */

/** Built-in composer commands a skill may not shadow. */
export const RESERVED_SKILL_NAMES = ["model", "new", "rename", "delete", "settings"] as const;

export const SKILL_LIMITS = {
  maxSkills: 100,
  nameLength: 40,
  descriptionLength: 300,
  instructionsLength: 20_000,
} as const;

/** Lowercase letters, digits and hyphens; starts with a letter or digit. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const skillNameSchema = z
  .string()
  .min(1)
  .max(SKILL_LIMITS.nameLength)
  .regex(SKILL_NAME, "Use lowercase letters, digits and hyphens")
  .refine(
    (name) => !(RESERVED_SKILL_NAMES as readonly string[]).includes(name),
    "That name is a built-in command",
  );

export const skillDtoSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SkillDto = z.infer<typeof skillDtoSchema>;

export const createSkillSchema = z.strictObject({
  name: skillNameSchema,
  description: z.string().trim().max(SKILL_LIMITS.descriptionLength),
  instructions: z.string().trim().min(1).max(SKILL_LIMITS.instructionsLength),
  enabled: z.boolean().default(true),
});
export type CreateSkill = z.infer<typeof createSkillSchema>;

export const updateSkillSchema = z
  .strictObject({
    name: skillNameSchema,
    description: z.string().trim().max(SKILL_LIMITS.descriptionLength),
    instructions: z.string().trim().min(1).max(SKILL_LIMITS.instructionsLength),
    enabled: z.boolean(),
  })
  .partial();
export type UpdateSkill = z.infer<typeof updateSkillSchema>;

/** The skill a message invokes: its leading "/name", or null. */
export function invokedSkill(content: string): { name: string; rest: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+|$)/.exec(content);
  if (!match?.[1]) return null;
  return { name: match[1], rest: content.slice(match[0].length) };
}

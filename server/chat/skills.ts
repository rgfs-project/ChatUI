import { invokedSkill, type SkillDto } from "@shared/skills";

/**
 * Expands a user message that starts with "/name" for one of the user's
 * enabled skills: the skill's instructions go in front of the rest of the
 * message, inside the same user turn (no mid-conversation system messages,
 * which many chat templates reject). The stored message keeps "/name", so a
 * later turn replays the skill the same way; an unknown or disabled name is
 * left as typed. Instructions are inserted once and never expanded again.
 */
export function expandSkill(content: string, skills: ReadonlyMap<string, SkillDto>): string {
  const invoked = invokedSkill(content);
  const skill = invoked ? skills.get(invoked.name) : undefined;
  if (!invoked || !skill) return content;
  const block = `<skill name="${skill.name}">\n${skill.instructions}\n</skill>`;
  return invoked.rest.trim() === "" ? block : `${block}\n\n${invoked.rest}`;
}

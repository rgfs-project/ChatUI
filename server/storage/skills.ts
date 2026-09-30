// Per-user skills (user request, Phase 10): `users/<id>/skills.json`.
import { randomUUID } from "node:crypto";
import { SKILL_LIMITS, type CreateSkill, type SkillDto, type UpdateSkill } from "@shared/skills";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import type { AccountWrites } from "./account.ts";
import { atomicWrite, readOrNull } from "./fs.ts";
import type { KeyedLocks } from "./locks.ts";
import type { DataPaths } from "./paths.ts";

interface SkillsFile {
  version: 1;
  skills: SkillDto[];
}

function isSkill(value: unknown): value is SkillDto {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.description === "string" &&
    typeof s.instructions === "string" &&
    typeof s.enabled === "boolean" &&
    typeof s.createdAt === "string" &&
    typeof s.updatedAt === "string"
  );
}

/**
 * A user's skills. Writes run under the per-user lock and the account-write
 * guard (so account closure never races them, INV-61) and replace the file
 * atomically. A missing or corrupt file reads as no skills; invalid entries
 * are skipped rather than failing the whole list.
 */
export class SkillsStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly writes: AccountWrites | undefined;
  private readonly now: () => Date;

  constructor(paths: DataPaths, locks: KeyedLocks, writes?: AccountWrites, now = () => new Date()) {
    this.paths = paths;
    this.locks = locks;
    this.writes = writes;
    this.now = now;
  }

  async list(userId: string): Promise<SkillDto[]> {
    const bytes = await readOrNull(this.paths.skillsFile(userId));
    if (!bytes) return [];
    try {
      const raw = JSON.parse(bytes.toString("utf8")) as { skills?: unknown };
      return Array.isArray(raw.skills) ? raw.skills.filter(isSkill) : [];
    } catch {
      return [];
    }
  }

  /** Enabled skills by name, for prompt assembly. */
  async enabled(userId: string): Promise<Map<string, SkillDto>> {
    return new Map(
      (await this.list(userId)).filter((s) => s.enabled).map((s) => [s.name, s] as const),
    );
  }

  create(userId: string, input: CreateSkill): Promise<SkillDto> {
    return this.mutate(userId, (skills) => {
      if (skills.length >= SKILL_LIMITS.maxSkills)
        throw new AppError(ErrorCode.CONFLICT, "You have reached the skill limit");
      this.assertFreeName(skills, input.name);
      const at = this.now().toISOString();
      const skill: SkillDto = {
        id: randomUUID(),
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        enabled: input.enabled,
        createdAt: at,
        updatedAt: at,
      };
      return { skills: [...skills, skill], result: skill };
    });
  }

  update(userId: string, id: string, patch: UpdateSkill): Promise<SkillDto> {
    return this.mutate(userId, (skills) => {
      const current = skills.find((s) => s.id === id);
      if (!current) throw new AppError(ErrorCode.NOT_FOUND, "Skill not found");
      if (patch.name !== undefined && patch.name !== current.name)
        this.assertFreeName(skills, patch.name);
      const next: SkillDto = {
        ...current,
        ...patch,
        updatedAt: this.now().toISOString(),
      };
      return { skills: skills.map((s) => (s.id === id ? next : s)), result: next };
    });
  }

  remove(userId: string, id: string): Promise<void> {
    return this.mutate(userId, (skills) => {
      if (!skills.some((s) => s.id === id))
        throw new AppError(ErrorCode.NOT_FOUND, "Skill not found");
      return { skills: skills.filter((s) => s.id !== id), result: undefined };
    });
  }

  private assertFreeName(skills: SkillDto[], name: string): void {
    if (skills.some((s) => s.name === name))
      throw new AppError(ErrorCode.CONFLICT, `A skill named "${name}" already exists`);
  }

  private mutate<T>(
    userId: string,
    change: (skills: SkillDto[]) => { skills: SkillDto[]; result: T },
  ): Promise<T> {
    const write = () =>
      this.locks.run(`skills:${userId}`, async () => {
        const { skills, result } = change(await this.list(userId));
        const file: SkillsFile = { version: 1, skills };
        await atomicWrite(this.paths.skillsFile(userId), `${JSON.stringify(file, null, 2)}\n`);
        return result;
      });
    return this.writes ? this.writes.run(userId, write) : write();
  }
}

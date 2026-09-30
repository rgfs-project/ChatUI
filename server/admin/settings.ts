import { createHash } from "node:crypto";
import { z } from "zod";
import type { Logger } from "../logger.ts";
import { atomicWrite, ensureDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import type { DataPaths } from "../storage/paths.ts";

/**
 * Instance settings, `_system/settings.json` (Phase 10). Canonical and
 * admin-edited; a missing file means defaults, a corrupt one degrades to
 * defaults (reported to admins, never silently rewritten).
 */

/** Template variables allowed in system prompts: stable, server-owned values only. */
export const SYSTEM_PROMPT_VARIABLES = ["username", "date", "timezone"] as const;
const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function templateProblem(text: string): string | undefined {
  for (const match of text.matchAll(VARIABLE)) {
    const name = match[1] ?? "";
    if (name === "time")
      return "{{time}} can't be used in a system prompt (it would change the prompt prefix every minute); enable the time context instead";
    if (!(SYSTEM_PROMPT_VARIABLES as readonly string[]).includes(name))
      return `unknown template variable {{${name}}}; allowed: ${SYSTEM_PROMPT_VARIABLES.map((v) => `{{${v}}}`).join(", ")}`;
  }
  return undefined;
}

const modelRef = {
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(200),
};

export const modelSettingsSchema = z.strictObject({
  ...modelRef,
  /** Hidden from users; hidden pairs fail validation for non-admins. */
  hidden: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().gt(0).max(1).optional(),
  topK: z.number().int().min(1).max(1_000).optional(),
  minP: z.number().min(0).max(1).optional(),
  repeatPenalty: z.number().min(0.5).max(2).optional(),
  systemPrompt: z
    .string()
    .max(20_000)
    .superRefine((text, ctx) => {
      const problem = templateProblem(text);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .optional(),
  /** Adds "current time" in a context block before the newest user message. */
  timeContext: z.boolean().optional(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const instanceSettingsSchema = z.strictObject({
  version: z.literal(1),
  /** Overrides REGISTRATION_MODE once set. */
  registrationMode: z.enum(["open", "closed"]).optional(),
  defaultModel: z.strictObject(modelRef).nullable().optional(),
  timezone: z.string().max(64).refine(validTimeZone, "unknown IANA time zone").optional(),
  generation: z
    .strictObject({
      maxActivePerUser: z.number().int().min(1).max(32).optional(),
      maxOutputTokens: z.number().int().min(16).max(65_536).optional(),
    })
    .optional(),
  models: z.array(modelSettingsSchema).max(2_000),
});
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;

export const DEFAULT_SETTINGS: InstanceSettings = { version: 1, models: [] };

export interface ResolvedModelSettings {
  instructions: string | undefined;
  contextBlock: string | undefined;
  sampling: {
    temperature?: number;
    topP?: number;
    topK?: number;
    minP?: number;
    repeatPenalty?: number;
  };
  /** Hash of everything prompt-relevant here (contracts §4.1 revisions). */
  revision: string;
}

/** Sampling fields only llama.cpp-style servers accept (not plain OpenAI APIs). */
export const EXTENDED_SAMPLING = ["topK", "minP", "repeatPenalty"] as const;

export class SettingsStore {
  private current: InstanceSettings = DEFAULT_SETTINGS;
  /** Set when the file on disk could not be read; admins see it. */
  problem: string | null = null;
  private readonly file: string;
  private readonly options: {
    paths: DataPaths;
    locks: KeyedLocks;
    logger: Logger;
    onChange?: (settings: InstanceSettings) => void;
  };

  constructor(options: SettingsStore["options"]) {
    this.options = options;
    this.file = `${options.paths.systemDir()}/settings.json`;
  }

  async load(): Promise<InstanceSettings> {
    const bytes = await readOrNull(this.file);
    if (!bytes) {
      this.current = DEFAULT_SETTINGS;
      this.problem = null;
    } else {
      try {
        const parsed = instanceSettingsSchema.safeParse(JSON.parse(bytes.toString("utf8")));
        if (parsed.success) {
          this.current = parsed.data;
          this.problem = null;
        } else {
          this.current = DEFAULT_SETTINGS;
          this.problem = parsed.error.issues
            .map((i) => `${i.path.join(".") || "file"}: ${i.message}`)
            .join("; ");
        }
      } catch {
        this.current = DEFAULT_SETTINGS;
        this.problem = "settings.json is not valid JSON";
      }
      if (this.problem)
        this.options.logger.error(
          { problem: this.problem },
          "settings.json is invalid; using defaults until an admin saves settings",
        );
    }
    this.options.onChange?.(this.current);
    return this.current;
  }

  get(): InstanceSettings {
    return this.current;
  }

  /** Validated read-modify-write under the settings lock; atomic on disk. */
  async update(change: (current: InstanceSettings) => InstanceSettings): Promise<InstanceSettings> {
    return this.options.locks.run("settings", async () => {
      const next = instanceSettingsSchema.parse(change(structuredClone(this.current)));
      await ensureDir(this.options.paths.systemDir());
      await atomicWrite(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.current = next;
      this.problem = null;
      this.options.onChange?.(next);
      return next;
    });
  }

  modelSettings(providerId: string, modelId: string): ModelSettings | undefined {
    return this.current.models.find((m) => m.providerId === providerId && m.modelId === modelId);
  }

  isHidden(providerId: string, modelId: string): boolean {
    return this.modelSettings(providerId, modelId)?.hidden === true;
  }

  /**
   * Resolves a model's prompt settings for one send. Template variables are
   * expanded exactly once from server-owned values; user and memory text is
   * never expanded.
   */
  resolve(
    providerId: string,
    modelId: string,
    context: { username: string; now: Date },
  ): ResolvedModelSettings {
    const m = this.modelSettings(providerId, modelId);
    const zone = this.current.timezone ?? "UTC";
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(context.now);
    const values: Record<string, string> = { username: context.username, date, timezone: zone };
    const instructions = m?.systemPrompt
      ? m.systemPrompt.replace(VARIABLE, (_all, name: string) => values[name] ?? "")
      : undefined;
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(context.now);
    const contextBlock = m?.timeContext
      ? `[Context: the current time is ${time} (${zone}).]`
      : undefined;
    const sampling: ResolvedModelSettings["sampling"] = {};
    if (m?.temperature !== undefined) sampling.temperature = m.temperature;
    if (m?.topP !== undefined) sampling.topP = m.topP;
    if (m?.topK !== undefined) sampling.topK = m.topK;
    if (m?.minP !== undefined) sampling.minP = m.minP;
    if (m?.repeatPenalty !== undefined) sampling.repeatPenalty = m.repeatPenalty;
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          template: m?.systemPrompt ?? null,
          instructions: instructions ?? null,
          sampling,
          timeContext: m?.timeContext ?? false,
        }),
      )
      .digest("hex");
    return { instructions, contextBlock, sampling, revision };
  }
}

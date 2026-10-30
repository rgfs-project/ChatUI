// Instance and per-model settings (Phase 10): _system/settings.json, canonical.
import { createHash } from "node:crypto";
import { z } from "zod";
import { atomicWrite, ensureDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import type { DataPaths } from "../storage/paths.ts";

/** Sampling overrides; ranges accepted by OpenAI-compatible llama.cpp servers. */
export const samplingSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().gt(0).max(1).optional(),
  topK: z.number().int().min(0).max(1000).optional(),
  minP: z.number().min(0).max(1).optional(),
  repeatPenalty: z.number().min(0.5).max(2).optional(),
});
export type Sampling = z.infer<typeof samplingSchema>;

/** Server-owned template variables; anything else in `{{…}}` is rejected. */
export const TEMPLATE_VARIABLES = ["username", "date", "timezone", "time"] as const;

export const systemPromptSchema = z
  .string()
  .max(8_000)
  .refine(
    (value) =>
      [...value.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].every((m) =>
        (TEMPLATE_VARIABLES as readonly string[]).includes((m[1] ?? "").toLowerCase()),
      ),
    `only these variables are allowed: ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}`,
  );

export const modelSettingsSchema = z.strictObject({
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(200),
  hidden: z.boolean(),
  sampling: samplingSchema,
  systemPrompt: systemPromptSchema.nullable(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const instanceSettingsSchema = z.strictObject({
  version: z.literal(1),
  /** Overrides REGISTRATION_MODE once set. */
  registrationMode: z.enum(["open", "closed"]).nullable(),
  defaultModel: z.strictObject({ providerId: z.string(), modelId: z.string() }).nullable(),
  /** A dismissable banner shown to every signed-in user. */
  notice: z.string().trim().max(500).nullable(),
  /** Caps output tokens below the environment limit (never above it). */
  maxOutputTokens: z.number().int().min(16).max(1_000_000).nullable(),
  /** Time zone for the {{date}}, {{timezone}} and {{time}} template values. */
  timeZone: z.string().max(64),
  models: z.array(modelSettingsSchema).max(2_000),
});
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;

export const DEFAULT_SETTINGS: InstanceSettings = {
  version: 1,
  registrationMode: null,
  defaultModel: null,
  notice: null,
  maxOutputTokens: null,
  timeZone: "UTC",
  models: [],
};

export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const LOCK = "settings";

/**
 * Settings are canonical: edits are atomic and serialized under one lock, the
 * file is re-read at startup (persisted admin edits win over the environment),
 * and the revision (SHA-256 of the bytes) is a prompt-relevant revision (§4.1).
 */
export class SettingsStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private current: InstanceSettings = DEFAULT_SETTINGS;
  private bytes = "";
  private readonly listeners = new Set<(settings: InstanceSettings) => void>();

  constructor(paths: DataPaths, locks: KeyedLocks) {
    this.paths = paths;
    this.locks = locks;
  }

  async load(): Promise<InstanceSettings> {
    const raw = await readOrNull(this.paths.settingsFile());
    let parsed: InstanceSettings = DEFAULT_SETTINGS;
    if (raw) {
      try {
        const result = instanceSettingsSchema.safeParse(JSON.parse(raw.toString("utf8")));
        if (result.success) parsed = result.data;
      } catch {
        // an unreadable file keeps the defaults (it is never rewritten silently)
      }
    }
    this.set(parsed, raw?.toString("utf8") ?? "");
    return parsed;
  }

  get(): InstanceSettings {
    return this.current;
  }

  get revision(): string {
    return createHash("sha256").update(this.bytes).digest("hex");
  }

  onChange(listener: (settings: InstanceSettings) => void): void {
    this.listeners.add(listener);
  }

  private set(settings: InstanceSettings, bytes: string): void {
    this.current = settings;
    this.bytes = bytes;
    for (const l of this.listeners) l(settings);
  }

  async update(change: (current: InstanceSettings) => InstanceSettings): Promise<InstanceSettings> {
    return this.locks.run(LOCK, async () => {
      const next = instanceSettingsSchema.parse(change(structuredClone(this.current)));
      const text = `${JSON.stringify(next, null, 2)}\n`;
      await ensureDir(this.paths.systemDir());
      await atomicWrite(this.paths.settingsFile(), text);
      this.set(next, text);
      return next;
    });
  }

  forModel(providerId: string, modelId: string): ModelSettings | undefined {
    return this.current.models.find((m) => m.providerId === providerId && m.modelId === modelId);
  }

  isHidden(providerId: string, modelId: string): boolean {
    return this.forModel(providerId, modelId)?.hidden === true;
  }
}

export interface ExpandedPrompt {
  /** Stable system instructions (no time of day), or null. */
  system: string | null;
  /** Volatile values for the context block before the newest user message. */
  context: string | null;
}

/**
 * Expands the server-owned variables once (contracts §4 item 3). Stable values
 * go into the system instructions; `{{time}}` never does: it becomes a short
 * context block before the newest user message, so the prompt prefix stays
 * stable between turns. Values are inserted in a single pass and are never
 * re-scanned, so nothing recurses.
 */
export function expandSystemPrompt(
  template: string | null,
  values: { username: string; now: Date; timeZone: string },
): ExpandedPrompt {
  if (template === null || template.trim() === "") return { system: null, context: null };
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: values.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(values.now);
  const seen = { time: false };
  const system = template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, name: string) => {
      switch (name.toLowerCase()) {
        case "username":
          return values.username;
        case "date":
          return date;
        case "timezone":
          return values.timeZone;
        case "time":
          seen.time = true;
          return "the time given in the context";
        default:
          return "";
      }
    })
    .trim();
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: values.timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(values.now);
  return {
    system: system === "" ? null : system,
    context: seen.time ? `Current time: ${time} (${values.timeZone})` : null,
  };
}

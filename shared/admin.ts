import { z } from "zod";

/** Admin API DTOs (Phase 10). Secrets never appear in any response (INV-25). */

export const adminUserDtoSchema = z.strictObject({
  id: z.uuid(),
  username: z.string(),
  role: z.enum(["user", "admin"]),
  status: z.enum(["active", "disabled"]),
  createdAt: z.string(),
  conversationCount: z.number().int().nonnegative(),
});
export type AdminUserDto = z.infer<typeof adminUserDtoSchema>;

const capabilities = z.strictObject({
  inputModalities: z
    .array(z.enum(["text", "image", "audio"]))
    .min(1)
    .max(3),
  reasoning: z.boolean(),
  tools: z.boolean(),
});

export const adminProviderDtoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: z.literal("openai-compatible"),
  baseUrl: z.string(),
  hasApiKey: z.boolean(),
  timeoutMs: z.number().int().nullable(),
  maxActiveGenerations: z.number().int().nullable(),
  contextTokens: z.number().int().nullable(),
  samplingExtensions: z.boolean(),
  capabilities,
  status: z.enum(["enabled", "invalid"]),
  problem: z.string().nullable(),
});
export type AdminProviderDto = z.infer<typeof adminProviderDtoSchema>;

export const modelRefSchema = z.strictObject({
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(200),
});

export const adminModelSettingsSchema = z.strictObject({
  providerId: z.string(),
  modelId: z.string(),
  hidden: z.boolean().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().int().optional(),
  minP: z.number().optional(),
  repeatPenalty: z.number().optional(),
  systemPrompt: z.string().optional(),
  timeContext: z.boolean().optional(),
});
export type AdminModelSettings = z.infer<typeof adminModelSettingsSchema>;

export const adminSettingsDtoSchema = z.strictObject({
  registrationMode: z.enum(["open", "closed"]),
  /** Where the effective mode comes from: a saved setting or the environment. */
  registrationModeSource: z.enum(["settings", "environment"]),
  defaultModel: modelRefSchema.nullable(),
  timezone: z.string(),
  generation: z.strictObject({
    maxActivePerUser: z.number().int().nullable(),
    maxOutputTokens: z.number().int().nullable(),
  }),
  /** Attachment limits: saved overrides (null: the environment default applies) and the defaults. */
  attachments: z.strictObject({
    maxFileBytes: z.number().int().nullable(),
    maxPerMessage: z.number().int().nullable(),
    quotaBytes: z.number().int().nullable(),
    textInlineBytes: z.number().int().nullable(),
  }),
  attachmentDefaults: z.strictObject({
    maxFileBytes: z.number().int(),
    maxPerMessage: z.number().int(),
    quotaBytes: z.number().int(),
    textInlineBytes: z.number().int(),
  }),
  /** settings.json could not be read: defaults are in effect. */
  problem: z.string().nullable(),
});
export type AdminSettingsDto = z.infer<typeof adminSettingsDtoSchema>;

export const auditEntrySchema = z.strictObject({
  time: z.string(),
  actor: z.strictObject({ id: z.string(), username: z.string() }),
  action: z.string(),
  target: z.strictObject({
    type: z.enum(["user", "provider", "model", "settings", "maintenance"]),
    id: z.string().optional(),
    label: z.string().optional(),
  }),
  outcome: z.enum(["success", "failure"]),
  code: z.string().optional(),
  fields: z.array(z.string()).optional(),
});
export type AuditEntryDto = z.infer<typeof auditEntrySchema>;

/**
 * Logs (Settings → Logs): what happened on this server, for administrators.
 * Sign-ins, provider problems, admin changes, failed replies and problem
 * reports. Entries carry identifiers and short messages, never passwords,
 * keys or message content (a problem report's text is the user's own words,
 * shown to administrators by design).
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_SOURCES = [
  "auth",
  "providers",
  "admin",
  "generations",
  "reports",
  "system",
] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export const LOG_RETENTION_DAYS = [7, 30, 90, 365] as const;

export const logEntrySchema = z.strictObject({
  id: z.string(),
  time: z.string(),
  level: z.enum(LOG_LEVELS),
  source: z.enum(LOG_SOURCES),
  message: z.string(),
  user: z.strictObject({ id: z.string(), username: z.string() }).nullable(),
  requestId: z.string().nullable(),
  details: z.string().nullable(),
});
export type LogEntryDto = z.infer<typeof logEntrySchema>;

export const logSettingsSchema = z.strictObject({
  level: z.enum(LOG_LEVELS),
  retentionDays: z.union(LOG_RETENTION_DAYS.map((d) => z.literal(d))),
});
export type LogSettingsDto = z.infer<typeof logSettingsSchema>;

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

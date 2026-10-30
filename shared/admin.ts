import { z } from "zod";

/** Admin DTOs (Phase 10). Browser code imports only the types. */
export const adminUserSchema = z.strictObject({
  id: z.uuid(),
  username: z.string(),
  role: z.enum(["user", "admin"]),
  status: z.enum(["active", "disabled", "closing"]),
  createdAt: z.string(),
  conversationCount: z.number().int().nonnegative(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

const capabilities = z.strictObject({
  inputModalities: z.array(z.enum(["text", "image", "audio"])),
  reasoning: z.boolean(),
  tools: z.boolean(),
});

export const adminProviderSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: z.literal("openai-compatible"),
  baseUrl: z.string(),
  /** Secrets are write-only (INV-25). */
  hasApiKey: z.boolean(),
  timeoutMs: z.number().nullable(),
  maxActiveGenerations: z.number().nullable(),
  capabilities,
  contextTokens: z.number().nullable(),
});
export type AdminProvider = z.infer<typeof adminProviderSchema>;

export const adminSamplingSchema = z.strictObject({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  minP: z.number().optional(),
  repeatPenalty: z.number().optional(),
});

export const adminModelSchema = z.strictObject({
  providerId: z.string(),
  providerName: z.string(),
  modelId: z.string(),
  status: z.string(),
  settings: z.strictObject({
    providerId: z.string(),
    modelId: z.string(),
    hidden: z.boolean(),
    sampling: adminSamplingSchema,
    systemPrompt: z.string().nullable(),
  }),
});
export type AdminModel = z.infer<typeof adminModelSchema>;

export const adminSettingsSchema = z.strictObject({
  version: z.literal(1),
  registrationMode: z.enum(["open", "closed"]).nullable(),
  defaultModel: z.strictObject({ providerId: z.string(), modelId: z.string() }).nullable(),
  notice: z.string().nullable(),
  maxOutputTokens: z.number().nullable(),
  timeZone: z.string(),
});
export type AdminSettings = z.infer<typeof adminSettingsSchema>;

export const auditEntrySchema = z.strictObject({
  at: z.string(),
  actor: z.strictObject({ id: z.string(), username: z.string() }),
  action: z.string(),
  target: z.strictObject({ type: z.string(), id: z.string().nullable() }),
  outcome: z.enum(["ok", "error"]),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type AuditEntryDto = z.infer<typeof auditEntrySchema>;

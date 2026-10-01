import { z } from "zod";
import {
  adminModelSettingsSchema,
  adminProviderDtoSchema,
  adminSettingsDtoSchema,
  adminUserDtoSchema,
  auditEntrySchema,
  modelRefSchema,
} from "@shared/admin";
import { ErrorCode } from "@shared/errors";
import { providerModelsDtoSchema } from "@shared/generations";
import { canonicalUuid } from "@shared/ids";
import type { AuditEntry } from "../admin/audit.ts";
import { providerCreateSchema, providerUpdateSchema } from "../admin/providers.ts";
import {
  ATTACHMENT_SETTING_KEYS,
  EXTENDED_SAMPLING,
  modelSettingsSchema,
  type AttachmentSettingKey,
} from "../admin/settings.ts";
import { AppError } from "../errors.ts";
import { defineRoute, userOf, type RouteContext } from "../registry.ts";

/**
 * Admin API (Phase 10). Every route uses the registry's `admin` policy
 * (401 signed out, 403 for non-admins, resolved from the fresh user record,
 * INV-24). Every mutation is audited with field names only, never values.
 */

const idParams = z.strictObject({ id: canonicalUuid });
const providerParams = z.strictObject({ id: z.string().min(1).max(64) });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };
const password = z.string().min(1).max(1024);

async function audited<T>(
  ctx: RouteContext,
  action: string,
  target: AuditEntry["target"],
  fields: string[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const actor = userOf(ctx);
  const record = (outcome: "success" | "failure", code?: string) =>
    ctx.services.admin.audit.record({
      actor: { id: actor.userId, username: actor.username },
      action,
      target,
      outcome,
      ...(code ? { code } : {}),
      ...(fields && fields.length > 0 ? { fields } : {}),
    });
  try {
    const result = await fn();
    await record("success");
    return result;
  } catch (error) {
    await record("failure", error instanceof AppError ? error.code : ErrorCode.INTERNAL).catch(
      () => undefined,
    );
    throw error;
  }
}

const fieldsOf = (body: object) => Object.keys(body).sort();

// ---- users ---------------------------------------------------------------

export const adminListUsersRoute = defineRoute({
  method: "get",
  path: "/api/admin/users",
  auth: "admin",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: z.strictObject({ users: z.array(adminUserDtoSchema) }),
  handler: async (_input, ctx) => ({ users: await ctx.services.admin.accounts.list() }),
  fixture: {},
});

export const adminGetUserRoute = defineRoute({
  method: "get",
  path: "/api/admin/users/:id",
  auth: "admin",
  csrf: "none",
  request: { params: idParams },
  response: adminUserDtoSchema,
  handler: ({ params }, ctx) => ctx.services.admin.accounts.get(params.id),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const adminCreateUserRoute = defineRoute({
  method: "post",
  path: "/api/admin/users",
  auth: "admin",
  csrf: "token",
  status: 201,
  request: {
    body: z.strictObject({
      username: z.string().min(1).max(64),
      password,
      role: z.enum(["user", "admin"]),
    }),
  },
  response: adminUserDtoSchema,
  handler: ({ body }, ctx) =>
    audited(ctx, "user.create", { type: "user", label: body.username }, ["role"], () =>
      ctx.services.admin.accounts.create(body),
    ),
  fixture: { body: { username: "x", password: "short", role: "user" }, expectStatus: 400 },
});

export const adminUpdateUserRoute = defineRoute({
  method: "patch",
  path: "/api/admin/users/:id",
  auth: "admin",
  csrf: "token",
  request: {
    params: idParams,
    body: z
      .strictObject({
        role: z.enum(["user", "admin"]).optional(),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .refine((b) => b.role !== undefined || b.status !== undefined, "Nothing to change"),
  },
  response: adminUserDtoSchema,
  handler: ({ params, body }, ctx) =>
    audited(ctx, "user.update", { type: "user", id: params.id }, fieldsOf(body), () =>
      ctx.services.admin.accounts.change(params.id, body),
    ),
  fixture: { params: unknownId, body: { status: "disabled" }, expectStatus: 404 },
});

export const adminSetPasswordRoute = defineRoute({
  method: "post",
  path: "/api/admin/users/:id/password",
  auth: "admin",
  csrf: "token",
  request: { params: idParams, body: z.strictObject({ password }) },
  response: adminUserDtoSchema,
  handler: ({ params, body }, ctx) =>
    audited(ctx, "user.password", { type: "user", id: params.id }, ["password"], () =>
      ctx.services.admin.accounts.setPassword(params.id, body.password),
    ),
  fixture: { params: unknownId, body: { password: "a long enough password" }, expectStatus: 404 },
});

export const adminDeleteUserRoute = defineRoute({
  method: "delete",
  path: "/api/admin/users/:id",
  auth: "admin",
  csrf: "token",
  request: { params: idParams, body: z.strictObject({ confirmUsername: z.string().max(64) }) },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: ({ params, body }, ctx) =>
    audited(ctx, "user.delete", { type: "user", id: params.id }, undefined, async () => {
      await ctx.services.admin.accounts.delete(params.id, body.confirmUsername);
      return { deleted: true as const };
    }),
  fixture: { params: unknownId, body: { confirmUsername: "nobody" }, expectStatus: 404 },
});

// ---- providers -------------------------------------------------------------

export const adminListProvidersRoute = defineRoute({
  method: "get",
  path: "/api/admin/providers",
  auth: "admin",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: z.strictObject({ providers: z.array(adminProviderDtoSchema) }),
  handler: async (_input, ctx) => ({ providers: await ctx.services.admin.providers.list() }),
  fixture: {},
});

export const adminCreateProviderRoute = defineRoute({
  method: "post",
  path: "/api/admin/providers",
  auth: "admin",
  csrf: "token",
  status: 201,
  request: { body: providerCreateSchema },
  response: adminProviderDtoSchema,
  handler: ({ body }, ctx) =>
    audited(ctx, "provider.create", { type: "provider", id: body.id }, fieldsOf(body), () =>
      ctx.services.admin.providers.create(body),
    ),
  fixture: {
    body: {
      id: "fixture",
      name: "Fixture",
      baseUrl: "http://169.254.169.254/",
      capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
    },
    expectStatus: 400,
  },
});

export const adminUpdateProviderRoute = defineRoute({
  method: "patch",
  path: "/api/admin/providers/:id",
  auth: "admin",
  csrf: "token",
  request: { params: providerParams, body: providerUpdateSchema },
  response: adminProviderDtoSchema,
  handler: ({ params, body }, ctx) =>
    audited(ctx, "provider.update", { type: "provider", id: params.id }, fieldsOf(body), () =>
      ctx.services.admin.providers.update(params.id, body),
    ),
  fixture: { params: { id: "no-such-provider" }, body: { name: "x" }, expectStatus: 404 },
});

export const adminDeleteProviderRoute = defineRoute({
  method: "delete",
  path: "/api/admin/providers/:id",
  auth: "admin",
  csrf: "token",
  request: { params: providerParams },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: ({ params }, ctx) =>
    audited(ctx, "provider.delete", { type: "provider", id: params.id }, undefined, async () => {
      await ctx.services.admin.providers.remove(params.id);
      return { deleted: true as const };
    }),
  fixture: { params: { id: "no-such-provider" }, expectStatus: 404 },
});

export const adminTestProviderRoute = defineRoute({
  method: "post",
  path: "/api/admin/providers/:id/test",
  auth: "admin",
  csrf: "token",
  request: { params: providerParams },
  response: z.strictObject({
    ok: z.boolean(),
    models: z.number().int(),
    problem: z.string().nullable(),
  }),
  handler: ({ params }, ctx) =>
    audited(ctx, "provider.test", { type: "provider", id: params.id }, undefined, () =>
      ctx.services.admin.providers.test(params.id),
    ),
  fixture: { params: { id: "no-such-provider" }, expectStatus: 404 },
});

// ---- models and settings ---------------------------------------------------

export const adminListModelsRoute = defineRoute({
  method: "get",
  path: "/api/admin/models",
  auth: "admin",
  csrf: "none",
  request: { query: z.strictObject({ refresh: z.enum(["1"]).optional() }) },
  response: z.strictObject({
    providers: z.array(providerModelsDtoSchema),
    settings: z.array(adminModelSettingsSchema),
  }),
  handler: async ({ query }, ctx) => ({
    providers: await ctx.services.models.listModels({ fresh: query.refresh === "1" }),
    settings: ctx.services.admin.settings.get().models,
  }),
  fixture: {},
});

/** Nullable fields: `null` removes the override. */
const modelSettingsInput = z.strictObject({
  providerId: modelRefSchema.shape.providerId,
  modelId: modelRefSchema.shape.modelId,
  hidden: z.boolean().nullable().optional(),
  temperature: modelSettingsSchema.shape.temperature.unwrap().nullable().optional(),
  topP: modelSettingsSchema.shape.topP.unwrap().nullable().optional(),
  topK: modelSettingsSchema.shape.topK.unwrap().nullable().optional(),
  minP: modelSettingsSchema.shape.minP.unwrap().nullable().optional(),
  repeatPenalty: modelSettingsSchema.shape.repeatPenalty.unwrap().nullable().optional(),
  systemPrompt: modelSettingsSchema.shape.systemPrompt.unwrap().nullable().optional(),
  timeContext: z.boolean().nullable().optional(),
});

export const adminModelSettingsRoute = defineRoute({
  method: "put",
  path: "/api/admin/model-settings",
  auth: "admin",
  csrf: "token",
  request: { body: modelSettingsInput },
  response: adminModelSettingsSchema,
  handler: ({ body }, ctx) =>
    audited(
      ctx,
      "model.settings",
      { type: "model", id: `${body.providerId}/${body.modelId}` },
      fieldsOf(body).filter((f) => f !== "providerId" && f !== "modelId"),
      async () => {
        const provider = ctx.services.models.entry(body.providerId);
        if (!provider)
          throw new AppError(ErrorCode.PROVIDER_NOT_FOUND, "The provider is not configured");
        if (provider.samplingExtensions === false)
          for (const field of EXTENDED_SAMPLING)
            if (body[field] !== undefined && body[field] !== null)
              throw new AppError(
                ErrorCode.VALIDATION,
                `${field} is not supported by this provider (llama.cpp sampling extensions are off)`,
              );
        const next = await ctx.services.admin.settings.update((current) => {
          const existing = current.models.find(
            (m) => m.providerId === body.providerId && m.modelId === body.modelId,
          ) ?? { providerId: body.providerId, modelId: body.modelId };
          const fields = [
            "hidden",
            "temperature",
            "topP",
            "topK",
            "minP",
            "repeatPenalty",
            "systemPrompt",
            "timeContext",
          ] as const;
          // null (or false for flags) removes an override; undefined keeps it.
          const cleared = new Set<string>(
            fields.filter((f) => body[f] === null || body[f] === false),
          );
          const merged: Record<string, unknown> = Object.fromEntries(
            Object.entries(existing).filter(([key]) => !cleared.has(key)),
          );
          for (const f of fields) {
            const value = body[f];
            if (value !== undefined && value !== null && value !== false) merged[f] = value;
          }
          const others = current.models.filter(
            (m) => !(m.providerId === body.providerId && m.modelId === body.modelId),
          );
          const keep = Object.keys(merged).length > 2;
          return {
            ...current,
            models: keep ? [...others, modelSettingsSchema.parse(merged)] : others,
          };
        });
        return (
          next.models.find(
            (m) => m.providerId === body.providerId && m.modelId === body.modelId,
          ) ?? { providerId: body.providerId, modelId: body.modelId }
        );
      },
    ),
  fixture: { body: { providerId: "no-such-provider", modelId: "m" }, expectStatus: 400 },
});

function settingsDto(ctx: RouteContext) {
  const { settings, auth } = { settings: ctx.services.admin.settings, auth: ctx.services.auth };
  const s = settings.get();
  return {
    registrationMode: auth.registrationConfiguredOpen ? ("open" as const) : ("closed" as const),
    registrationModeSource: s.registrationMode ? ("settings" as const) : ("environment" as const),
    defaultModel: s.defaultModel ?? null,
    timezone: s.timezone ?? "UTC",
    generation: {
      maxActivePerUser: s.generation?.maxActivePerUser ?? null,
      maxOutputTokens: s.generation?.maxOutputTokens ?? null,
    },
    attachments: {
      maxFileBytes: s.attachments?.maxFileBytes ?? null,
      maxPerMessage: s.attachments?.maxPerMessage ?? null,
      quotaBytes: s.attachments?.quotaBytes ?? null,
      textInlineBytes: s.attachments?.textInlineBytes ?? null,
    },
    attachmentDefaults: ctx.services.attachments.defaults(),
    problem: settings.problem,
  };
}

export const adminGetSettingsRoute = defineRoute({
  method: "get",
  path: "/api/admin/settings",
  auth: "admin",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: adminSettingsDtoSchema,
  handler: (_input, ctx) => settingsDto(ctx),
  fixture: {},
});

export const adminUpdateSettingsRoute = defineRoute({
  method: "patch",
  path: "/api/admin/settings",
  auth: "admin",
  csrf: "token",
  request: {
    body: z.strictObject({
      registrationMode: z.enum(["open", "closed"]).optional(),
      defaultModel: modelRefSchema.nullable().optional(),
      timezone: z.string().max(64).optional(),
      generation: z
        .strictObject({
          maxActivePerUser: z.number().int().min(1).max(32).nullable().optional(),
          maxOutputTokens: z.number().int().min(16).max(65_536).nullable().optional(),
        })
        .optional(),
      attachments: z
        .strictObject({
          maxFileBytes: z.number().int().min(1_024).max(1_073_741_824).nullable().optional(),
          maxPerMessage: z.number().int().min(1).max(10).nullable().optional(),
          quotaBytes: z.number().int().min(1_024).max(1_099_511_627_776).nullable().optional(),
          textInlineBytes: z.number().int().min(256).max(10_000_000).nullable().optional(),
        })
        .optional(),
    }),
  },
  response: adminSettingsDtoSchema,
  handler: ({ body }, ctx) =>
    audited(ctx, "settings.update", { type: "settings" }, fieldsOf(body), async () => {
      if (body.defaultModel && !ctx.services.models.entry(body.defaultModel.providerId))
        throw new AppError(ErrorCode.PROVIDER_NOT_FOUND, "The provider is not configured");
      try {
        await ctx.services.admin.settings.update((current) => {
          const next = { ...current };
          if (body.registrationMode) next.registrationMode = body.registrationMode;
          if (body.defaultModel !== undefined) next.defaultModel = body.defaultModel;
          if (body.timezone !== undefined) next.timezone = body.timezone;
          if (body.generation) {
            const change = body.generation;
            const keep = (key: "maxActivePerUser" | "maxOutputTokens") => {
              const value = change[key];
              if (value === null) return undefined;
              return value ?? next.generation?.[key];
            };
            const maxActivePerUser = keep("maxActivePerUser");
            const maxOutputTokens = keep("maxOutputTokens");
            next.generation = {
              ...(maxActivePerUser === undefined ? {} : { maxActivePerUser }),
              ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            };
          }
          if (body.attachments) {
            const change = body.attachments;
            const merged: Partial<Record<AttachmentSettingKey, number>> = {};
            for (const key of ATTACHMENT_SETTING_KEYS) {
              const value = change[key] === undefined ? next.attachments?.[key] : change[key];
              if (value !== null && value !== undefined) merged[key] = value;
            }
            next.attachments = merged;
          }
          return next;
        });
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new AppError(ErrorCode.VALIDATION, error.issues[0]?.message ?? "Invalid settings");
        throw error;
      }
      return settingsDto(ctx);
    }),
  fixture: { body: { timezone: "Not/AZone" }, expectStatus: 400 },
});

// ---- maintenance and audit ---------------------------------------------------

export const adminRebuildIndexRoute = defineRoute({
  method: "post",
  path: "/api/admin/maintenance/rebuild-index",
  auth: "admin",
  csrf: "token",
  request: { body: z.strictObject({ userId: canonicalUuid.optional() }) },
  response: z.strictObject({ conversations: z.number().int().nonnegative() }),
  handler: ({ body }, ctx) =>
    audited(
      ctx,
      "maintenance.rebuild-index",
      { type: "maintenance", ...(body.userId ? { id: body.userId } : {}) },
      undefined,
      async () => ({ conversations: await ctx.services.admin.rebuildIndex(body.userId) }),
    ),
  fixture: { body: {} },
});

export const adminAuditRoute = defineRoute({
  method: "get",
  path: "/api/admin/audit",
  auth: "admin",
  csrf: "none",
  request: {
    query: z.strictObject({ limit: z.coerce.number().int().min(1).max(500).optional() }),
  },
  response: z.strictObject({ entries: z.array(auditEntrySchema) }),
  handler: async ({ query }, ctx) => ({
    entries: await ctx.services.admin.audit.recent(query.limit ?? 100),
  }),
  fixture: {},
});

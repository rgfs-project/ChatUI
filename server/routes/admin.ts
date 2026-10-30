import { z } from "zod";
import {
  adminModelSchema,
  adminProviderSchema,
  adminSettingsSchema,
  adminUserSchema,
  auditEntrySchema,
} from "@shared/admin";
import { canonicalUuid } from "@shared/ids";
import { instanceDtoSchema } from "@shared/instance";
import { providerInputSchema, providerPatchSchema } from "../admin/service.ts";
import { instanceSettingsSchema, modelSettingsSchema } from "../admin/settings.ts";
import { defineRoute, userOf } from "../registry.ts";

/**
 * Admin API (Phase 10). Every route uses `auth: "admin"`: the registry checks
 * the role from the fresh user record before validation (INV-24). Fixtures
 * describe what an admin gets with no other state present.
 */
const idParams = z.strictObject({ id: canonicalUuid });
const providerParams = z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };
const ok = z.strictObject({ ok: z.literal(true) });
const password = z.string().min(1).max(256);

export const adminListUsersRoute = defineRoute({
  method: "get",
  path: "/api/admin/users",
  auth: "admin",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: z.strictObject({ users: z.array(adminUserSchema) }),
  handler: async (_input, ctx) => ({ users: await ctx.services.admin.listUsers(userOf(ctx)) }),
  fixture: {},
});

export const adminCreateUserRoute = defineRoute({
  method: "post",
  path: "/api/admin/users",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: {
    body: z.strictObject({
      username: z.string().trim().min(1).max(64),
      password,
      role: z.enum(["user", "admin"]),
    }),
  },
  response: adminUserSchema,
  status: 201,
  handler: ({ body }, ctx) => ctx.services.admin.createUser(userOf(ctx), body),
  fixture: { body: { username: "x", password: "short", role: "user" }, expectStatus: 400 },
});

export const adminUpdateUserRoute = defineRoute({
  method: "patch",
  path: "/api/admin/users/:id",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: {
    params: idParams,
    body: z
      .strictObject({
        role: z.enum(["user", "admin"]).optional(),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .refine((b) => b.role !== undefined || b.status !== undefined, "nothing to change"),
  },
  response: adminUserSchema,
  handler: ({ params, body }, ctx) => ctx.services.admin.updateUser(userOf(ctx), params.id, body),
  fixture: { params: unknownId, body: { status: "disabled" }, expectStatus: 404 },
});

export const adminSetPasswordRoute = defineRoute({
  method: "post",
  path: "/api/admin/users/:id/password",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: { params: idParams, body: z.strictObject({ password }) },
  response: ok,
  handler: async ({ params, body }, ctx) => {
    await ctx.services.admin.setPassword(userOf(ctx), params.id, body.password);
    return { ok: true as const };
  },
  fixture: { params: unknownId, body: { password: "long enough password" }, expectStatus: 404 },
});

export const adminDeleteUserRoute = defineRoute({
  method: "delete",
  path: "/api/admin/users/:id",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: { params: idParams, body: z.strictObject({ confirmUsername: z.string().max(64) }) },
  response: ok,
  handler: async ({ params, body }, ctx) => {
    await ctx.services.admin.deleteUser(userOf(ctx), params.id, body.confirmUsername);
    return { ok: true as const };
  },
  fixture: { params: unknownId, body: { confirmUsername: "nobody" }, expectStatus: 404 },
});

export const adminListProvidersRoute = defineRoute({
  method: "get",
  path: "/api/admin/providers",
  auth: "admin",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: z.strictObject({ providers: z.array(adminProviderSchema) }),
  handler: async (_input, ctx) => ({
    providers: await ctx.services.admin.listProviders(userOf(ctx)),
  }),
  fixture: {},
});

export const adminCreateProviderRoute = defineRoute({
  method: "post",
  path: "/api/admin/providers",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: { body: providerInputSchema },
  response: adminProviderSchema,
  status: 201,
  handler: ({ body }, ctx) => ctx.services.admin.createProvider(userOf(ctx), body),
  fixture: {
    body: {
      id: "fixture",
      name: "Fixture",
      kind: "openai-compatible",
      baseUrl: "http://169.254.169.254",
      capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
    },
    // Cloud metadata endpoints are always refused (INV-19).
    expectStatus: 400,
  },
});

export const adminUpdateProviderRoute = defineRoute({
  method: "patch",
  path: "/api/admin/providers/:id",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: { params: providerParams, body: providerPatchSchema },
  response: adminProviderSchema,
  handler: ({ params, body }, ctx) =>
    ctx.services.admin.updateProvider(userOf(ctx), params.id, body),
  fixture: { params: { id: "missing" }, body: { name: "x" }, expectStatus: 400 },
});

export const adminDeleteProviderRoute = defineRoute({
  method: "delete",
  path: "/api/admin/providers/:id",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: { params: providerParams },
  response: ok,
  handler: async ({ params }, ctx) => {
    await ctx.services.admin.deleteProvider(userOf(ctx), params.id);
    return { ok: true as const };
  },
  fixture: { params: { id: "missing" }, expectStatus: 400 },
});

export const adminTestProviderRoute = defineRoute({
  method: "post",
  path: "/api/admin/providers/:id/test",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: { params: providerParams },
  response: z.strictObject({ ok: z.boolean(), models: z.number(), message: z.string() }),
  handler: ({ params }, ctx) => ctx.services.admin.testProvider(userOf(ctx), params.id),
  fixture: { params: { id: "missing" }, expectStatus: 400 },
});

export const adminListModelsRoute = defineRoute({
  method: "get",
  path: "/api/admin/models",
  auth: "admin",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: z.strictObject({ models: z.array(adminModelSchema) }),
  handler: async (_input, ctx) => ({ models: await ctx.services.admin.listModels(userOf(ctx)) }),
  fixture: {},
});

export const adminUpdateModelRoute = defineRoute({
  method: "put",
  path: "/api/admin/models",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: { body: modelSettingsSchema },
  response: modelSettingsSchema,
  handler: ({ body }, ctx) => ctx.services.admin.updateModel(userOf(ctx), body),
  fixture: {
    body: {
      providerId: "p",
      modelId: "m",
      hidden: false,
      sampling: { temperature: 9 },
      systemPrompt: null,
    },
    expectStatus: 400,
  },
});

export const adminRefreshModelsRoute = defineRoute({
  method: "post",
  path: "/api/admin/models/refresh",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: {},
  response: z.strictObject({ models: z.number() }),
  handler: async (_input, ctx) => ({ models: await ctx.services.admin.refreshModels(userOf(ctx)) }),
  fixture: {},
});

export const adminGetSettingsRoute = defineRoute({
  method: "get",
  path: "/api/admin/settings",
  auth: "admin",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: adminSettingsSchema,
  handler: (_input, ctx) => ctx.services.admin.settingsFor(userOf(ctx)),
  fixture: {},
});

export const adminUpdateSettingsRoute = defineRoute({
  method: "patch",
  path: "/api/admin/settings",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: {
    body: instanceSettingsSchema.omit({ version: true, models: true }).partial().strict(),
  },
  response: adminSettingsSchema,
  handler: ({ body }, ctx) => ctx.services.admin.updateSettings(userOf(ctx), body),
  fixture: { body: { timeZone: "Not/AZone" }, expectStatus: 400 },
});

export const adminRebuildIndexRoute = defineRoute({
  method: "post",
  path: "/api/admin/maintenance/rebuild-index",
  auth: "admin",
  csrf: "token",
  rateLimit: "admin",
  request: { body: z.strictObject({ accountId: canonicalUuid.optional() }) },
  response: z.strictObject({ accounts: z.number() }),
  handler: async ({ body }, ctx) => ({
    accounts: await ctx.services.admin.rebuildIndex(userOf(ctx), body.accountId),
  }),
  fixture: { body: {} },
});

export const adminAuditRoute = defineRoute({
  method: "get",
  path: "/api/admin/audit",
  auth: "admin",
  csrf: "none",
  request: {
    query: z.strictObject({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    }),
  },
  response: z.strictObject({ entries: z.array(auditEntrySchema) }),
  handler: async ({ query }, ctx) => ({
    entries: await ctx.services.admin.readAudit(
      userOf(ctx),
      query.month ?? new Date().toISOString().slice(0, 7),
    ),
  }),
  fixture: {},
});

/** Public to signed-in users: the notice banner and the instance default model. */
export const instanceRoute = defineRoute({
  method: "get",
  path: "/api/instance",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: instanceDtoSchema,
  handler: (_input, ctx) => ctx.services.bootstrap.instance(),
  fixture: { expectStatus: 401 },
});

import { z } from "zod";
import { preferencesDtoSchema, preferencesPatchSchema } from "@shared/preferences";
import { defineRoute, userOf } from "../registry.ts";
import { preferencesDto } from "../services/bootstrap.ts";

export const getPreferencesRoute = defineRoute({
  method: "get",
  path: "/api/preferences",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: preferencesDtoSchema,
  handler: async (_input, ctx) =>
    preferencesDto(await ctx.services.preferences.get(userOf(ctx).userId)),
  fixture: { expectStatus: 401 },
});

export const updatePreferencesRoute = defineRoute({
  method: "patch",
  path: "/api/preferences",
  auth: "user",
  csrf: "token",
  request: { body: preferencesPatchSchema },
  response: preferencesDtoSchema,
  handler: async ({ body }, ctx) =>
    preferencesDto(await ctx.services.preferences.update(userOf(ctx).userId, body)),
  fixture: { body: {}, expectStatus: 401 },
});

import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import { defineRoute, userOf } from "../registry.ts";

const preferencesSchema = z.strictObject({
  pins: z.array(canonicalUuid).max(500),
  defaultProvider: z.string().max(200).nullable(),
  defaultModel: z.string().max(200).nullable(),
  historyImages: z.enum(["include", "omit"]).nullable(),
  imageMaxEdge: z.number().int().min(0).max(16_384).nullable(),
});

const dto = (p: z.infer<typeof preferencesSchema>) => ({
  pins: p.pins,
  defaultProvider: p.defaultProvider,
  defaultModel: p.defaultModel,
  historyImages: p.historyImages,
  imageMaxEdge: p.imageMaxEdge,
});

export const getPreferencesRoute = defineRoute({
  method: "get",
  path: "/api/preferences",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: preferencesSchema,
  handler: async (_input, ctx) => dto(await ctx.services.preferences.get(userOf(ctx).userId)),
  fixture: { expectStatus: 401 },
});

export const updatePreferencesRoute = defineRoute({
  method: "patch",
  path: "/api/preferences",
  auth: "user",
  csrf: "token",
  request: { body: preferencesSchema.partial() },
  response: preferencesSchema,
  handler: async ({ body }, ctx) =>
    dto(await ctx.services.preferences.update(userOf(ctx).userId, body)),
  fixture: { body: {}, expectStatus: 401 },
});

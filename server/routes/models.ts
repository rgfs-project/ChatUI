import { z } from "zod";
import { modelListDtoSchema, providerListDtoSchema } from "@shared/generations";
import { defineRoute } from "../registry.ts";

/** Non-sensitive provider list: never base URLs or API keys. */
export const listProvidersRoute = defineRoute({
  method: "get",
  path: "/api/providers",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: providerListDtoSchema,
  handler: (_input, ctx) => ({ providers: ctx.services.models.listProviders() }),
  fixture: {},
});

/** Models grouped by provider with stale flags (stale-while-revalidate). */
export const listModelsRoute = defineRoute({
  method: "get",
  path: "/api/models",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({ refresh: z.enum(["1"]).optional() }) },
  response: modelListDtoSchema,
  handler: async ({ query }, ctx) => ({
    providers: await ctx.services.models.listModels({ fresh: query.refresh === "1" }),
  }),
  fixture: {},
});

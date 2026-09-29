import { z } from "zod";
import { modelListDtoSchema } from "@shared/generations";
import { defineRoute } from "../registry.ts";

export const listModelsRoute = defineRoute({
  method: "get",
  path: "/api/models",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({ refresh: z.enum(["1"]).optional() }) },
  response: modelListDtoSchema,
  handler: async ({ query }, { services }) => ({
    models: await services.models.list({ fresh: query.refresh === "1" }),
  }),
  fixture: {},
});

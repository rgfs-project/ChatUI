import { z } from "zod";
import { healthDtoSchema } from "@shared/api";
import { defineRoute } from "../registry.ts";

export const healthRoute = defineRoute({
  method: "get",
  path: "/api/health",
  auth: "public",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: healthDtoSchema,
  handler: (_input, { services }) => services.health(),
  fixture: {},
});

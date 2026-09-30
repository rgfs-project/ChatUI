import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import { createSkillSchema, skillDtoSchema, updateSkillSchema } from "@shared/skills";
import { defineRoute, userOf } from "../registry.ts";

/** Skills (user request, Phase 10): the signed-in user's own, nobody else's. */

const idParams = z.strictObject({ id: canonicalUuid });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

export const listSkillsRoute = defineRoute({
  method: "get",
  path: "/api/skills",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: z.strictObject({ skills: z.array(skillDtoSchema) }),
  handler: async (_input, ctx) => ({
    skills: await ctx.services.skills.list(userOf(ctx).userId),
  }),
  fixture: { expectStatus: 401 },
});

export const createSkillRoute = defineRoute({
  method: "post",
  path: "/api/skills",
  auth: "user",
  csrf: "token",
  request: { body: createSkillSchema },
  response: skillDtoSchema,
  status: 201,
  handler: ({ body }, ctx) => ctx.services.skills.create(userOf(ctx).userId, body),
  fixture: {
    body: { name: "fixture-skill", description: "", instructions: "Be brief." },
    expectStatus: 401,
  },
});

export const updateSkillRoute = defineRoute({
  method: "patch",
  path: "/api/skills/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams, body: updateSkillSchema },
  response: skillDtoSchema,
  handler: ({ params, body }, ctx) =>
    ctx.services.skills.update(userOf(ctx).userId, params.id, body),
  fixture: { params: unknownId, body: { enabled: false }, expectStatus: 404 },
});

export const deleteSkillRoute = defineRoute({
  method: "delete",
  path: "/api/skills/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: async ({ params }, ctx) => {
    await ctx.services.skills.remove(userOf(ctx).userId, params.id);
    return { deleted: true as const };
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

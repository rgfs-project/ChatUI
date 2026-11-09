import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import { moveToProjectSchema, preferencesDtoSchema, projectNameSchema } from "@shared/preferences";
import { defineRoute, userOf } from "../registry.ts";
import { preferencesDto } from "../services/bootstrap.ts";

const unknownId = "00000000-0000-4000-8000-000000000000";
const idParams = z.strictObject({ id: canonicalUuid });

/** Projects (Phase 13g). Each change answers with the updated preferences. */
export const createProjectRoute = defineRoute({
  method: "post",
  path: "/api/projects",
  auth: "user",
  csrf: "token",
  request: { body: projectNameSchema },
  response: preferencesDtoSchema,
  status: 201,
  handler: async ({ body }, ctx) =>
    preferencesDto(await ctx.services.projects.create(userOf(ctx).userId, body.name)),
  fixture: { body: { name: "Fixture project" }, expectStatus: 201 },
});

export const renameProjectRoute = defineRoute({
  method: "patch",
  path: "/api/projects/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams, body: projectNameSchema },
  response: preferencesDtoSchema,
  handler: async ({ params, body }, ctx) =>
    preferencesDto(await ctx.services.projects.rename(userOf(ctx).userId, params.id, body.name)),
  fixture: { params: { id: unknownId }, body: { name: "x" }, expectStatus: 404 },
});

export const deleteProjectRoute = defineRoute({
  method: "delete",
  path: "/api/projects/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: preferencesDtoSchema,
  handler: async ({ params }, ctx) =>
    preferencesDto(await ctx.services.projects.delete(userOf(ctx).userId, params.id)),
  fixture: { params: { id: unknownId }, expectStatus: 404 },
});

export const moveToProjectRoute = defineRoute({
  method: "put",
  path: "/api/conversations/:id/project",
  auth: "user",
  csrf: "token",
  request: { params: idParams, body: moveToProjectSchema },
  response: preferencesDtoSchema,
  handler: async ({ params, body }, ctx) =>
    preferencesDto(await ctx.services.projects.move(userOf(ctx).userId, params.id, body.projectId)),
  fixture: { params: { id: unknownId }, body: { projectId: null }, expectStatus: 404 },
});

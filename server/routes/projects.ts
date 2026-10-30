import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import { ErrorCode } from "@shared/errors";
import {
  feedbackSchema,
  moveToProjectSchema,
  preferencesDtoSchema,
  projectNameSchema,
} from "@shared/preferences";
import { AppError } from "../errors.ts";
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

/** Thumbs up/down on a reply (Phase 14b): kept with the preferences, bounded. */
export const replyFeedbackRoute = defineRoute({
  method: "put",
  path: "/api/conversations/:id/messages/:messageId/feedback",
  auth: "user",
  csrf: "token",
  request: {
    params: z.strictObject({ id: canonicalUuid, messageId: canonicalUuid }),
    body: feedbackSchema,
  },
  response: preferencesDtoSchema,
  handler: async ({ params, body }, ctx) => {
    const { userId } = userOf(ctx);
    const conversation = await ctx.services.conversations.get(userId, params.id).catch(() => null);
    if (
      !conversation?.model.blocks.some((b) => b.type === "assistant" && b.id === params.messageId)
    )
      throw new AppError(ErrorCode.NOT_FOUND, "Reply not found");
    return preferencesDto(
      await ctx.services.preferences.update(userId, {}, (prefs) => {
        const next = Object.fromEntries(
          Object.entries(prefs.feedback).filter(([id]) => id !== params.messageId),
        );
        if (body.value) next[params.messageId] = body.value;
        return { feedback: next };
      }),
    );
  },
  fixture: {
    params: { id: unknownId, messageId: unknownId },
    body: { value: "up" },
    expectStatus: 404,
  },
});

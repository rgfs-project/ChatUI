import { z } from "zod";
import { ErrorCode } from "@shared/errors";
import { canonicalUuid } from "@shared/ids";
import {
  createProjectSchema,
  moveChatSchema,
  projectDtoSchema,
  projectListSchema,
  renameProjectSchema,
  type ProjectDto,
} from "@shared/library";
import { AppError } from "../errors.ts";
import { defineRoute, userOf, type RouteContext } from "../registry.ts";
import type { Library, Project } from "../storage/library.ts";

/**
 * Projects and the archive (the Library page, "Move to project", Archive).
 * Each user's own: ownership is the session's user id (INV-14).
 */

const idParams = z.strictObject({ id: canonicalUuid });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };
const ok = z.strictObject({ ok: z.literal(true) });

/** Chats in each project that still exist in the user's list. */
function toDtos(library: Library, existing: ReadonlySet<string>): ProjectDto[] {
  const counts = new Map<string, number>();
  for (const [chat, project] of Object.entries(library.assignments))
    if (existing.has(chat)) counts.set(project, (counts.get(project) ?? 0) + 1);
  return library.projects
    .map((p: Project) => ({ ...p, chatCount: counts.get(p.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function existingChats(ctx: RouteContext, userId: string): Set<string> {
  return new Set(ctx.services.conversations.list(userId).map((c) => c.id));
}

/** A chat must exist (and be the user's) before it is moved or archived. */
async function requireChat(ctx: RouteContext, userId: string, id: string): Promise<void> {
  if ((await ctx.services.conversations.readUnlocked(userId, id)).kind === "missing")
    throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
}

export const listProjectsRoute = defineRoute({
  method: "get",
  path: "/api/projects",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: projectListSchema,
  handler: async (_input, ctx) => {
    const userId = userOf(ctx).userId;
    const library = await ctx.services.library.get(userId);
    return { projects: toDtos(library, existingChats(ctx, userId)) };
  },
  fixture: {},
});

export const createProjectRoute = defineRoute({
  method: "post",
  path: "/api/projects",
  auth: "user",
  csrf: "token",
  request: { body: createProjectSchema },
  response: projectDtoSchema,
  status: 201,
  handler: async ({ body }, ctx) => ({
    ...(await ctx.services.library.createProject(userOf(ctx).userId, body.name)),
    chatCount: 0,
  }),
  fixture: { body: { name: "Fixture" } },
});

export const renameProjectRoute = defineRoute({
  method: "patch",
  path: "/api/projects/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams, body: renameProjectSchema },
  response: projectDtoSchema,
  handler: async ({ params, body }, ctx) => {
    const userId = userOf(ctx).userId;
    const project = await ctx.services.library.renameProject(userId, params.id, body.name);
    const library = await ctx.services.library.get(userId);
    return (
      toDtos(library, existingChats(ctx, userId)).find((p) => p.id === project.id) ?? {
        ...project,
        chatCount: 0,
      }
    );
  },
  fixture: { params: unknownId, body: { name: "Fixture" }, expectStatus: 404 },
});

export const deleteProjectRoute = defineRoute({
  method: "delete",
  path: "/api/projects/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: ok,
  handler: async ({ params }, ctx) => {
    await ctx.services.library.deleteProject(userOf(ctx).userId, params.id);
    return { ok: true as const };
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

export const moveChatRoute = defineRoute({
  method: "put",
  path: "/api/conversations/:id/project",
  auth: "user",
  csrf: "token",
  request: { params: idParams, body: moveChatSchema },
  response: ok,
  handler: async ({ params, body }, ctx) => {
    const userId = userOf(ctx).userId;
    await requireChat(ctx, userId, params.id);
    await ctx.services.library.assign(userId, params.id, body.projectId);
    return { ok: true as const };
  },
  fixture: { params: unknownId, body: { projectId: null }, expectStatus: 404 },
});

export const archiveChatRoute = defineRoute({
  method: "put",
  path: "/api/conversations/:id/archive",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: ok,
  handler: async ({ params }, ctx) => {
    const userId = userOf(ctx).userId;
    await requireChat(ctx, userId, params.id);
    await ctx.services.library.setArchived(userId, [params.id], true);
    return { ok: true as const };
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

export const unarchiveChatRoute = defineRoute({
  method: "delete",
  path: "/api/conversations/:id/archive",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: ok,
  handler: async ({ params }, ctx) => {
    await ctx.services.library.setArchived(userOf(ctx).userId, [params.id], false);
    return { ok: true as const };
  },
  fixture: { params: unknownId },
});

export const archiveAllRoute = defineRoute({
  method: "post",
  path: "/api/conversations/archive-all",
  auth: "user",
  csrf: "token",
  request: { body: z.strictObject({}) },
  response: z.strictObject({ archived: z.number().int().nonnegative() }),
  handler: async (_input, ctx) => {
    const userId = userOf(ctx).userId;
    const ids = ctx.services.conversations.list(userId).map((c) => c.id);
    return { archived: await ctx.services.library.setArchived(userId, ids, true) };
  },
  fixture: { body: {} },
});

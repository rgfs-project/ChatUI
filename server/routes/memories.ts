import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import {
  createMemorySchema,
  deleteMemorySchema,
  memoryDtoSchema,
  memoryListSchema,
  proposalDtoSchema,
  updateMemorySchema,
} from "@shared/memories";
import { defineRoute, userOf } from "../registry.ts";

const unknownId = "00000000-0000-4000-8000-000000000000";
const fixtureRevision = "0".repeat(64);

/** Approved memories (Phase 13b): only the signed-in user's own notes. */
export const listMemoriesRoute = defineRoute({
  method: "get",
  path: "/api/memories",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: memoryListSchema,
  handler: async (_input, ctx) => ({
    memories: await ctx.services.memory.list(userOf(ctx).userId),
  }),
  fixture: {},
});

export const createMemoryRoute = defineRoute({
  method: "post",
  path: "/api/memories",
  auth: "user",
  csrf: "token",
  request: { body: createMemorySchema },
  response: memoryDtoSchema,
  status: 201,
  handler: ({ body }, ctx) => ctx.services.memory.create(userOf(ctx).userId, body),
  fixture: { body: { name: "Fixture note", body: "Fixture body" }, expectStatus: 201 },
});

export const updateMemoryRoute = defineRoute({
  method: "patch",
  path: "/api/memories/:id",
  auth: "user",
  csrf: "token",
  request: { params: z.strictObject({ id: canonicalUuid }), body: updateMemorySchema },
  response: memoryDtoSchema,
  handler: ({ params, body }, ctx) =>
    ctx.services.memory.update(userOf(ctx).userId, params.id, body),
  fixture: {
    params: { id: unknownId },
    body: { body: "x", expectedRevision: fixtureRevision },
    expectStatus: 404,
  },
});

export const deleteMemoryRoute = defineRoute({
  method: "delete",
  path: "/api/memories/:id",
  auth: "user",
  csrf: "token",
  request: { params: z.strictObject({ id: canonicalUuid }), body: deleteMemorySchema },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: async ({ params, body }, ctx) => {
    await ctx.services.memory.delete(userOf(ctx).userId, params.id, body.expectedRevision);
    return { deleted: true as const };
  },
  fixture: {
    params: { id: unknownId },
    body: { expectedRevision: fixtureRevision },
    expectStatus: 404,
  },
});

const proposalParams = z.strictObject({ id: canonicalUuid, proposalId: canonicalUuid });

/** Accept a model's memory suggestion (INV-37: only the user applies it). */
export const acceptProposalRoute = defineRoute({
  method: "post",
  path: "/api/conversations/:id/proposals/:proposalId/accept",
  auth: "user",
  csrf: "token",
  request: { params: proposalParams },
  response: proposalDtoSchema,
  handler: ({ params }, ctx) =>
    ctx.services.memory.accept(userOf(ctx).userId, params.id, params.proposalId),
  fixture: { params: { id: unknownId, proposalId: unknownId }, expectStatus: 404 },
});

export const rejectProposalRoute = defineRoute({
  method: "post",
  path: "/api/conversations/:id/proposals/:proposalId/reject",
  auth: "user",
  csrf: "token",
  request: { params: proposalParams },
  response: proposalDtoSchema,
  handler: ({ params }, ctx) =>
    ctx.services.memory.reject(userOf(ctx).userId, params.id, params.proposalId),
  fixture: { params: { id: unknownId, proposalId: unknownId }, expectStatus: 404 },
});

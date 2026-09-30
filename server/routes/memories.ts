import { z } from "zod";
import {
  MEMORY_LIMITS,
  createMemorySchema,
  deleteMemoryQuerySchema,
  memoryDtoSchema,
  memoryListSchema,
  memoryParamsSchema,
  proposalDtoSchema,
  proposalListSchema,
  proposalParamsSchema,
  updateMemorySchema,
} from "@shared/memories";
import { canonicalUuid } from "@shared/ids";
import { defineRoute, userOf } from "../registry.ts";
import { selectForPrompt, toMemoryDto } from "../storage/memories.ts";

/**
 * Approved memories (Phase 13b, contracts §12) and the user's decisions on
 * memory proposals (§4.3). Every route is the signed-in user's own action
 * (INV-37); store paths are per user, so another account's ids are 404s.
 */

const unknownId = { id: "00000000-0000-4000-8000-000000000000" };
const fixtureRevision = "0".repeat(64);

export const listMemoriesRoute = defineRoute({
  method: "get",
  path: "/api/memories",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: memoryListSchema,
  handler: async (_input, ctx) => {
    const { notes, unreadable } = await ctx.services.memories.list(userOf(ctx).userId);
    const budget = ctx.services.memoryPromptBudgetBytes;
    const { omitted } = selectForPrompt(notes, budget);
    return {
      memories: notes.map(toMemoryDto),
      omittedIds: omitted.map((n) => n.id),
      promptBudgetBytes: budget,
      unreadable,
      limits: { ...MEMORY_LIMITS },
    };
  },
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
  handler: async ({ body }, ctx) =>
    toMemoryDto(await ctx.services.memories.create(userOf(ctx).userId, body)),
  fixture: { body: { name: "Fixture", content: "A note." }, expectStatus: 201 },
});

export const updateMemoryRoute = defineRoute({
  method: "patch",
  path: "/api/memories/:id",
  auth: "user",
  csrf: "token",
  request: { params: memoryParamsSchema, body: updateMemorySchema },
  response: memoryDtoSchema,
  handler: async ({ params, body }, ctx) =>
    toMemoryDto(await ctx.services.memories.update(userOf(ctx).userId, params.id, body)),
  fixture: {
    params: unknownId,
    body: { content: "Changed.", expectedRevision: fixtureRevision },
    expectStatus: 404,
  },
});

export const deleteMemoryRoute = defineRoute({
  method: "delete",
  path: "/api/memories/:id",
  auth: "user",
  csrf: "token",
  request: { params: memoryParamsSchema, query: deleteMemoryQuerySchema },
  response: z.strictObject({ deleted: z.literal(true) }),
  handler: async ({ params, query }, ctx) => {
    await ctx.services.memories.delete(userOf(ctx).userId, params.id, query.expectedRevision);
    return { deleted: true as const };
  },
  fixture: {
    params: unknownId,
    query: { expectedRevision: fixtureRevision },
    expectStatus: 404,
  },
});

export const listProposalsRoute = defineRoute({
  method: "get",
  path: "/api/conversations/:id/proposals",
  auth: "user",
  csrf: "none",
  request: { params: z.strictObject({ id: canonicalUuid }) },
  response: proposalListSchema,
  handler: async ({ params }, ctx) => ({
    proposals: await ctx.services.proposals.list(userOf(ctx).userId, params.id),
  }),
  fixture: { params: unknownId, expectStatus: 404 },
});

const unknownProposal = { ...unknownId, proposalId: "00000000-0000-4000-8000-00000000000b" };

export const acceptProposalRoute = defineRoute({
  method: "post",
  path: "/api/conversations/:id/proposals/:proposalId/accept",
  auth: "user",
  csrf: "token",
  request: { params: proposalParamsSchema, body: z.strictObject({}) },
  response: proposalDtoSchema,
  handler: ({ params }, ctx) =>
    ctx.services.proposals.accept(userOf(ctx).userId, params.id, params.proposalId),
  fixture: { params: unknownProposal, body: {}, expectStatus: 404 },
});

export const rejectProposalRoute = defineRoute({
  method: "post",
  path: "/api/conversations/:id/proposals/:proposalId/reject",
  auth: "user",
  csrf: "token",
  request: { params: proposalParamsSchema, body: z.strictObject({}) },
  response: proposalDtoSchema,
  handler: ({ params }, ctx) =>
    ctx.services.proposals.reject(userOf(ctx).userId, params.id, params.proposalId),
  fixture: { params: unknownProposal, body: {}, expectStatus: 404 },
});

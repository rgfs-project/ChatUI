import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import {
  generationSnapshotSchema,
  startGenerationRequestSchema,
  startGenerationResponseSchema,
} from "@shared/generations";
import { openSse } from "../generations/sse.ts";
import { defineRoute, defineSseRoute, userOf } from "../registry.ts";

const idParams = z.strictObject({ id: canonicalUuid });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

export const startGenerationRoute = defineRoute({
  method: "post",
  path: "/api/generations",
  auth: "user",
  csrf: "token",
  request: { body: startGenerationRequestSchema },
  response: startGenerationResponseSchema,
  status: 202,
  handler: ({ body }, ctx) => ctx.services.send.send(userOf(ctx).userId, body),
  fixture: {
    body: {
      providerId: "local",
      model: "fixture-missing-model",
      content: "hi",
      operationKey: "00000000-0000-4000-8000-00000000f1f1",
      operationIssuedAt: new Date().toISOString(),
    },
    // No provider state exists for the fixture, so model validation must fail
    // before anything starts (MODEL_NOT_FOUND or a normalized provider error).
    expectStatus: 400,
  },
});

export const getGenerationRoute = defineRoute({
  method: "get",
  path: "/api/generations/:id",
  auth: "user",
  csrf: "none",
  request: { params: idParams },
  response: generationSnapshotSchema,
  handler: ({ params }, ctx) => ctx.services.generations.snapshot(params.id, userOf(ctx).userId),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const cancelGenerationRoute = defineRoute({
  method: "post",
  path: "/api/generations/:id/cancel",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: generationSnapshotSchema,
  handler: async ({ params }, ctx) =>
    ctx.services.generations.cancel(params.id, userOf(ctx).userId),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const streamGenerationRoute = defineSseRoute({
  kind: "sse",
  method: "get",
  path: "/api/generations/:id/stream",
  auth: "user",
  csrf: "none",
  request: { params: idParams },
  handler: ({ params }, ctx) => {
    const { req, res, services } = ctx;
    const auth = userOf(ctx);
    // Ownership (404) and connection caps (429) are decided before any stream bytes.
    services.generations.snapshot(params.id, auth.userId);
    services.sseConnections.assertCapacity(auth.userId);
    let unsubscribe: () => void = () => undefined;
    let untrack: () => void = () => undefined;
    const observer = openSse(
      req,
      res,
      services.sse,
      services.logger,
      () => {
        unsubscribe();
        untrack();
      },
      // Bound to the opening session: closed once it is revoked or expires.
      async () => (await services.auth.resolveHash(auth.tokenHash))?.userId === auth.userId,
    );
    untrack = services.sseConnections.add(auth.userId, auth.tokenHash, () => {
      observer.terminate();
    });
    unsubscribe = services.generations.observe(params.id, observer, auth.userId);
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

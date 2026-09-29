import { z } from "zod";
import { canonicalUuid } from "@shared/ids";
import {
  generationSnapshotSchema,
  startGenerationRequestSchema,
  startGenerationResponseSchema,
} from "@shared/generations";
import { openSse } from "../generations/sse.ts";
import { defineRoute, defineSseRoute } from "../registry.ts";

const idParams = z.strictObject({ id: canonicalUuid });
const unknownId = { id: "00000000-0000-4000-8000-000000000000" };

export const startGenerationRoute = defineRoute({
  method: "post",
  path: "/api/generations",
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { body: startGenerationRequestSchema },
  response: startGenerationResponseSchema,
  status: 202,
  handler: ({ body }, { services }) => services.send.send(services.userId, body),
  fixture: {
    body: {
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
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { params: idParams },
  response: generationSnapshotSchema,
  handler: ({ params }, { services }) => services.generations.snapshot(params.id),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const cancelGenerationRoute = defineRoute({
  method: "post",
  path: "/api/generations/:id/cancel",
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { params: idParams },
  response: generationSnapshotSchema,
  handler: async ({ params }, { services }) => services.generations.cancel(params.id),
  fixture: { params: unknownId, expectStatus: 404 },
});

export const streamGenerationRoute = defineSseRoute({
  kind: "sse",
  method: "get",
  path: "/api/generations/:id/stream",
  auth: "public",
  csrf: "none",
  availability: "chat-demo",
  request: { params: idParams },
  handler: ({ params }, { req, res, services }) => {
    // Throws GENERATION_NOT_FOUND (a JSON error) before any stream bytes.
    services.generations.snapshot(params.id);
    let unsubscribe: () => void = () => undefined;
    const observer = openSse(req, res, services.sse, services.logger, () => {
      unsubscribe();
    });
    unsubscribe = services.generations.observe(params.id, observer);
  },
  fixture: { params: unknownId, expectStatus: 404 },
});

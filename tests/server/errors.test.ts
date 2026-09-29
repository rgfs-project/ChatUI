import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../../server/errors.ts";
import { defineRoute, erase } from "../../server/registry.ts";
import { apiRoutes } from "../../server/routes/index.ts";
import { testApp } from "./helpers.ts";

const echoRoute = defineRoute({
  method: "post",
  path: "/api/test/echo",
  auth: "public",
  csrf: "none",
  request: { body: z.strictObject({ text: z.string().max(10_000_000) }) },
  response: z.strictObject({ text: z.string() }),
  handler: ({ body }) => ({ text: body.text }),
  fixture: { body: { text: "hi" } },
});

const failingRoute = defineRoute({
  method: "get",
  path: "/api/test/boom",
  auth: "public",
  csrf: "none",
  request: {},
  response: z.strictObject({}),
  handler: () => {
    throw new Error("secret internal detail at /srv/private/path");
  },
  fixture: {},
});

const contractErrorRoute = defineRoute({
  method: "get",
  path: "/api/test/missing",
  auth: "public",
  csrf: "none",
  request: {},
  response: z.strictObject({}),
  handler: () => {
    throw new AppError(ErrorCode.NOT_FOUND, "Thing not found");
  },
  fixture: {},
});

const leakyRoute = defineRoute({
  method: "get",
  path: "/api/test/leaky",
  auth: "public",
  csrf: "none",
  request: {},
  response: z.strictObject({ id: z.string() }),
  // Returns an internal record with an extra field; the DTO schema must refuse it.
  handler: () => ({ id: "x", passwordHash: "argon2id$..." }) as { id: string },
  fixture: {},
});

const routes = [
  ...apiRoutes,
  erase(echoRoute),
  erase(failingRoute),
  erase(contractErrorRoute),
  erase(leakyRoute),
];

function expectContractError(body: unknown, code: string) {
  expect(body).toMatchObject({ error: { code, message: expect.any(String) as string } });
  const keys = Object.keys((body as { error: object }).error);
  expect(keys.every((key) => ["code", "message", "details"].includes(key))).toBe(true);
}

describe("API error contract", () => {
  it("INV-01: unhandled errors become INTERNAL without exposing internals", async () => {
    const { app, logs } = testApp({ routes });
    const res = await request(app).get("/api/test/boom");
    expect(res.status).toBe(500);
    expectContractError(res.body, "INTERNAL");
    expect(res.text).not.toContain("secret internal detail");
    expect(res.text).not.toContain("/srv/private");
    expect(res.text).not.toMatch(/at \w+ \(/); // no stack frames
    // The detail is logged server-side for operators.
    expect(JSON.stringify(logs.lines())).toContain("secret internal detail");
  });

  it("INV-01: contract errors keep their code, status and safe message", async () => {
    const { app } = testApp({ routes });
    const res = await request(app).get("/api/test/missing");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Thing not found" } });
  });

  it("INV-01: unknown API paths return a JSON NOT_FOUND, never HTML", async () => {
    const { app } = testApp({ routes });
    for (const path of ["/api/unknown", "/api/health/extra", "/api"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers["content-type"], path).toMatch(/^application\/json/);
      expectContractError(res.body, "NOT_FOUND");
    }
  });

  it("INV-01: unsupported methods on API paths return JSON NOT_FOUND", async () => {
    const { app } = testApp({ routes });
    const res = await request(app).delete("/api/health");
    expect(res.status).toBe(404);
    expectContractError(res.body, "NOT_FOUND");
  });

  it("INV-01: oversized JSON bodies return PAYLOAD_TOO_LARGE", async () => {
    const { app } = testApp({ routes });
    const res = await request(app)
      .post("/api/test/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ text: "x".repeat(300 * 1024) }));
    expect(res.status).toBe(413);
    expectContractError(res.body, "PAYLOAD_TOO_LARGE");
  });

  it("INV-01: malformed JSON returns VALIDATION", async () => {
    const { app } = testApp({ routes });
    const res = await request(app)
      .post("/api/test/echo")
      .set("Content-Type", "application/json")
      .send('{"text": ');
    expect(res.status).toBe(400);
    expectContractError(res.body, "VALIDATION");
  });

  it("INV-03: responses that do not match their DTO schema are refused as INTERNAL", async () => {
    const { app } = testApp({ routes });
    const res = await request(app).get("/api/test/leaky");
    expect(res.status).toBe(500);
    expectContractError(res.body, "INTERNAL");
    expect(res.text).not.toContain("argon2id");
  });
});

describe("request validation", () => {
  it("INV-02: unknown body fields are rejected", async () => {
    const { app } = testApp({ routes });
    const res = await request(app).post("/api/test/echo").send({ text: "hi", extra: true });
    expect(res.status).toBe(400);
    expectContractError(res.body, "VALIDATION");
    expect(JSON.stringify(res.body)).toContain("extra");
  });

  it("INV-02: unknown query parameters are rejected", async () => {
    const { app } = testApp({ routes });
    const res = await request(app).get("/api/health?verbose=1");
    expect(res.status).toBe(400);
    expectContractError(res.body, "VALIDATION");
  });

  it("INV-02: a body sent to an endpoint without a body schema is rejected", async () => {
    const { app } = testApp({ routes });
    const res = await request(app).get("/api/test/missing").send({ unexpected: 1 });
    expect(res.status).toBe(400);
    expectContractError(res.body, "VALIDATION");
  });

  it("INV-02: invalid field types are rejected; valid requests pass", async () => {
    const { app } = testApp({ routes });
    const bad = await request(app).post("/api/test/echo").send({ text: 42 });
    expect(bad.status).toBe(400);
    const good = await request(app).post("/api/test/echo").send({ text: "hi" });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ text: "hi" });
  });
});

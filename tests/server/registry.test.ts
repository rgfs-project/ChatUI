import { ESLint } from "eslint";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { routeInventoryRestriction } from "../../eslint.route-inventory.js";
import { buildApiRouter, defineRoute, erase } from "../../server/registry.ts";
import { apiRoutes } from "../../server/routes/index.ts";
import { startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { providerConfig, testApp } from "./helpers.ts";

let llama: MockLlama;

beforeAll(async () => {
  llama = await startMockLlama({ slots: 2 });
});

afterAll(async () => {
  await llama.close();
});

const withProvider = (inContainer = false) =>
  testApp({ config: { inContainer, provider: providerConfig({ baseUrl: llama.url }) } });

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("API route registry", () => {
  it("every registered route is under /api with schemas, a DTO and policies", () => {
    expect(apiRoutes.length).toBeGreaterThan(0);
    for (const route of apiRoutes) {
      expect(route.path.startsWith("/api/")).toBe(true);
      if (route.kind !== "sse") expect(route.response).toBeInstanceOf(z.ZodType);
      for (const schema of Object.values(route.request)) {
        expect(schema).toBeInstanceOf(z.ZodType);
      }
      expect(route.auth).toBe("public");
      expect(route.csrf).toBe("none");
    }
  });

  it("every route answers its fixture request with a DTO or a contract error", async () => {
    const { app } = withProvider();
    for (const route of apiRoutes) {
      const name = `${route.method} ${route.path}`;
      const query = new URLSearchParams(route.fixture.query ?? {}).toString();
      let url: string = route.path;
      for (const [key, value] of Object.entries(route.fixture.params ?? {})) {
        url = url.replace(`:${key}`, value);
      }
      if (query) url = `${url}?${query}`;
      const req = request(app)[route.method](url);
      const res =
        route.fixture.body === undefined ? await req : await req.send(route.fixture.body as object);
      const expected =
        route.fixture.expectStatus ?? (route.kind === "sse" ? 200 : (route.status ?? 200));
      expect(res.status, name).toBe(expected);
      if (expected >= 400) {
        expect(res.headers["content-type"], name).toMatch(/^application\/json/);
        expect(res.body, name).toMatchObject({ error: { code: expect.any(String) as string } });
      } else if (route.kind !== "sse") {
        expect(route.response.safeParse(res.body).success, name).toBe(true);
      }
      expect(res.headers["cache-control"], name).toBe("no-store");
    }
  });

  it("rejects duplicate method/path registrations", () => {
    const route = erase(
      defineRoute({
        method: "get",
        path: "/api/dup",
        auth: "public",
        csrf: "none",
        request: {},
        response: z.strictObject({}),
        handler: () => ({}),
        fixture: {},
      }),
    );
    const { chatui } = testApp();
    expect(() => buildApiRouter([route, route], chatui.services)).toThrow(/Duplicate API route/);
  });

  it("chat-demo routes do not exist in the container (contracts §9.2b)", async () => {
    const { app } = withProvider(true);
    const demo = apiRoutes.filter((route) => route.availability === "chat-demo");
    expect(demo.length).toBeGreaterThanOrEqual(5);
    for (const route of demo) {
      const req = request(app)[route.method](route.path.replace(":id", UNKNOWN_ID));
      const res =
        route.fixture.body === undefined ? await req : await req.send(route.fixture.body as object);
      expect(res.status, route.path).toBe(404);
      expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    expect((await request(app).get("/api/health")).status).toBe(200);
  });

  it("GET /api/health returns exactly the public health DTO (INV-03)", async () => {
    const { app } = testApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({ status: "ok", version: "9.9.9-test" });
  });

  it("lint forbids registering API routes outside the registry", async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        rules: { "no-restricted-syntax": ["error", routeInventoryRestriction] },
      },
    });
    const [bypass] = await eslint.lintText(
      'const app = { get() {}, use() {} };\napp.get("/api/secret", () => {});\n',
    );
    expect(bypass?.messages.map((m) => m.ruleId)).toEqual(["no-restricted-syntax"]);

    const [allowed] = await eslint.lintText(
      'const headers = new Map();\nheaders.get("user-agent");\nconst app = { use() {} };\napp.use("/api", () => {});\n',
    );
    expect(allowed?.messages).toEqual([]);
  });
});

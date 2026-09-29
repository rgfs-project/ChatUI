import { ESLint } from "eslint";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { routeInventoryRestriction } from "../../eslint.route-inventory.js";
import { buildApiRouter, defineRoute, erase } from "../../server/registry.ts";
import { apiRoutes } from "../../server/routes/index.ts";
import { testApp } from "./helpers.ts";

describe("API route registry", () => {
  it("every registered route is under /api with schemas, a DTO and policies", () => {
    expect(apiRoutes.length).toBeGreaterThan(0);
    for (const route of apiRoutes) {
      expect(route.path.startsWith("/api/")).toBe(true);
      expect(route.response).toBeInstanceOf(z.ZodType);
      for (const schema of Object.values(route.request)) {
        expect(schema).toBeInstanceOf(z.ZodType);
      }
      expect(route.auth).toBe("public");
      expect(route.csrf).toBe("none");
    }
  });

  it("every route answers its fixture request with a DTO-conformant response", async () => {
    const { app } = testApp();
    for (const route of apiRoutes) {
      const query = new URLSearchParams(route.fixture.query ?? {}).toString();
      const url = query ? `${route.path}?${query}` : route.path;
      const req = request(app)[route.method](url);
      const res =
        route.fixture.body === undefined ? await req : await req.send(route.fixture.body as object);
      expect(res.status, `${route.method} ${route.path}`).toBe(route.status ?? 200);
      expect(route.response.safeParse(res.body).success).toBe(true);
      expect(res.headers["cache-control"]).toBe("no-store");
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
    expect(() =>
      buildApiRouter([route, route], { health: () => ({ status: "ok", version: "" }) }),
    ).toThrow(/Duplicate API route/);
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

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ESLint } from "eslint";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { routeInventoryRestriction } from "../../eslint.route-inventory.js";
import type { ChatUiApp } from "../../server/create-app.ts";
import { buildApiRouter, defineRoute, erase, type AnyApiRoute } from "../../server/registry.ts";
import { apiRoutes } from "../../server/routes/index.ts";
import { startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { providerConfig, signIn, testApp, type TestSession } from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 2 });
});
afterAll(async () => {
  await llama.close();
});

const servers: { server: Server; chatui: ChatUiApp }[] = [];
afterEach(async () => {
  for (const { server, chatui } of servers.splice(0)) {
    await chatui.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

async function serve(): Promise<{ base: string; chatui: ChatUiApp }> {
  const { chatui } = testApp({ config: { provider: providerConfig({ baseUrl: llama.url }) } });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, chatui };
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const PUBLIC = new Set([
  "GET /api/health",
  "GET /api/auth/session",
  "POST /api/auth/login",
  "POST /api/auth/register",
]);
const key = (route: AnyApiRoute) => `${route.method.toUpperCase()} ${route.path}`;

function urlOf(route: AnyApiRoute): string {
  let url: string = route.path;
  for (const [name, value] of Object.entries(route.fixture.params ?? {}))
    url = url.replace(`:${name}`, value);
  for (const name of url.match(/:[A-Za-z]+/g) ?? []) url = url.replace(name, UNKNOWN_ID);
  const query = new URLSearchParams(route.fixture.query ?? {}).toString();
  return query ? `${url}?${query}` : url;
}

async function call(base: string, route: AnyApiRoute, headers: Record<string, string>) {
  const hasBody = route.fixture.body !== undefined;
  const res = await fetch(`${base}${urlOf(route)}`, {
    method: route.method.toUpperCase(),
    headers: { ...headers, ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    body: hasBody ? JSON.stringify(route.fixture.body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    body: text,
    cache: res.headers.get("cache-control"),
  };
}

describe("API route registry", () => {
  it("every route declares its policies: only the allowlist is public; mutations are CSRF-protected", () => {
    for (const route of apiRoutes) {
      expect(route.path.startsWith("/api/")).toBe(true);
      if (route.kind !== "sse") expect(route.response).toBeInstanceOf(z.ZodType);
      for (const schema of Object.values(route.request)) expect(schema).toBeInstanceOf(z.ZodType);
      expect(route.auth, key(route)).toBe(PUBLIC.has(key(route)) ? "public" : "user");
      if (route.method === "get") expect(route.csrf, key(route)).toBe("none");
      else expect(["token", "origin"], key(route)).toContain(route.csrf);
      if (route.csrf === "origin") expect(route.auth).toBe("public");
    }
  });

  it("INV-15: unauthenticated access to every protected route is a JSON 401", async () => {
    const { base } = await serve();
    const protectedRoutes = apiRoutes.filter((route) => route.auth === "user");
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(14);
    for (const route of protectedRoutes) {
      const res = await call(base, route, {});
      expect(res.status, key(route)).toBe(401);
      expect(res.body, key(route)).toContain('"UNAUTHENTICATED"');
    }
  });

  it("INV-16: every state-changing route rejects a missing or wrong CSRF token and a stale expected user", async () => {
    const { base, chatui } = await serve();
    const session = await signIn(base, chatui);
    const mutations = apiRoutes.filter((route) => route.csrf === "token");
    expect(mutations.length).toBeGreaterThanOrEqual(7);
    for (const route of mutations) {
      const none = await call(base, route, {
        Cookie: session.cookie,
        "X-Expected-User": session.userId,
      });
      expect(none.status, `${key(route)} missing`).toBe(403);
      expect(none.body).toContain('"CSRF_INVALID"');
      const wrong = await call(base, route, {
        Cookie: session.cookie,
        "X-CSRF-Token": "x".repeat(43),
        "X-Expected-User": session.userId,
      });
      expect(wrong.status, `${key(route)} wrong`).toBe(403);
      const stale = await call(base, route, {
        Cookie: session.cookie,
        "X-CSRF-Token": session.csrfToken,
        "X-Expected-User": UNKNOWN_ID,
      });
      expect(stale.status, `${key(route)} expected user`).toBe(409);
      expect(stale.body).toContain('"SESSION_CHANGED"');
    }
  });

  it("INV-16: login and registration require a same-origin request", async () => {
    const { base } = await serve();
    for (const route of apiRoutes.filter((r) => r.csrf === "origin")) {
      const cross = await call(base, route, { Origin: "https://evil.example" });
      expect(cross.status, key(route)).toBe(403);
      expect(cross.body).toContain('"CSRF_INVALID"');
      const noOrigin = await call(base, route, {});
      expect(noOrigin.status, key(route)).toBe(403);
    }
  });

  it("every route answers its fixture with a DTO or a contract error (signed in where required)", async () => {
    const { base, chatui } = await serve();
    const session: TestSession = await signIn(base, chatui);
    for (const route of apiRoutes) {
      // Covered by the auth tests; calling them here would end this session.
      if (key(route) === "POST /api/auth/logout" || key(route) === "POST /api/auth/password")
        continue;
      const headers = route.auth === "user" ? session.headers(route.csrf === "token") : {};
      const res = await call(base, route, headers);
      const expected =
        route.auth === "user" && route.fixture.expectStatus === 401
          ? route.kind === "sse"
            ? 200
            : (route.status ?? 200)
          : (route.fixture.expectStatus ?? (route.kind === "sse" ? 200 : (route.status ?? 200)));
      if (key(route) === "POST /api/auth/logout" || key(route) === "POST /api/auth/password")
        continue;
      expect(res.status, key(route)).toBe(expected);
      if (expected >= 400) expect(res.type, key(route)).toMatch(/^application\/json/);
      else if (route.kind !== "sse")
        expect(route.response.safeParse(JSON.parse(res.body)).success, key(route)).toBe(true);
      expect(res.cache, key(route)).toBe("no-store");
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

  it("INV-14: no route takes identity from the request", () => {
    const identityKeys = /^(userId|ownerId|user|owner|role)$/;
    for (const route of apiRoutes) {
      for (const schema of Object.values(route.request)) {
        const shape = (schema as { shape?: Record<string, unknown> }).shape ?? {};
        for (const name of Object.keys(shape))
          expect(identityKeys.test(name), `${key(route)} ${name}`).toBe(false);
      }
    }
    const dir = path.resolve(import.meta.dirname, "../../server/routes");
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(/req\.(headers|query|body|params|cookies)/);
      expect(source, file).not.toMatch(/params\.userId|body\.userId|query\.userId/);
    }
  });

  it("GET /api/health returns exactly the public health DTO (INV-03)", async () => {
    const { app } = testApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: "9.9.9-test" });
  });

  it("lint forbids registering API routes outside the registry", async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: { rules: { "no-restricted-syntax": ["error", routeInventoryRestriction] } },
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

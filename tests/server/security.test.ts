import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import { PERMISSIONS_POLICY } from "../../server/csp.ts";
import { HTTP_SERVER_LIMITS } from "../../server/http-limits.ts";
import { rateBucketOf, type AnyApiRoute } from "../../server/registry.ts";
import { apiRoutes } from "../../server/routes/index.ts";
import { startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  localProvider,
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  writeProviders,
  type TestAppOptions,
  type TestSession,
} from "./helpers.ts";

/**
 * Phase 16 hardening: request budgets, headers and connection limits,
 * ownership at the service boundary, error and log leakage with sentinels,
 * and upload polyglots. (Session, CSRF, validation, SSRF, traversal and CSP
 * enumerations live in the auth, registry, errors, providers, attachments and
 * csp test files; SECURITY.md maps each requirement to its tests.)
 */

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4 });
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

const SECRET_KEY = "SENTINEL-PROVIDER-KEY-4f1c";

async function serve(options: TestAppOptions = {}) {
  const dataDir = options.config?.dataDir ?? tempDataDir();
  writeProviders(dataDir, [localProvider(llama.url, { apiKey: SECRET_KEY })]);
  const { chatui, logs } = testApp({
    ...options,
    config: { provider: providerConfig({ baseUrl: llama.url }), ...options.config, dataDir },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, chatui, logs, dataDir };
}

async function post(base: string, session: TestSession, url: string, body: unknown) {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { ...session.headers(true), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function upload(
  base: string,
  session: TestSession,
  name: string,
  bytes: Buffer,
  type: string,
) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
  const res = await fetch(`${base}/api/attachments`, {
    method: "POST",
    headers: session.headers(true),
    body: form,
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const key = (route: AnyApiRoute) => `${route.method.toUpperCase()} ${route.path}`;

describe("request budgets (RATE_LIMITED + Retry-After)", () => {
  it("every route that starts a generation or takes an upload draws from a budget; admin mutations too", () => {
    const expected: Record<string, string> = {
      "POST /api/generations": "generation",
      "POST /api/conversations/:id/regenerate": "generation",
      "POST /api/attachments": "upload",
      "POST /api/imports": "upload",
    };
    for (const route of apiRoutes) {
      const bucket = rateBucketOf(route);
      if (expected[key(route)]) expect(bucket, key(route)).toBe(expected[key(route)]);
      else if (route.auth === "admin" && route.method !== "get")
        expect(bucket, key(route)).toBe("admin");
      else expect(bucket, key(route)).toBeUndefined();
    }
  });

  it("over budget is 429 RATE_LIMITED with Retry-After, before validation, per user", async () => {
    const { base, chatui } = await serve({
      config: { rateLimits: { generationsPerMinute: 2, uploadsPerMinute: 1, adminPerMinute: 1 } },
    });
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    // Invalid bodies still spend budget: the limit protects the validator too.
    for (let i = 0; i < 2; i++)
      expect((await post(base, alice, "/api/generations", {})).status).toBe(400);
    const limited = await post(base, alice, "/api/generations", {});
    expect(limited.status).toBe(429);
    expect((limited.body.error as { code: string }).code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another user has their own budget.
    expect((await post(base, bob, "/api/generations", {})).status).toBe(400);

    const text = Buffer.from("hello");
    expect((await upload(base, alice, "a.txt", text, "text/plain")).status).toBe(201);
    expect((await upload(base, alice, "b.txt", text, "text/plain")).status).toBe(429);

    const admin = await signIn(base, chatui, "root", "admin");
    const first = await fetch(`${base}/api/admin/maintenance/rebuild-index`, {
      method: "POST",
      headers: admin.headers(true),
    });
    expect(first.status).not.toBe(429);
    const second = await fetch(`${base}/api/admin/maintenance/rebuild-index`, {
      method: "POST",
      headers: admin.headers(true),
    });
    expect(second.status).toBe(429);
  });
});

describe("headers and connection limits", () => {
  it("HTML, API and attachment responses carry Permissions-Policy and the hardening headers", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const uploaded = await upload(base, alice, "note.txt", Buffer.from("hi"), "text/plain");
    const id = (uploaded.body as { id: string }).id;
    const responses = [
      await fetch(`${base}/`),
      await fetch(`${base}/api/health`),
      await fetch(`${base}/api/attachments/${id}/content`, { headers: alice.headers(false) }),
    ];
    for (const res of responses) {
      expect(res.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
      expect(res.headers.get("x-powered-by")).toBeNull();
    }
    expect(PERMISSIONS_POLICY).toMatch(/camera=\(\)/);
    expect(PERMISSIONS_POLICY).toMatch(/microphone=\(\)/);
  });

  it("the HTTP server caps header size and slow requests", () => {
    expect(HTTP_SERVER_LIMITS.maxHeaderSize).toBeLessThanOrEqual(16 * 1024);
    expect(HTTP_SERVER_LIMITS.headersTimeout).toBeLessThanOrEqual(60_000);
    expect(HTTP_SERVER_LIMITS.requestTimeout).toBeGreaterThan(0);
    expect(HTTP_SERVER_LIMITS.keepAliveTimeout).toBeLessThan(HTTP_SERVER_LIMITS.headersTimeout);
  });
});

describe("ownership at the service boundary (INV-15)", () => {
  it("service functions called directly with another user's id find nothing", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const s = chatui.services;

    const memory = await post(base, alice, "/api/memories", { name: "Mine", content: "private" });
    const skill = await post(base, alice, "/api/skills", {
      name: "mine",
      description: "",
      instructions: "private",
    });
    const attachment = await upload(base, alice, "a.txt", Buffer.from("private"), "text/plain");
    const sent = await post(base, alice, "/api/generations", {
      providerId: "local",
      model: "mock-chat",
      content: "private question",
      operationKey: crypto.randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    expect(sent.status).toBe(202);
    const { conversationId, generationId } = sent.body as {
      conversationId: string;
      generationId: string;
    };

    await expect(s.conversations.get(bob.userId, conversationId)).rejects.toThrow();
    expect(s.conversations.list(bob.userId)).toEqual([]);
    expect(() => s.generations.snapshot(generationId, bob.userId)).toThrow();
    await expect(s.generations.cancel(generationId, bob.userId)).rejects.toThrow();
    const attachmentId = (attachment.body as { id: string }).id;
    expect(await s.attachments.readMeta(bob.userId, attachmentId)).toBeNull();
    expect(await s.attachments.readBlob(bob.userId, attachmentId)).toBeNull();
    await expect(s.attachments.get(bob.userId, attachmentId)).rejects.toThrow();
    expect(await s.memories.read(bob.userId, (memory.body as { id: string }).id)).toBeNull();
    expect((await s.memories.list(bob.userId)).notes).toEqual([]);
    await expect(
      s.skills.update(bob.userId, (skill.body as { id: string }).id, {
        name: "stolen",
        description: "",
        instructions: "x",
        enabled: true,
      }),
    ).rejects.toThrow();
    expect(await s.skills.list(bob.userId)).toEqual([]);
    expect(await s.artifacts.list(bob.userId)).toEqual([]);
    // Alice still has everything.
    expect((await s.conversations.get(alice.userId, conversationId)).id).toBe(conversationId);
  });
});

const LEAK = /\bat \S+ \(|\.ts:\d+|node_modules|\/home\/|\/tmp\/|ENOENT|EACCES|stack|SENTINEL/i;

describe("no internals in errors (fuzzed)", () => {
  it("malformed input on every route is a JSON 4xx without stack, path or secret", async () => {
    const { base, chatui, dataDir } = await serve();
    const user = await signIn(base, chatui);
    const admin = await signIn(base, chatui, "root", "admin");
    const variants = [
      { name: "wrong type", body: "[]" },
      { name: "invalid JSON", body: "{" },
      { name: "prototype keys", body: '{"__proto__":{"admin":true},"constructor":{"x":1}}' },
      { name: "deep", body: `${"[".repeat(5_000)}${"]".repeat(5_000)}` },
      { name: "huge", body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }) },
    ];
    for (const route of apiRoutes) {
      if (route.path === "/api/auth/logout" || route.path === "/api/auth/password") continue;
      const session = route.auth === "admin" ? admin : user;
      let url: string = route.path;
      for (const name of url.match(/:[A-Za-z]+/g) ?? [])
        url = url.replace(name, name === ":id" ? "..%2F..%2Fetc%2Fpasswd" : "x".repeat(300));
      const requests: { label: string; init: RequestInit; url: string }[] =
        route.method === "get" || route.method === "delete"
          ? [
              {
                label: "traversal params + unknown query",
                url: `${url}?__proto__=1&unknown=%00`,
                init: {
                  method: route.method.toUpperCase(),
                  headers: session.headers(route.csrf === "token"),
                },
              },
            ]
          : variants.map((v) => ({
              label: v.name,
              url,
              init: {
                method: route.method.toUpperCase(),
                headers: {
                  ...session.headers(route.csrf === "token"),
                  "Content-Type": "application/json",
                  Origin: "http://localhost:3000",
                },
                body: v.body,
              },
            }));
      for (const r of requests) {
        const res = await fetch(`${base}${r.url}`, r.init);
        const text = await res.text();
        const label = `${key(route)} (${r.label})`;
        expect(res.status, label).toBeGreaterThanOrEqual(400);
        expect(res.status, label).toBeLessThan(500);
        expect(res.headers.get("content-type") ?? "", label).toMatch(/^application\/json/);
        expect(text, label).not.toMatch(LEAK);
        expect(text, label).not.toContain(dataDir);
      }
    }
  });
});

describe("no secrets or content in logs (sentinels)", () => {
  it("default-level logs contain no passwords, tokens, cookies, keys, messages or file contents", async () => {
    const { base, chatui, logs } = await serve();
    const alice = await signIn(base, chatui);
    const MESSAGE = "SENTINEL-MESSAGE-a91d";
    const FILE = "SENTINEL-FILE-CONTENT-77be";
    const FILENAME = "SENTINEL-FILENAME-3c2a.txt";
    const PASSWORD = "SENTINEL-PASSWORD-0e5f-long";
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ username: "alice", password: PASSWORD }),
    });
    await upload(base, alice, FILENAME, Buffer.from(FILE), "text/plain");
    const sent = await post(base, alice, "/api/generations", {
      providerId: "local",
      model: "mock-chat",
      content: MESSAGE,
      operationKey: crypto.randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    expect(sent.status).toBe(202);
    await chatui.services.generations.settled((sent.body as { generationId: string }).generationId);
    await fetch(`${base}/api/does-not-exist?token=${alice.csrfToken}`, {
      headers: alice.headers(true),
    });
    const text = JSON.stringify(logs.lines());
    expect(logs.lines().length).toBeGreaterThan(0);
    const cookieValue = alice.cookie.split("=")[1] ?? "";
    for (const sentinel of [
      MESSAGE,
      FILE,
      FILENAME,
      PASSWORD,
      SECRET_KEY,
      alice.csrfToken,
      cookieValue,
    ])
      expect(text, sentinel.slice(0, 20)).not.toContain(sentinel);
  });
});

describe("upload polyglots (INV-27)", () => {
  it("a PNG with an HTML/script payload is served inert: exact bytes, image type, nosniff, sandbox", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    // A 1×1 PNG followed by markup: valid to an image decoder, HTML to a sniffer.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
        "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
      "hex",
    );
    const polyglot = Buffer.concat([png, Buffer.from("<html><script>alert(1)</script></html>")]);
    const res = await upload(base, alice, "evil.html", polyglot, "text/html");
    if (res.status === 201) {
      const id = (res.body as { id: string }).id;
      const served = await fetch(`${base}/api/attachments/${id}/content`, {
        headers: alice.headers(false),
      });
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(served.headers.get("content-security-policy")).toMatch(/sandbox/);
      expect(served.headers.get("content-disposition") ?? "").not.toMatch(/\.html?"/);
      expect(Buffer.from(await served.arrayBuffer()).equals(polyglot)).toBe(true);
    } else {
      expect(res.status).toBe(415);
    }
    // Markup that starts as HTML is never accepted, whatever it claims to be.
    const html = await upload(
      base,
      alice,
      "x.png",
      Buffer.from("<!doctype html><script>1</script>"),
      "image/png",
    );
    expect(html.status).toBe(415);
  });
});

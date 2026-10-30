import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../server/auth/service.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import type { AnyApiRoute } from "../../server/registry.ts";
import { apiRoutes } from "../../server/routes/index.ts";
import { createHttpServer, MAX_HEADER_BYTES } from "../../server/http-server.ts";
import { PathError, DataPaths } from "../../server/storage/paths.ts";
import { makePng } from "../support/media.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  authConfig,
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  type TestSession,
} from "./helpers.ts";

/**
 * Phase 16 security review: the checks that span every route or service.
 * Narrower ones live with their feature (auth, attachments, portability…).
 */

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 8 });
});
afterAll(async () => {
  await llama.close();
});

const servers: { server: Server; chatui: ChatUiApp }[] = [];
afterEach(async () => {
  for (const { server, chatui } of servers.splice(0)) {
    await chatui.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function serve(
  options: { rates?: { generation: number; upload: number; admin: number } } = {},
) {
  const dataDir = tempDataDir();
  const { chatui, logs } = testApp({
    config: {
      dataDir,
      provider: providerConfig({ baseUrl: llama.url }),
      auth: authConfig(options.rates ? { rateLimits: options.rates } : {}),
    },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, chatui, logs, dataDir };
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const key = (route: AnyApiRoute) => `${route.method.toUpperCase()} ${route.path}`;

function urlOf(route: AnyApiRoute, param?: string): string {
  let url: string = route.path;
  for (const [name, value] of Object.entries(route.fixture.params ?? {}))
    url = url.replace(`:${name}`, param ?? value);
  for (const name of url.match(/:[A-Za-z]+/g) ?? []) url = url.replace(name, param ?? UNKNOWN_ID);
  return url;
}

async function send(base: string, who: TestSession, content = "hello") {
  return fetch(`${base}/api/generations`, {
    method: "POST",
    headers: { ...who.headers(true), "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "local",
      model: MOCK_MODELS.chat,
      content,
      operationKey: crypto.randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    }),
  });
}

/** Sends and waits for the reply to be stored. */
async function sendAndWait(base: string, who: TestSession, content: string) {
  const res = await send(base, who, content);
  expect(res.status).toBe(202);
  const started = (await res.json()) as { conversationId: string; generationId: string };
  await (
    await fetch(`${base}/api/generations/${started.generationId}/stream`, {
      headers: who.headers(),
    })
  ).text();
  return started;
}

async function upload(base: string, who: TestSession, bytes: Buffer, filename: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), filename);
  return fetch(`${base}/api/attachments`, {
    method: "POST",
    headers: who.headers(true),
    body: form,
  });
}

const actor = (who: TestSession, role: "user" | "admin"): AuthContext => ({
  userId: who.userId,
  username: who.username,
  role,
  tokenHash: "0".repeat(64),
  csrfToken: who.csrfToken,
});

describe("per-account rate limits (Phase 16)", () => {
  it("generation starts, uploads and every admin change declare a category", () => {
    const declared = Object.fromEntries(
      apiRoutes.filter((r) => r.rateLimit).map((r) => [key(r), r.rateLimit]),
    );
    expect(declared).toMatchObject({
      "POST /api/generations": "generation",
      "POST /api/conversations/:id/messages/:messageId/regenerate": "generation",
      "POST /api/attachments": "upload",
      "PUT /api/profile/photo": "upload",
      "POST /api/import": "upload",
      "GET /api/export": "upload",
    });
    for (const route of apiRoutes.filter((r) => r.auth === "admin" && r.csrf === "token"))
      expect(route.rateLimit, key(route)).toBe("admin");
  });

  it("over the rate is RATE_LIMITED with Retry-After, per account; rejected requests cost nothing", async () => {
    const { base, chatui } = await serve({ rates: { generation: 2, upload: 2, admin: 2 } });
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    // A request that fails CSRF never reaches the limiter.
    for (let i = 0; i < 3; i++) {
      const forged = await fetch(`${base}/api/generations`, {
        method: "POST",
        headers: { Cookie: alice.cookie, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(forged.status).toBe(403);
    }
    expect((await sendAndWait(base, alice, "one")).conversationId).toBeTruthy();
    expect((await sendAndWait(base, alice, "two")).conversationId).toBeTruthy();
    const third = await send(base, alice, "three");
    expect(third.status).toBe(429);
    expect(await third.text()).toContain('"RATE_LIMITED"');
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Another account has its own allowance.
    await sendAndWait(base, bob, "bob one");

    const png = makePng(8, 8);
    expect((await upload(base, alice, png, "a.png")).status).toBe(201);
    expect((await upload(base, alice, png, "b.png")).status).toBe(201);
    const limited = await upload(base, alice, png, "c.png");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();

    const root = await signIn(base, chatui, "root", "admin");
    const patch = () =>
      fetch(`${base}/api/admin/settings`, {
        method: "PATCH",
        headers: { ...root.headers(true), "Content-Type": "application/json" },
        body: JSON.stringify({ notice: null }),
      });
    expect((await patch()).status).toBe(200);
    expect((await patch()).status).toBe(200);
    expect((await patch()).status).toBe(429);
    // Reads are not limited.
    const read = await fetch(`${base}/api/admin/settings`, { headers: root.headers() });
    expect(read.status).toBe(200);
  });
});

describe("authorization at the service boundary", () => {
  it("services called directly with another user's id find nothing and change nothing", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const s = chatui.services;
    const chat = await sendAndWait(base, alice, "private to alice");
    const attachmentRes = await upload(base, alice, makePng(8, 8), "alice.png");
    const attachment = (await attachmentRes.json()) as { id: string };
    const memory = await s.memory.create(alice.userId, { name: "Pet", body: "a cat" });

    await expect(s.conversations.get(bob.userId, chat.conversationId)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(s.conversations.list(bob.userId)).toEqual([]);
    await expect(s.conversationDto(bob.userId, chat.conversationId)).rejects.toThrow();
    expect(await s.attachments.get(bob.userId, attachment.id)).toBeNull();
    expect(await s.attachments.readBlob(bob.userId, attachment.id)).toBeNull();
    expect(await s.artifacts.list(bob.userId)).toEqual([]);
    expect((await s.memory.list(bob.userId)).map((m) => m.id)).not.toContain(memory.id);
    await expect(s.memory.delete(bob.userId, memory.id, memory.revision)).rejects.toThrow();
    await expect(s.mutations.deleteConversation(bob.userId, chat.conversationId)).rejects.toThrow();
    expect(() => s.generations.snapshot(chat.generationId, bob.userId)).toThrow();
    await expect(s.generations.cancel(chat.generationId, bob.userId)).rejects.toThrow();
    await expect(s.exportArchive(bob.userId)).resolves.toBeTruthy();
    // Alice's data is untouched.
    expect((await s.conversations.get(alice.userId, chat.conversationId)).model.title).toBeTruthy();
    expect(await s.attachments.get(alice.userId, attachment.id)).not.toBeNull();
    expect((await s.memory.list(alice.userId)).map((m) => m.id)).toContain(memory.id);
  });

  it("admin operations re-check the actor's current account, not the caller's claim", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const root = await signIn(base, chatui, "root", "admin");
    const admin = chatui.services.admin;
    // A forged context claiming the admin role for a normal account.
    const forged = actor(alice, "admin");
    await expect(admin.listUsers(forged)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      admin.setPassword(forged, root.userId, "a new long password"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(admin.updateUser(forged, alice.userId, { role: "admin" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(admin.readAudit(forged, "2026-10")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.settingsFor(forged)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.rebuildIndex(forged, undefined)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // The real admin works; once disabled, the same context is refused.
    const real = actor(root, "admin");
    expect((await admin.listUsers(real)).length).toBeGreaterThanOrEqual(2);
    await chatui.services.users.update(root.userId, { status: "disabled" });
    await expect(admin.listUsers(real)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("strict validation, enumerated over the registry", () => {
  it("every route with a JSON body rejects an unknown field; every route rejects an unknown query parameter", async () => {
    const { base, chatui } = await serve();
    const user = await signIn(base, chatui, "alice");
    const admin = await signIn(base, chatui, "root", "admin");
    let bodies = 0;
    for (const route of apiRoutes) {
      if (key(route) === "POST /api/auth/logout") continue;
      const who = route.auth === "admin" ? admin : user;
      const headers: Record<string, string> = {
        ...(route.auth === "public" ? {} : who.headers(route.csrf === "token")),
        ...(route.csrf === "origin" ? { Origin: "http://localhost:3000" } : {}),
      };
      const fixture = route.fixture.body;
      if (
        route.request.body &&
        fixture !== null &&
        typeof fixture === "object" &&
        !Array.isArray(fixture)
      ) {
        bodies++;
        const res = await fetch(`${base}${urlOf(route)}`, {
          method: route.method.toUpperCase(),
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ...fixture, unexpectedField: true }),
        });
        expect(res.status, `${key(route)} body`).toBe(400);
        expect(await res.text(), key(route)).toContain('"VALIDATION"');
      }
      const query = new URLSearchParams({ ...route.fixture.query, unexpected: "1" });
      const res = await fetch(`${base}${urlOf(route)}?${query.toString()}`, {
        method: route.method.toUpperCase(),
        headers: {
          ...headers,
          ...(fixture === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(fixture === undefined ? {} : { body: JSON.stringify(fixture) }),
      });
      expect(res.status, `${key(route)} query`).toBe(400);
    }
    expect(bodies).toBeGreaterThanOrEqual(25);
  });
});

describe("error leakage (fuzzed malformed input)", () => {
  const LEAKS = [
    /\/home\//,
    /\/tmp\//,
    /node_modules/,
    /\n\s+at /,
    /ENOENT|EACCES|EISDIR/,
    /TypeError|ReferenceError|SyntaxError: /,
  ];

  it("no route answers malformed input with a 500, a stack, a path or an upstream body", async () => {
    const { base, chatui, dataDir } = await serve();
    const user = await signIn(base, chatui, "alice");
    const admin = await signIn(base, chatui, "root", "admin");
    const bodies = [
      "{",
      "[]",
      '"text"',
      "null",
      "123",
      JSON.stringify({ content: "x".repeat(200_000) }),
      JSON.stringify({ a: { b: { c: { d: { e: [[[[[[[[[[1]]]]]]]]]] } } } } }),
      JSON.stringify({ __proto__: { admin: true }, constructor: { prototype: { x: 1 } } }),
    ];
    const params = [
      "..%2F..%2Fetc%2Fpasswd",
      "%00",
      "a".repeat(300),
      "NOT-A-UUID",
      "..",
      "%E0%A4%A",
    ];
    let calls = 0;
    for (const route of apiRoutes) {
      if (key(route) === "POST /api/auth/logout" || key(route) === "POST /api/auth/password")
        continue;
      const who = route.auth === "admin" ? admin : user;
      const headers: Record<string, string> = {
        ...(route.auth === "public" ? {} : who.headers(route.csrf === "token")),
        ...(route.csrf === "origin" ? { Origin: "http://localhost:3000" } : {}),
      };
      const attempts: { url: string; body?: string }[] = [];
      if (route.method !== "get")
        for (const body of bodies) attempts.push({ url: urlOf(route), body });
      if (route.path.includes(":")) for (const p of params) attempts.push({ url: urlOf(route, p) });
      for (const attempt of attempts) {
        calls++;
        const res = await fetch(`${base}${attempt.url}`, {
          method: route.method.toUpperCase(),
          headers: {
            ...headers,
            ...(attempt.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(attempt.body === undefined ? {} : { body: attempt.body }),
        });
        const text = await res.text();
        const label = `${key(route)} ${attempt.url.slice(0, 60)} ${String(attempt.body).slice(0, 30)}`;
        expect(res.status, label).toBeLessThan(500);
        if (res.status >= 400) {
          expect(res.headers.get("content-type"), label).toMatch(/^application\/json/);
          const parsed = JSON.parse(text) as { error?: { code?: unknown } };
          expect(typeof parsed.error?.code, label).toBe("string");
        }
        for (const leak of LEAKS) expect(text, label).not.toMatch(leak);
        expect(text, label).not.toContain(dataDir);
      }
    }
    expect(calls).toBeGreaterThan(300);
  });
});

describe("logs at the default level", () => {
  it("never contain passwords, tokens, cookies, message text, file names or file contents", async () => {
    const { base, chatui, logs } = await serve();
    const SECRET_TEXT = "sentinel-message-7f3a";
    const SECRET_FILE = "sentinel-file-b81c.png";
    const SECRET_MEMORY = "sentinel-memory-42d9";
    const alice = await signIn(base, chatui, "alice");
    // A failed login with a sentinel password.
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ username: "alice", password: "sentinel-password-9e1b" }),
    });
    await sendAndWait(base, alice, SECRET_TEXT);
    await upload(base, alice, makePng(8, 8), SECRET_FILE);
    await chatui.services.memory.create(alice.userId, { name: "Note", body: SECRET_MEMORY });
    await fetch(`${base}/api/search?q=${SECRET_TEXT}&limit=5`, { headers: alice.headers() });
    const cookieValue = alice.cookie.split("=")[1] ?? "";
    const all = JSON.stringify(logs.lines());
    expect(logs.lines().length).toBeGreaterThan(5);
    for (const sentinel of [
      SECRET_TEXT,
      SECRET_FILE,
      SECRET_MEMORY,
      "sentinel-password-9e1b",
      alice.csrfToken,
      cookieValue,
    ])
      expect(all, sentinel).not.toContain(sentinel);
  });
});

describe("filesystem paths (INV-12, INV-28)", () => {
  it("every path constructor refuses request-controlled components", () => {
    const paths = new DataPaths(tempDataDir());
    const user = "11111111-1111-4111-8111-111111111111";
    const hostile = [
      "..",
      "../x",
      "a/b",
      "",
      "/etc/passwd",
      "%2e%2e",
      "x\0y",
      "11111111-1111-4111-8111-11111111111A",
      "C:\\x",
    ];
    const constructors: [string, (bad: string) => string][] = [
      ["userDir", (b) => paths.userDir(b)],
      ["chatFile user", (b) => paths.chatFile(b, user)],
      ["chatFile id", (b) => paths.chatFile(user, b)],
      ["operationFile", (b) => paths.operationFile(user, b)],
      ["attachmentDir", (b) => paths.attachmentDir(user, b)],
      ["memoryFile", (b) => paths.memoryFile(user, b)],
      ["proposalFile", (b) => paths.proposalFile(user, b)],
      ["artifactDir", (b) => paths.artifactDir(user, b)],
      ["importDir", (b) => paths.importDir(user, b)],
      ["temporaryFile", (b) => paths.temporaryFile(b)],
      ["profilePhoto", (b) => paths.profilePhoto(b)],
      ["preferencesFile", (b) => paths.preferencesFile(b)],
      ["generationFile", (b) => paths.generationFile(b)],
      ["sessionFile", (b) => paths.sessionFile(b)],
      ["auditFile", (b) => paths.auditFile(b)],
      ["deletingEntry", (b) => paths.deletingEntry(user, b)],
    ];
    for (const [name, build] of constructors)
      for (const bad of hostile)
        expect(() => build(bad), `${name}(${JSON.stringify(bad)})`).toThrow(PathError);
  });
});

describe("security headers on every kind of response", () => {
  it("HTML, JSON, attachment bytes and errors carry the same hardening headers", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const attachment = (await (await upload(base, alice, makePng(8, 8), "h.png")).json()) as {
      id: string;
    };
    const responses = {
      html: await fetch(`${base}/`),
      api: await fetch(`${base}/api/conversations`, { headers: alice.headers() }),
      bytes: await fetch(`${base}/api/attachments/${attachment.id}/content`, {
        headers: alice.headers(),
      }),
      error: await fetch(`${base}/api/nope`),
    };
    for (const [kind, res] of Object.entries(responses)) {
      const h = (name: string) => res.headers.get(name) ?? "";
      expect(h("permissions-policy"), kind).toContain("camera=()");
      expect(h("permissions-policy"), kind).toContain("microphone=(self)");
      expect(h("permissions-policy"), kind).toContain("geolocation=()");
      expect(h("x-content-type-options"), kind).toBe("nosniff");
      expect(h("referrer-policy"), kind).toBe("no-referrer");
      expect(h("x-frame-options"), kind).toBe("DENY");
      expect(h("cross-origin-opener-policy"), kind).toBe("same-origin");
      expect(h("content-security-policy"), kind).toMatch(/frame-ancestors 'none'|sandbox/);
      expect(h("x-powered-by"), kind).toBe("");
    }
    expect(responses.bytes.headers.get("content-security-policy")).toContain("sandbox");
    expect(responses.api.headers.get("cache-control")).toBe("no-store");
  });
});

describe("HTTP server limits (INV-62)", () => {
  it("oversized headers are refused before any handler; connections are capped", async () => {
    let reached = 0;
    const server = createHttpServer(
      (_req, res) => {
        reached++;
        res.end("ok");
      },
      { maxConnections: 64, requestTimeoutMs: 60_000 },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
    try {
      expect(server.maxConnections).toBe(64);
      expect(server.headersTimeout).toBe(30_000);
      expect(server.requestTimeout).toBe(60_000);
      expect((await fetch(url)).status).toBe(200);
      const big = await fetch(url, { headers: { "X-Big": "x".repeat(MAX_HEADER_BYTES + 1) } });
      expect(big.status).toBe(431);
      expect(reached).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("a document path that can't be decoded is a plain 400, never the document handler", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/chat/%E0%A4%A`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).not.toContain("document");
  });
});

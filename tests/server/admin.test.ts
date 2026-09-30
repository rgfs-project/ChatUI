import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import type { AnyApiRoute } from "../../server/registry.ts";
import { apiRoutes } from "../../server/routes/index.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  TEST_PASSWORD,
  type TestAppOptions,
  type TestSession,
} from "./helpers.ts";

/** Phase 10: server-enforced administration (INV-17, INV-24–INV-26, INV-61). */

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ chunkDelayMs: 60, slowChunks: 40 });
});
afterAll(async () => {
  await llama.close();
});

interface Running {
  base: string;
  chatui: ChatUiApp;
  dataDir: string;
  logs: ReturnType<typeof testApp>["logs"];
  admin: TestSession;
  user: TestSession;
}

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

async function start(extra: TestAppOptions = {}, dataDir = tempDataDir()): Promise<Running> {
  const { chatui, logs } = testApp({
    ...extra,
    config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const admin = await signIn(base, chatui, "root", "admin");
  const user = await signIn(base, chatui, "alice", "user");
  return { base, chatui, dataDir, logs, admin, user };
}

async function api(
  run: { base: string },
  session: TestSession | null,
  method: string,
  url: string,
  body?: unknown,
) {
  const res = await fetch(`${run.base}${url}`, {
    method,
    headers: {
      ...(session ? session.headers(method !== "GET") : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    headers: JSON.stringify(Object.fromEntries(res.headers)),
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const adminRoutes = apiRoutes.filter((r) => r.auth === "admin");

function urlOf(route: AnyApiRoute): string {
  let url: string = route.path;
  for (const [name, value] of Object.entries(route.fixture.params ?? {}))
    url = url.replace(`:${name}`, value);
  for (const name of url.match(/:[A-Za-z]+/g) ?? []) url = url.replace(name, UNKNOWN);
  const query = new URLSearchParams(route.fixture.query ?? {}).toString();
  return query ? `${url}?${query}` : url;
}

async function callFixture(run: Running, route: AnyApiRoute, session: TestSession | null) {
  return api(run, session, route.method.toUpperCase(), urlOf(route), route.fixture.body);
}

async function startSlow(run: Running, session: TestSession) {
  const res = await api(run, session, "POST", "/api/generations", {
    providerId: "local",
    model: MOCK_MODELS.slow,
    content: "keep generating",
    operationKey: randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });
  expect(res.status).toBe(202);
  return res.body as { conversationId: string; generationId: string };
}

describe("INV-24: every admin route is authorized on the server", () => {
  it("unauthenticated 401, non-admin 403 FORBIDDEN, disabled admin 401, admin success", async () => {
    const run = await start();
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
    const second = await signIn(run.base, run.chatui, "second", "admin");
    const secondId = second.userId;
    for (const route of adminRoutes) {
      const anon = await callFixture(run, route, null);
      expect(anon.status, `${route.path} anonymous`).toBe(401);
      const plain = await callFixture(run, route, run.user);
      expect(plain.status, `${route.path} non-admin`).toBe(403);
      expect(plain.text).toContain('"FORBIDDEN"');
      const ok = await callFixture(run, route, run.admin);
      expect(ok.status, `${route.path} admin`).toBe(
        route.fixture.expectStatus ?? (route.kind === "sse" ? 200 : (route.status ?? 200)),
      );
    }
    // A disabled admin's session no longer works on any admin route.
    const disabled = await api(run, run.admin, "PATCH", `/api/admin/users/${secondId}`, {
      status: "disabled",
    });
    expect(disabled.status).toBe(200);
    for (const route of adminRoutes) {
      const res = await callFixture(run, route, second);
      expect(res.status, `${route.path} disabled admin`).toBe(401);
    }
  });

  it("role escalation: `role` in any non-admin request is rejected by the schema", async () => {
    const run = await start();
    const attempts: [string, string, unknown][] = [
      ["PATCH", "/api/preferences", { role: "admin" }],
      [
        "POST",
        "/api/auth/password",
        { currentPassword: TEST_PASSWORD, newPassword: "x".repeat(12), role: "admin" },
      ],
      ["POST", "/api/conversations", { title: "t", role: "admin" }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await api(run, run.user, method, url, body);
      expect(res.status, url).toBe(400);
      expect(res.text).toContain('"VALIDATION"');
    }
    const who = await api(run, run.user, "GET", "/api/auth/session");
    expect((who.body.user as { role: string }).role).toBe("user");
  });

  it("a demoted admin is locked out on the next request", async () => {
    const run = await start();
    const second = await signIn(run.base, run.chatui, "second", "admin");
    expect((await api(run, second, "GET", "/api/admin/users")).status).toBe(200);
    const demoted = await api(run, run.admin, "PATCH", `/api/admin/users/${second.userId}`, {
      role: "user",
    });
    expect(demoted.status).toBe(200);
    expect((await api(run, second, "GET", "/api/admin/users")).status).toBe(401);
    expect((await api(run, second, "GET", "/api/conversations")).status).toBe(401);
  });
});

describe("INV-17: reductions take effect immediately", () => {
  it("disabling cancels an active generation; its observers are closed and later reads are 404", async () => {
    const run = await start();
    const started = await startSlow(run, run.user);
    const stream = await fetch(`${run.base}/api/generations/${started.generationId}/stream`, {
      headers: run.user.headers(),
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    await reader?.read();
    const res = await api(run, run.admin, "PATCH", `/api/admin/users/${run.user.userId}`, {
      status: "disabled",
    });
    expect(res.status).toBe(200);
    // The open stream ends.
    await vi.waitFor(
      async () => {
        const chunk = await reader?.read();
        expect(chunk?.done).toBe(true);
      },
      { timeout: 5_000 },
    );
    // Re-enabled and signed in again: the cancelled generation is gone.
    await api(run, run.admin, "PATCH", `/api/admin/users/${run.user.userId}`, { status: "active" });
    const again = await signIn(run.base, run.chatui, "alice", "user");
    expect((await api(run, again, "GET", `/api/generations/${started.generationId}`)).status).toBe(
      404,
    );
    const reopen = await fetch(`${run.base}/api/generations/${started.generationId}/stream`, {
      headers: again.headers(),
    });
    expect(reopen.status).toBe(404);
  });

  it("an admin-set password revokes every session of the account", async () => {
    const run = await start();
    const res = await api(run, run.admin, "POST", `/api/admin/users/${run.user.userId}/password`, {
      password: "a brand new password",
    });
    expect(res.status).toBe(200);
    expect((await api(run, run.user, "GET", "/api/conversations")).status).toBe(401);
    const login = await fetch(`${run.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ username: "alice", password: "a brand new password" }),
    });
    expect(login.status).toBe(200);
  });
});

describe("INV-26: there is always an active admin", () => {
  it("the last admin can't be demoted, disabled or deleted, including by themselves", async () => {
    const run = await start();
    const self = run.admin.userId;
    for (const [method, body] of [
      ["PATCH", { role: "user" }],
      ["PATCH", { status: "disabled" }],
      ["DELETE", { confirmUsername: "root" }],
    ] as const) {
      const url = `/api/admin/users/${self}`;
      const res = await api(run, run.admin, method, url, body);
      expect(res.status, `${method} ${JSON.stringify(body)}`).toBe(409);
      expect(res.text).toContain('"LAST_ADMIN"');
    }
    // With a second active admin, self-demotion is allowed.
    await signIn(run.base, run.chatui, "second", "admin");
    const ok = await api(run, run.admin, "PATCH", `/api/admin/users/${self}`, { role: "user" });
    expect(ok.status).toBe(200);
  });
});

describe("INV-19/INV-25: providers", () => {
  it("SSRF validation runs on create, edit and test; metadata and blocked hosts are refused", async () => {
    const resolver = vi.fn((host: string) =>
      Promise.resolve([
        { address: host === "evil.example" ? "169.254.169.254" : "127.0.0.1", family: 4 },
      ]),
    );
    const run = await start({ resolver });
    const base = {
      id: "second",
      name: "Second",
      capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
    };
    for (const baseUrl of ["http://169.254.169.254/v1", "http://evil.example:8080", "ftp://x"]) {
      const res = await api(run, run.admin, "POST", "/api/admin/providers", { ...base, baseUrl });
      expect(res.status, baseUrl).toBe(400);
    }
    const created = await api(run, run.admin, "POST", "/api/admin/providers", {
      ...base,
      baseUrl: llama.url,
    });
    expect(created.status).toBe(201);
    const edit = await api(run, run.admin, "PATCH", "/api/admin/providers/second", {
      baseUrl: "http://evil.example:8080",
    });
    expect(edit.status).toBe(400);
    expect(edit.text).toContain('"ENDPOINT_NOT_ALLOWED"');
    const test = await api(run, run.admin, "POST", "/api/admin/providers/second/test");
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(true);
  });

  it("secrets are write-only: replace, keep and clear; the key never appears in responses", async () => {
    const run = await start();
    const SECRET = "sk-SENTINEL-provider-9a8b7c";
    const created = await api(run, run.admin, "POST", "/api/admin/providers", {
      id: "keyed",
      name: "Keyed",
      baseUrl: llama.url,
      apiKey: SECRET,
      capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
    });
    expect(created.status).toBe(201);
    expect(created.body.hasApiKey).toBe(true);
    const kept = await api(run, run.admin, "PATCH", "/api/admin/providers/keyed", {
      name: "Renamed",
    });
    expect(kept.body.hasApiKey).toBe(true);
    const onDisk = readFileSync(path.join(run.dataDir, "_system", "providers.json"), "utf8");
    expect(onDisk).toContain(SECRET);
    const cleared = await api(run, run.admin, "PATCH", "/api/admin/providers/keyed", {
      clearApiKey: true,
    });
    expect(cleared.body.hasApiKey).toBe(false);
    const list = await api(run, run.admin, "GET", "/api/admin/providers");
    for (const res of [created, kept, cleared, list]) expect(res.text).not.toContain(SECRET);
    // Reloaded in-process: the new provider is usable without a restart.
    const models = await api(run, run.user, "GET", "/api/models");
    expect(JSON.stringify(models.body)).toContain('"keyed"');
    expect((await api(run, run.admin, "DELETE", "/api/admin/providers/keyed")).status).toBe(200);
  });
});

describe("models and settings", () => {
  it("hidden models are gone for users and rejected on send; admins still see and use them", async () => {
    const run = await start();
    const hide = await api(run, run.admin, "PUT", "/api/admin/model-settings", {
      providerId: "local",
      modelId: MOCK_MODELS.chat,
      hidden: true,
    });
    expect(hide.status).toBe(200);
    const forUser = await api(run, run.user, "GET", "/api/models");
    expect(JSON.stringify(forUser.body)).not.toContain(`"${MOCK_MODELS.chat}"`);
    const forAdmin = await api(run, run.admin, "GET", "/api/models");
    expect(JSON.stringify(forAdmin.body)).toContain(`"${MOCK_MODELS.chat}"`);
    const send = (session: TestSession) =>
      api(run, session, "POST", "/api/generations", {
        providerId: "local",
        model: MOCK_MODELS.chat,
        content: "hi",
        operationKey: randomUUID(),
        operationIssuedAt: new Date().toISOString(),
      });
    const rejected = await send(run.user);
    expect(rejected.status).toBe(400);
    expect(rejected.text).toContain('"MODEL_NOT_FOUND"');
    expect((await send(run.admin)).status).toBe(202);
  });

  it("per-model sampling reaches the provider; templates expand once; time goes in the context block", async () => {
    let now = new Date("2026-03-01T10:15:00Z");
    const run = await start({ now: () => now });
    await api(run, run.admin, "PATCH", "/api/admin/settings", { timezone: "Europe/Berlin" });
    const saved = await api(run, run.admin, "PUT", "/api/admin/model-settings", {
      providerId: "local",
      modelId: MOCK_MODELS.chat,
      temperature: 0.3,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      systemPrompt: "You help {{username}}. Today is {{date}} ({{timezone}}).",
      timeContext: true,
    });
    expect(saved.status).toBe(200);
    const before = llama.requests.length;
    const send = async (content: string, conversationId?: string) => {
      const res = await api(run, run.user, "POST", "/api/generations", {
        ...(conversationId ? { conversationId } : {}),
        providerId: "local",
        model: MOCK_MODELS.chat,
        content,
        operationKey: randomUUID(),
        operationIssuedAt: now.toISOString(),
      });
      const body = res.body as { conversationId: string; generationId: string };
      await vi.waitFor(
        async () => {
          const g = await api(run, run.user, "GET", `/api/generations/${body.generationId}`);
          expect(g.body.state).toBe("completed");
        },
        { timeout: 5_000 },
      );
      return body.conversationId;
    };
    const conversationId = await send("Please say {{username}} literally.");
    now = new Date("2026-03-01T10:16:00Z");
    await send("And again.", conversationId);
    const chats = llama.requests
      .slice(before)
      .filter((r) => r.path === "/v1/chat/completions")
      .map(
        (r) =>
          r.body as { messages: { role: string; content: string }[] } & Record<string, unknown>,
      );
    expect(chats).toHaveLength(2);
    const [first, second] = chats;
    expect(first).toMatchObject({
      temperature: 0.3,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.1,
    });
    expect(first?.messages[0]).toEqual({
      role: "system",
      content: "You help alice. Today is 2026-03-01 (Europe/Berlin).",
    });
    // User text is never template-expanded; the time is only in the newest message.
    const lastOf = (b: typeof first) => b?.messages.at(-1)?.content ?? "";
    expect(lastOf(first)).toBe(
      "[Context: the current time is 11:15 (Europe/Berlin).]\n\nPlease say {{username}} literally.",
    );
    expect(lastOf(second)).toContain("11:16");
    // The system prefix is unchanged a minute later, and so is the earlier history.
    expect(second?.messages[0]).toEqual(first?.messages[0]);
    expect(second?.messages[1]?.content).toBe("Please say {{username}} literally.");
  });

  it("rejects unsupported sampling overrides and disallowed template variables", async () => {
    const run = await start();
    await api(run, run.admin, "POST", "/api/admin/providers", {
      id: "openai",
      name: "Plain OpenAI API",
      baseUrl: llama.url,
      samplingExtensions: false,
      capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
    });
    const topK = await api(run, run.admin, "PUT", "/api/admin/model-settings", {
      providerId: "openai",
      modelId: "gpt",
      topK: 10,
    });
    expect(topK.status).toBe(400);
    for (const systemPrompt of ["It is {{time}}", "Hello {{password}}"]) {
      const res = await api(run, run.admin, "PUT", "/api/admin/model-settings", {
        providerId: "local",
        modelId: MOCK_MODELS.chat,
        systemPrompt,
      });
      expect(res.status, systemPrompt).toBe(400);
    }
    const range = await api(run, run.admin, "PUT", "/api/admin/model-settings", {
      providerId: "local",
      modelId: MOCK_MODELS.chat,
      temperature: 5,
    });
    expect(range.status).toBe(400);
  });

  it("a settings change between preflight and commit is picked up (revision recheck)", async () => {
    let changed = false;
    const run = await start({
      send: {
        hooks: {
          beforeRecheck: async () => {
            if (changed) return;
            changed = true;
            await run.chatui.services.admin.settings.update((s) => ({
              ...s,
              models: [{ providerId: "local", modelId: MOCK_MODELS.chat, systemPrompt: "Second" }],
            }));
          },
        },
      },
    });
    const before = llama.requests.length;
    const res = await api(run, run.user, "POST", "/api/generations", {
      providerId: "local",
      model: MOCK_MODELS.chat,
      content: "hello",
      operationKey: randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    expect(res.status).toBe(202);
    await vi.waitFor(() => {
      const chat = llama.requests.slice(before).find((r) => r.path === "/v1/chat/completions");
      expect(
        (chat?.body as { messages: { content: string }[] } | undefined)?.messages[0]?.content,
      ).toBe("Second");
    });
  });

  it("registration mode and generation limits apply live from settings", async () => {
    const run = await start();
    const register = () =>
      fetch(`${run.base}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
        body: JSON.stringify({ username: `u${String(Date.now())}`, password: "a long password" }),
      });
    expect((await register()).status).toBe(403);
    await api(run, run.admin, "PATCH", "/api/admin/settings", { registrationMode: "open" });
    expect((await register()).status).toBe(201);
    const settings = await api(run, run.admin, "GET", "/api/admin/settings");
    expect(settings.body).toMatchObject({
      registrationMode: "open",
      registrationModeSource: "settings",
    });
    await api(run, run.admin, "PATCH", "/api/admin/settings", {
      generation: { maxActivePerUser: 1 },
    });
    await startSlow(run, run.user);
    const second = await api(run, run.user, "POST", "/api/generations", {
      providerId: "local",
      model: MOCK_MODELS.slow,
      content: "another",
      operationKey: randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    expect(second.status).toBe(429);
  });
});

describe("INV-61: account closure", () => {
  it("deletion requires the username, removes the directory and the account can't log in", async () => {
    const run = await start();
    await api(run, run.user, "POST", "/api/conversations", { title: "private" });
    const userDir = path.join(run.dataDir, run.user.userId);
    expect(existsSync(userDir)).toBe(true);
    const wrong = await api(run, run.admin, "DELETE", `/api/admin/users/${run.user.userId}`, {
      confirmUsername: "not-alice",
    });
    expect(wrong.status).toBe(400);
    const ok = await api(run, run.admin, "DELETE", `/api/admin/users/${run.user.userId}`, {
      confirmUsername: "alice",
    });
    expect(ok.status).toBe(200);
    expect(existsSync(userDir)).toBe(false);
    expect(readdirSync(path.join(run.dataDir, "_system", "deleting"))).toEqual([]);
    expect((await api(run, run.user, "GET", "/api/conversations")).status).toBe(401);
    const login = await fetch(`${run.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ username: "alice", password: TEST_PASSWORD }),
    });
    expect(login.status).toBe(401);
  });

  it("deletion during a generation: cancelled and drained, the terminal write is skipped, nothing recreates the directory", async () => {
    const run = await start();
    const started = await startSlow(run, run.user);
    await vi.waitFor(async () => {
      const g = await api(run, run.user, "GET", `/api/generations/${started.generationId}`);
      expect(g.body.state).toBe("streaming");
    });
    const res = await api(run, run.admin, "DELETE", `/api/admin/users/${run.user.userId}`, {
      confirmUsername: "alice",
    });
    expect(res.status).toBe(200);
    const userDir = path.join(run.dataDir, run.user.userId);
    expect(existsSync(userDir)).toBe(false);
    // Nothing writes it back later (checkpoint flushes, late terminal writes).
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(userDir)).toBe(false);
    const checkpoints = readdirSync(path.join(run.dataDir, "_system", "generations")).filter((f) =>
      readFileSync(path.join(run.dataDir, "_system", "generations", f), "utf8").includes(
        run.user.userId,
      ),
    );
    expect(checkpoints).toEqual([]);
  });

  it("an in-flight writer finishes before the exclusive step; a later writer aborts without recreating the account", async () => {
    const run = await start();
    const { chatui } = run;
    const id = run.user.userId;
    let releaseWriter!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWriter = r;
    });
    // A write already inside the barrier (e.g. a terminal write in progress).
    const inflight = chatui.services.preferences.update(id, {}).then(() => gate);
    const writerHeld = chatui.services.preferences.update(id, { historyImages: "none" } as never);
    void writerHeld.catch(() => undefined);
    const deletion = api(run, run.admin, "DELETE", `/api/admin/users/${id}`, {
      confirmUsername: "alice",
    });
    releaseWriter();
    await inflight;
    expect((await deletion).status).toBe(200);
    await expect(chatui.services.preferences.update(id, {})).rejects.toThrow(/closed/);
    expect(existsSync(path.join(run.dataDir, id))).toBe(false);
  });

  it("a crash after `closing` was recorded resumes and completes closure at startup", async () => {
    const dataDir = tempDataDir();
    const first = await start({}, dataDir);
    const id = first.user.userId;
    await api(first, first.user, "POST", "/api/conversations", { title: "x" });
    const file = path.join(dataDir, id, "user.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, status: "closing" }));
    const second = testApp({
      config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
    });
    await second.chatui.ready;
    expect(existsSync(path.join(dataDir, id))).toBe(false);
    await second.chatui.shutdown();
  });

  it("a crash during removal (directory already detached) finishes deleting it at startup", async () => {
    const dataDir = tempDataDir();
    const first = await start({}, dataDir);
    const id = first.user.userId;
    const detached = await first.chatui.services.users.detach(id);
    expect(detached && existsSync(detached)).toBe(true);
    const second = testApp({
      config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
    });
    await second.chatui.ready;
    expect(readdirSync(path.join(dataDir, "_system", "deleting"))).toEqual([]);
    await second.chatui.shutdown();
  });
});

describe("audit and secret exposure", () => {
  it("audit entries record actor, action, target and outcome, never secret values", async () => {
    const run = await start();
    const SECRET = "PW-SENTINEL-4f2e1d";
    await api(run, run.admin, "POST", "/api/admin/users", {
      username: "bob",
      password: SECRET,
      role: "user",
    });
    await api(run, run.admin, "POST", `/api/admin/users/${run.user.userId}/password`, {
      password: `${SECRET}-2`,
    });
    await api(run, run.admin, "PATCH", `/api/admin/users/${run.admin.userId}`, { role: "user" });
    const auditDir = path.join(run.dataDir, "_system", "audit");
    const text = readdirSync(auditDir)
      .map((f) => readFileSync(path.join(auditDir, f), "utf8"))
      .join("");
    expect(text).not.toContain(SECRET);
    const entries = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.map((e) => [e.action, e.outcome])).toEqual([
      ["user.create", "success"],
      ["user.password", "success"],
      ["user.update", "failure"],
    ]);
    expect(entries[2]).toMatchObject({ code: "LAST_ADMIN", actor: { username: "root" } });
    const viaApi = await api(run, run.admin, "GET", "/api/admin/audit?limit=2");
    expect((viaApi.body.entries as unknown[]).length).toBe(2);
  });

  it("known sentinel secrets never appear in any response body, header or log line", async () => {
    const run = await start();
    const KEY = "sk-EXPOSURE-SENTINEL-7d6c5b";
    const PASSWORD = "pw-EXPOSURE-SENTINEL-1a2b3c";
    await api(run, run.admin, "POST", "/api/admin/providers", {
      id: "sentinel",
      name: "Sentinel",
      baseUrl: llama.url,
      apiKey: KEY,
      capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
    });
    await api(run, run.admin, "POST", "/api/admin/users", {
      username: "carol",
      password: PASSWORD,
      role: "user",
    });
    const seen: string[] = [];
    for (const route of apiRoutes) {
      if (route.path === "/api/auth/logout" || route.path === "/api/auth/password") continue;
      if (route.kind === "sse") continue;
      const session = route.auth === "admin" ? run.admin : route.auth === "user" ? run.user : null;
      const res = await callFixture(run, route, session);
      seen.push(res.text, res.headers);
    }
    for (const url of [
      "/api/admin/providers",
      "/api/admin/users",
      "/api/admin/settings",
      "/api/admin/audit",
      "/api/models",
      "/api/providers",
    ]) {
      const res = await api(run, run.admin, "GET", url);
      seen.push(res.text, res.headers);
    }
    const all = seen.join("\n") + JSON.stringify(run.logs.lines());
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(PASSWORD);
  });
});

describe("maintenance", () => {
  it("rebuilds the conversation index for one user or everyone", async () => {
    const run = await start();
    await api(run, run.user, "POST", "/api/conversations", { title: "one" });
    await api(run, run.user, "POST", "/api/conversations", { title: "two" });
    const one = await api(run, run.admin, "POST", "/api/admin/maintenance/rebuild-index", {
      userId: run.user.userId,
    });
    expect(one.body).toEqual({ conversations: 2 });
    const all = await api(run, run.admin, "POST", "/api/admin/maintenance/rebuild-index", {});
    expect(all.body).toEqual({ conversations: 2 });
    const users = await api(run, run.admin, "GET", "/api/admin/users");
    const alice = (users.body.users as { username: string; conversationCount: number }[]).find(
      (u) => u.username === "alice",
    );
    expect(alice?.conversationCount).toBe(2);
    expect(users.text).not.toContain("passwordHash");
  });
});

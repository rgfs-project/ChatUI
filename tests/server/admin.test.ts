import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import type { Resolver } from "../../server/providers/ssrf.ts";
import { apiRoutes } from "../../server/routes/index.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  localProvider,
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  TEST_ORIGIN,
  TEST_PASSWORD,
  writeProviders,
  type TestSession,
} from "./helpers.ts";

const SECRET_KEY = "sk-SENTINEL-ADMIN-KEY-5a1c";
const SECRET_PASSWORD = "sentinel password 9d3e77";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4, chunkDelayMs: 40, slowChunks: 40 });
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

/** Resolves evil.example to the cloud metadata address (DNS cannot be trusted). */
const resolver: Resolver = (host) =>
  Promise.resolve(
    host === "evil.example"
      ? [{ address: "169.254.169.254", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }],
  );

async function serve(dataDir = tempDataDir(), now?: () => Date) {
  const { chatui, logs } = testApp({
    config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
    resolver,
    ...(now ? { now } : {}),
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    chatui,
    logs,
    dataDir,
  };
}

async function api(
  base: string,
  who: TestSession | null,
  method: string,
  url: string,
  body?: unknown,
) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(who ? who.headers(method !== "GET") : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  // Downloads (the export archive) are not JSON.
  const json = res.headers.get("content-type")?.startsWith("application/json")
    ? (JSON.parse(text) as Record<string, unknown>)
    : null;
  return { status: res.status, text, json, headers: res.headers };
}

const adminRoutes = apiRoutes.filter((r) => r.auth === "admin");
const urlOf = (route: (typeof adminRoutes)[number]) =>
  route.path.replace(/:id/g, route.fixture.params?.id ?? "00000000-0000-4000-8000-000000000000");

describe("INV-24: admin authorization is server-side on every admin route", () => {
  it("unauthenticated 401, non-admin 403 FORBIDDEN, disabled admin 401", async () => {
    const { base, chatui } = await serve();
    const user = await signIn(base, chatui, "plain");
    const admin = await signIn(base, chatui, "boss", "admin");
    await signIn(base, chatui, "second", "admin");
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
    for (const route of adminRoutes) {
      const body = route.fixture.body;
      const anon = await api(base, null, route.method.toUpperCase(), urlOf(route), body);
      expect(anon.status, `${route.path} anon`).toBe(401);
      const plain = await api(base, user, route.method.toUpperCase(), urlOf(route), body);
      expect(plain.status, `${route.path} user`).toBe(403);
      expect(plain.text).toContain('"FORBIDDEN"');
    }
    await chatui.services.users.update(admin.userId, { status: "disabled" });
    const disabled = await api(base, admin, "GET", "/api/admin/users");
    expect(disabled.status).toBe(401);
  });

  it("role escalation through any user route is rejected by schema", async () => {
    const { base, chatui } = await serve();
    const user = await signIn(base, chatui, "climber");
    const prefs = await api(base, user, "PATCH", "/api/preferences", { role: "admin" });
    expect(prefs.status).toBe(400);
    const register = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: TEST_ORIGIN },
      body: JSON.stringify({ username: "sneaky", password: TEST_PASSWORD, role: "admin" }),
    });
    expect(register.status).toBe(400);
  });

  it("a demoted admin is locked out on the next request (INV-17)", async () => {
    const { base, chatui } = await serve();
    const boss = await signIn(base, chatui, "boss", "admin");
    const other = await signIn(base, chatui, "other", "admin");
    const demote = await api(base, boss, "PATCH", `/api/admin/users/${other.userId}`, {
      role: "user",
    });
    expect(demote.status).toBe(200);
    expect((await api(base, other, "GET", "/api/admin/users")).status).toBe(401);
    expect((await api(base, other, "GET", "/api/conversations")).status).toBe(401);
  });
});

describe("INV-26: there is always at least one active admin", () => {
  it("the last admin cannot be demoted, disabled or deleted, including oneself", async () => {
    const { base, chatui } = await serve();
    const boss = await signIn(base, chatui, "boss", "admin");
    for (const [method, url, body] of [
      ["PATCH", `/api/admin/users/${boss.userId}`, { role: "user" }],
      ["PATCH", `/api/admin/users/${boss.userId}`, { status: "disabled" }],
      ["DELETE", `/api/admin/users/${boss.userId}`, { confirmUsername: "boss" }],
    ] as const) {
      const res = await api(base, boss, method, url, body);
      expect(res.status, `${method} ${JSON.stringify(body)}`).toBe(409);
      expect(res.text).toContain('"LAST_ADMIN"');
    }
    const second = await signIn(base, chatui, "second", "admin");
    expect(
      (await api(base, boss, "PATCH", `/api/admin/users/${second.userId}`, { status: "disabled" }))
        .status,
    ).toBe(200);
    expect(
      (await api(base, boss, "PATCH", `/api/admin/users/${boss.userId}`, { role: "user" })).status,
    ).toBe(409);
  });
});

describe("accounts", () => {
  it("creating a user, setting a password (sessions revoked) and deleting the account", async () => {
    const { base, chatui, dataDir } = await serve();
    const boss = await signIn(base, chatui, "boss", "admin");
    const created = await api(base, boss, "POST", "/api/admin/users", {
      username: "Newbie",
      password: TEST_PASSWORD,
      role: "user",
    });
    expect(created.status).toBe(201);
    const id = created.json?.id as string;
    const newbie = await signIn(base, chatui, "newbie");
    expect(newbie.userId).toBe(id);
    expect(
      (
        await api(base, boss, "POST", `/api/admin/users/${id}/password`, {
          password: SECRET_PASSWORD,
        })
      ).status,
    ).toBe(200);
    expect((await api(base, newbie, "GET", "/api/conversations")).status).toBe(401);
    const wrong = await api(base, boss, "DELETE", `/api/admin/users/${id}`, {
      confirmUsername: "nope",
    });
    expect(wrong.status).toBe(400);
    expect(
      (await api(base, boss, "DELETE", `/api/admin/users/${id}`, { confirmUsername: "newbie" }))
        .status,
    ).toBe(200);
    expect(existsSync(path.join(dataDir, id))).toBe(false);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: TEST_ORIGIN },
      body: JSON.stringify({ username: "newbie", password: SECRET_PASSWORD }),
    });
    expect(login.status).toBe(401);
  });

  it("INV-61: deleting an account mid-generation cancels it and nothing recreates the directory", async () => {
    const { base, chatui, dataDir } = await serve();
    const boss = await signIn(base, chatui, "boss", "admin");
    const victim = await signIn(base, chatui, "victim");
    const start = await api(base, victim, "POST", "/api/generations", {
      providerId: "local",
      model: MOCK_MODELS.slow,
      content: "long one",
      operationKey: crypto.randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    expect(start.status).toBe(202);
    const generationId = start.json?.generationId as string;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const removed = await api(base, boss, "DELETE", `/api/admin/users/${victim.userId}`, {
      confirmUsername: "victim",
    });
    expect(removed.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(path.join(dataDir, victim.userId))).toBe(false);
    expect(chatui.services.generations.activeCountForUser(victim.userId)).toBe(0);
    expect((await api(base, boss, "GET", `/api/generations/${generationId}`)).status).toBe(404);
    // Late writers of every store fail instead of recreating the account.
    await expect(chatui.services.conversations.create(victim.userId)).rejects.toThrow();
    await expect(
      chatui.services.memory.create(victim.userId, { name: "Late", body: "late" }),
    ).rejects.toThrow();
    expect(existsSync(path.join(dataDir, victim.userId))).toBe(false);
  });

  it("INV-61: a crash after `closing` resumes and completes the closure at startup", async () => {
    const dataDir = tempDataDir();
    const first = await serve(dataDir);
    await signIn(first.base, first.chatui, "boss", "admin");
    const victim = await signIn(first.base, first.chatui, "victim");
    await first.chatui.services.users.update(victim.userId, { status: "closing" });
    // "Crash": stop without finishing, then start again on the same data.
    const entry = servers.pop();
    await entry?.chatui.shutdown();
    entry?.server.closeAllConnections();
    entry?.server.close();
    await serve(dataDir);
    expect(existsSync(path.join(dataDir, victim.userId))).toBe(false);
    expect(readdirSync(path.join(dataDir, "_system", "deleting"))).toEqual([]);
  });
});

describe("providers (INV-19, INV-25)", () => {
  it("SSRF validation on create, edit and test; secrets are write-only", async () => {
    const { base, chatui } = await serve();
    const boss = await signIn(base, chatui, "boss", "admin");
    const entry = {
      id: "extra",
      name: "Extra",
      kind: "openai-compatible",
      baseUrl: llama.url,
      apiKey: SECRET_KEY,
      capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
    };
    for (const baseUrl of [
      "http://169.254.169.254",
      "http://evil.example:8080",
      "file:///etc/passwd",
    ]) {
      const res = await api(base, boss, "POST", "/api/admin/providers", { ...entry, baseUrl });
      expect(res.status, baseUrl).toBe(400);
      expect(res.text).toMatch(/ENDPOINT_NOT_ALLOWED|VALIDATION/);
    }
    const created = await api(base, boss, "POST", "/api/admin/providers", entry);
    expect(created.status).toBe(201);
    expect(created.json?.hasApiKey).toBe(true);
    expect(created.text).not.toContain(SECRET_KEY);
    const edit = await api(base, boss, "PATCH", "/api/admin/providers/extra", {
      baseUrl: "http://evil.example",
    });
    expect(edit.status).toBe(400);
    const test = await api(base, boss, "POST", "/api/admin/providers/extra/test");
    expect(test.json).toMatchObject({ ok: true });
    const cleared = await api(base, boss, "PATCH", "/api/admin/providers/extra", {
      clearApiKey: true,
    });
    expect(cleared.json?.hasApiKey).toBe(false);
    // The registry reloaded in-process: the new provider serves models.
    const models = await api(base, boss, "GET", "/api/models");
    expect(models.text).toContain('"extra"');
    expect((await api(base, boss, "DELETE", "/api/admin/providers/extra")).status).toBe(200);
  });

  it("secret exposure sweep: no response, header or log line contains a configured secret", async () => {
    const dataDir = tempDataDir();
    writeProviders(dataDir, [localProvider(llama.url, { apiKey: SECRET_KEY })]);
    const { base, chatui, logs } = await serve(dataDir);
    const boss = await signIn(base, chatui, "boss", "admin");
    const user = await signIn(base, chatui, "plain");
    await api(base, boss, "POST", "/api/admin/users", {
      username: "pwuser",
      password: SECRET_PASSWORD,
      role: "user",
    });
    const seen: string[] = [];
    // A key entered, rotated and used through the admin API (audit, logs, responses).
    const SECOND_KEY = "sk-SENTINEL-ROTATED-KEY-77b0";
    for (const res of [
      await api(base, boss, "POST", "/api/admin/providers", {
        id: "swept",
        name: "Swept",
        kind: "openai-compatible",
        baseUrl: llama.url,
        apiKey: SECRET_KEY,
        capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
      }),
      await api(base, boss, "PATCH", "/api/admin/providers/swept", { apiKey: SECOND_KEY }),
      await api(base, boss, "POST", "/api/admin/providers/swept/test"),
    ]) {
      expect(res.status).toBeLessThan(300);
      seen.push(res.text, JSON.stringify([...res.headers.entries()]));
    }
    for (const route of apiRoutes) {
      if (route.method !== "get" || route.kind === "sse" || route.path.includes(":")) continue;
      for (const who of route.auth === "admin" ? [boss] : [user, boss]) {
        const res = await api(base, who, "GET", route.path);
        seen.push(res.text, JSON.stringify([...res.headers.entries()]));
      }
    }
    const lines = JSON.stringify(logs.lines());
    for (const sentinel of [SECRET_KEY, SECRET_PASSWORD, SECOND_KEY]) {
      expect(seen.join("\n")).not.toContain(sentinel);
      expect(lines).not.toContain(sentinel);
    }
    const audit = readFileSync(
      path.join(dataDir, "_system", "audit", `${new Date().toISOString().slice(0, 7)}.jsonl`),
      "utf8",
    );
    expect(audit).toContain('"user.create"');
    expect(audit).toContain('"provider.create"');
    expect(audit).toContain('"provider.update"');
    for (const sentinel of [SECRET_PASSWORD, SECRET_KEY, SECOND_KEY])
      expect(audit).not.toContain(sentinel);
  });
});

describe("models and instance settings", () => {
  it("hidden models exist only for admins; sampling and prompts are validated", async () => {
    const { base, chatui } = await serve();
    const boss = await signIn(base, chatui, "boss", "admin");
    const user = await signIn(base, chatui, "plain");
    const hide = await api(base, boss, "PUT", "/api/admin/models", {
      providerId: "local",
      modelId: MOCK_MODELS.chat,
      hidden: true,
      sampling: {},
      systemPrompt: null,
    });
    expect(hide.status).toBe(200);
    expect((await api(base, user, "GET", "/api/models")).text).not.toContain(
      `"${MOCK_MODELS.chat}"`,
    );
    expect((await api(base, boss, "GET", "/api/models")).text).toContain(`"${MOCK_MODELS.chat}"`);
    const send = (who: TestSession) =>
      api(base, who, "POST", "/api/generations", {
        providerId: "local",
        model: MOCK_MODELS.chat,
        content: "hello",
        operationKey: crypto.randomUUID(),
        operationIssuedAt: new Date().toISOString(),
      });
    const blocked = await send(user);
    expect(blocked.status).toBe(400);
    expect(blocked.text).toContain('"MODEL_NOT_FOUND"');
    expect((await send(boss)).status).toBe(202);
    for (const bad of [
      { sampling: { temperature: 9 }, systemPrompt: null },
      { sampling: {}, systemPrompt: "Hello {{password}}" },
    ]) {
      const res = await api(base, boss, "PUT", "/api/admin/models", {
        providerId: "local",
        modelId: MOCK_MODELS.slow,
        hidden: false,
        ...bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("per-model system prompt and sampling reach the provider; {{time}} never enters the system prefix", async () => {
    let clock = new Date("2026-10-30T09:00:00.000Z");
    const { base, chatui } = await serve(tempDataDir(), () => clock);
    const boss = await signIn(base, chatui, "boss", "admin");
    await api(base, boss, "PATCH", "/api/admin/settings", { timeZone: "Europe/London" });
    await api(base, boss, "PUT", "/api/admin/models", {
      providerId: "local",
      modelId: MOCK_MODELS.chat,
      hidden: false,
      sampling: { temperature: 0.3, topK: 20 },
      systemPrompt: "You help {{username}}. Today is {{date}} ({{timezone}}). It is {{time}}.",
    });
    const sendTurn = async (conversationId?: string) => {
      const res = await api(base, boss, "POST", "/api/generations", {
        ...(conversationId ? { conversationId } : {}),
        providerId: "local",
        model: MOCK_MODELS.chat,
        content: "{{username}} literal",
        operationKey: crypto.randomUUID(),
        operationIssuedAt: clock.toISOString(),
      });
      const started = res.json as { conversationId: string; generationId: string };
      await (
        await fetch(`${base}/api/generations/${started.generationId}/stream`, {
          headers: boss.headers(),
        })
      ).text();
      return started.conversationId;
    };
    const chats = () =>
      llama.requests
        .filter((r) => r.path === "/v1/chat/completions")
        .map(
          (r) =>
            r.body as {
              messages: { role: string; content: string }[];
              temperature?: number;
              top_k?: number;
            },
        );
    const before = chats().length;
    const conversation = await sendTurn();
    clock = new Date("2026-10-30T09:01:00.000Z");
    await sendTurn(conversation);
    const [first, second] = chats().slice(before);
    expect(first?.temperature).toBe(0.3);
    expect(first?.top_k).toBe(20);
    const system = first?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("You help boss. Today is 2026-10-30 (Europe/London).");
    expect(system?.content).not.toMatch(/09:0\d|10:0\d/);
    // The system prefix is identical a minute later; the time sits in the newest user turn.
    expect(second?.messages[0]).toEqual(system);
    expect(first?.messages.at(-1)?.content).toContain("Current time: 09:00 (Europe/London)");
    expect(second?.messages.at(-1)?.content).toContain("Current time: 09:01 (Europe/London)");
    // User text is never template-expanded.
    expect(second?.messages.at(-1)?.content).toContain("{{username}} literal");
  });

  it("registration mode set by an admin overrides the environment", async () => {
    const { base, chatui } = await serve();
    const boss = await signIn(base, chatui, "boss", "admin");
    const register = () =>
      fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: TEST_ORIGIN },
        body: JSON.stringify({
          username: `new${String(Math.random()).slice(2, 8)}`,
          password: TEST_PASSWORD,
        }),
      });
    expect((await register()).status).toBe(403);
    expect(
      (await api(base, boss, "PATCH", "/api/admin/settings", { registrationMode: "open" })).status,
    ).toBe(200);
    expect((await register()).status).toBe(201);
  });

  it("settings survive a restart (persisted admin edits win)", async () => {
    const dataDir = tempDataDir();
    const one = await serve(dataDir);
    const boss = await signIn(one.base, one.chatui, "boss", "admin");
    await api(one.base, boss, "PATCH", "/api/admin/settings", { notice: "Maintenance at noon" });
    writeFileSync(path.join(dataDir, "marker"), "");
    const two = await serve(dataDir);
    const again = await signIn(two.base, two.chatui, "boss", "admin");
    expect((await api(two.base, again, "GET", "/api/instance")).json).toMatchObject({
      notice: "Maintenance at noon",
    });
  });
});

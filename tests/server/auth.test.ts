import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PasswordHasher } from "../../server/auth/passwords.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { readSse } from "../support/sse-client.ts";
import {
  authConfig,
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  testHasher,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestAppOptions,
  type TestSession,
} from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ chunkDelayMs: 40, slowChunks: 25 });
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

interface Run {
  base: string;
  chatui: ChatUiApp;
  dataDir: string;
  seen: string[];
}

async function start(
  options: TestAppOptions & { auth?: Parameters<typeof authConfig>[0]; dataDir?: string } = {},
): Promise<Run> {
  const dataDir = options.dataDir ?? tempDataDir();
  const { auth, ...rest } = options;
  const { chatui } = testApp({
    ...rest,
    config: {
      dataDir,
      auth: authConfig(auth),
      provider: providerConfig({ baseUrl: llama.url, maxActiveGenerations: 8 }),
      ...options.config,
    },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    chatui,
    dataDir,
    seen: [],
  };
}

async function call(
  run: Run,
  method: string,
  url: string,
  options: { session?: TestSession; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${run.base}${url}`, {
    method,
    headers: {
      ...options.session?.headers(method !== "GET"),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  run.seen.push(text, res.headers.get("set-cookie") ?? "");
  let body: Record<string, unknown> & { error?: { code: string } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }
  return { status: res.status, body, headers: res.headers };
}

function login(
  run: Run,
  username: string,
  password = TEST_PASSWORD,
  headers: Record<string, string> = {},
) {
  return call(run, "POST", "/api/auth/login", {
    body: { username, password },
    headers: { Origin: TEST_ORIGIN, ...headers },
  });
}

const send = (
  run: Run,
  session: TestSession,
  content: string,
  extra: Record<string, unknown> = {},
) =>
  call(run, "POST", "/api/generations", {
    session,
    body: {
      providerId: "local",
      model: MOCK_MODELS.slow,
      content,
      operationKey: randomUUID(),
      operationIssuedAt: new Date().toISOString(),
      ...extra,
    },
  });

describe("INV-15: cross-user isolation", () => {
  it("another user's conversations, generations and operations are indistinguishable from missing", async () => {
    const run = await start();
    const alice = await signIn(run.base, run.chatui, "alice");
    const bob = await signIn(run.base, run.chatui, "bob");
    const sent = await send(run, alice, "alice secret");
    const { conversationId, generationId } = sent.body as Record<string, string>;
    const opKey = randomUUID();
    const withKey = await send(run, alice, "keyed", {
      operationKey: opKey,
      conversationId: undefined,
    });
    await run.chatui.services.generations.settled(generationId ?? "");
    await run.chatui.services.generations.settled(
      (withKey.body.generationId as string | undefined) ?? "",
    );

    const cid = conversationId ?? "";
    const gid = generationId ?? "";
    for (const [method, url, body] of [
      ["GET", `/api/conversations/${cid}`, undefined],
      ["PATCH", `/api/conversations/${cid}`, { title: "pwned" }],
      ["DELETE", `/api/conversations/${cid}`, undefined],
      ["GET", `/api/generations/${gid}`, undefined],
      ["POST", `/api/generations/${gid}/cancel`, undefined],
      ["GET", `/api/operations/${opKey}`, undefined],
    ] as const) {
      const res = await call(run, method, url, { session: bob, body });
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    const stream = await readSse(`${run.base}/api/generations/${gid}/stream`, {
      headers: bob.headers(),
    });
    expect(stream.status).toBe(404);
    const sendInto = await send(run, bob, "inject", { conversationId: cid });
    expect(sendInto.status).toBe(404);
    expect(
      (await call(run, "GET", "/api/conversations", { session: bob })).body.conversations,
    ).toEqual([]);
    const aliceView = await call(run, "GET", `/api/conversations/${cid}`, { session: alice });
    expect(aliceView.status).toBe(200);
    expect(JSON.stringify(aliceView.body)).toContain("alice secret");
    // Storage is per user directory.
    expect(readdirSync(path.join(run.dataDir, bob.userId))).not.toContain("chats");
  });
});

describe("sessions (contracts §6)", () => {
  it("logout invalidates the session server-side and clears the cookie", async () => {
    const run = await start();
    const alice = await signIn(run.base, run.chatui);
    const out = await call(run, "POST", "/api/auth/logout", { session: alice });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/chatui_session=;/);
    expect((await call(run, "GET", "/api/conversations", { session: alice })).status).toBe(401);
    expect((await call(run, "GET", "/api/auth/session", { session: alice })).body.user).toBeNull();
  });

  it("login rotates the session (fixation): the presented session stops working", async () => {
    const run = await start();
    const first = await signIn(run.base, run.chatui);
    const again = await login(run, "alice", TEST_PASSWORD, { Cookie: first.cookie });
    expect(again.status).toBe(200);
    const newCookie = (again.headers.get("set-cookie") ?? "").split(";")[0];
    expect(newCookie).not.toBe(first.cookie);
    expect((await call(run, "GET", "/api/conversations", { session: first })).status).toBe(401);
    expect(
      (await call(run, "GET", "/api/conversations", { headers: { Cookie: newCookie ?? "" } }))
        .status,
    ).toBe(200);
  });

  it("wrong passwords and unknown users get the same answer", async () => {
    const run = await start();
    await signIn(run.base, run.chatui);
    const wrong = await login(run, "alice", "not the password");
    const unknown = await login(run, "mallory", "whatever-password");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("absolute and idle expiry end the session", async () => {
    let clock = Date.now();
    const run = await start({
      now: () => new Date(clock),
      auth: { sessionAbsoluteTtlMs: 10 * 60_000, sessionIdleTtlMs: 3 * 60_000 },
    });
    const alice = await signIn(run.base, run.chatui);
    clock += 2 * 60_000;
    expect((await call(run, "GET", "/api/conversations", { session: alice })).status).toBe(200); // touch
    clock += 2 * 60_000;
    expect((await call(run, "GET", "/api/conversations", { session: alice })).status).toBe(200); // still idle-fresh
    clock += 4 * 60_000;
    expect((await call(run, "GET", "/api/conversations", { session: alice })).status).toBe(401); // idle
    const bob = await signIn(run.base, run.chatui, "bob");
    for (let i = 0; i < 6; i++) {
      clock += 2 * 60_000; // keep idle-fresh, pass the absolute limit
      await call(run, "GET", "/api/conversations", { session: bob });
    }
    expect((await call(run, "GET", "/api/conversations", { session: bob })).status).toBe(401);
  });

  it("INV-17: disabling a user or changing their role revokes sessions on the next request", async () => {
    const run = await start();
    const alice = await signIn(run.base, run.chatui);
    await run.chatui.services.users.update(alice.userId, { status: "disabled" });
    expect((await call(run, "GET", "/api/conversations", { session: alice })).status).toBe(401);
    expect((await login(run, "alice")).status).toBe(401);
    await run.chatui.services.users.update(alice.userId, { status: "active" });
    const again = await signIn(run.base, run.chatui);
    await run.chatui.services.users.update(alice.userId, { role: "admin" });
    expect((await call(run, "GET", "/api/conversations", { session: again })).status).toBe(401);
    const admin = await signIn(run.base, run.chatui);
    expect(
      (await call(run, "GET", "/api/auth/session", { session: admin })).body.user,
    ).toMatchObject({ role: "admin" });
  });

  it("password change requires the current password, revokes every session and needs a new login", async () => {
    const run = await start();
    const tabA = await signIn(run.base, run.chatui);
    const tabB = await signIn(run.base, run.chatui);
    const bad = await call(run, "POST", "/api/auth/password", {
      session: tabB,
      body: { currentPassword: "nope-nope-nope", newPassword: "another long password" },
    });
    expect(bad.status).toBe(400);
    const ok = await call(run, "POST", "/api/auth/password", {
      session: tabB,
      body: { currentPassword: TEST_PASSWORD, newPassword: "another long password" },
    });
    expect(ok.status).toBe(200);
    for (const s of [tabA, tabB])
      expect((await call(run, "GET", "/api/conversations", { session: s })).status).toBe(401);
    expect((await login(run, "alice")).status).toBe(401);
    expect((await login(run, "alice", "another long password")).status).toBe(200);
  });

  it("guessing the current password is rate limited like login", async () => {
    const run = await start();
    const session = await signIn(run.base, run.chatui);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push(
        (
          await call(run, "POST", "/api/auth/password", {
            session,
            body: {
              currentPassword: `wrong guess ${String(i)}`,
              newPassword: "another long password",
            },
          })
        ).status,
      );
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("cookie flags for an http://localhost origin: HttpOnly, SameSite=Lax, not Secure", async () => {
    const run = await start();
    await run.chatui.services.users.create({
      username: "carol",
      passwordHash: await testHasher().hash(TEST_PASSWORD),
      role: "user",
    });
    const res = await login(run, "carol");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^chatui_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/);
  });

  it("cookie flags for an https origin: __Host- prefix and Secure; X-Forwarded-Proto is never trusted", async () => {
    const secure = await start({
      auth: { publicOrigin: "https://chat.example.com", secureCookies: true },
    });
    await secure.chatui.services.users.create({
      username: "dave",
      passwordHash: await testHasher().hash(TEST_PASSWORD),
      role: "user",
    });
    const res = await call(secure, "POST", "/api/auth/login", {
      body: { username: "dave", password: TEST_PASSWORD },
      headers: { Origin: "https://chat.example.com" },
    });
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-chatui_session=.*Secure/);
    const plain = await start();
    await plain.chatui.services.users.create({
      username: "erin",
      passwordHash: await testHasher().hash(TEST_PASSWORD),
      role: "user",
    });
    const spoofed = await login(plain, "erin", TEST_PASSWORD, { "X-Forwarded-Proto": "https" });
    expect(spoofed.headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("no response ever contains a password hash or the session token hash", async () => {
    const run = await start();
    const alice = await signIn(run.base, run.chatui);
    await call(run, "GET", "/api/auth/session", { session: alice });
    await call(run, "GET", "/api/preferences", { session: alice });
    await login(run, "alice");
    const all = run.seen.join("\n");
    expect(all).not.toMatch(/\$argon2id\$/);
    expect(all).not.toContain("passwordHash");
    const sessionFiles = readdirSync(path.join(run.dataDir, "_system", "sessions"));
    for (const file of sessionFiles) expect(all).not.toContain(file.replace(".json", ""));
  });

  it("sessions store only the token hash", async () => {
    const run = await start();
    const alice = await signIn(run.base, run.chatui);
    const token = alice.cookie.split("=")[1] ?? "";
    const dir = path.join(run.dataDir, "_system", "sessions");
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes(token))).toBe(false);
    for (const file of files)
      expect(readFileSync(path.join(dir, file), "utf8")).not.toContain(token);
  });
});

describe("registration", () => {
  it("is closed by default once an account exists", async () => {
    const run = await start();
    await signIn(run.base, run.chatui);
    const res = await call(run, "POST", "/api/auth/register", {
      body: { username: "zed", password: TEST_PASSWORD },
      headers: { Origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("REGISTRATION_CLOSED");
  });

  it("when open, creates a user and signs them in; usernames are unique case-insensitively under concurrency", async () => {
    const run = await start({ auth: { registrationMode: "open" } });
    const results = await Promise.all(
      ["Zed", "zed", "ZED", "zEd", "zeD"].map((username) =>
        call(run, "POST", "/api/auth/register", {
          body: { username, password: TEST_PASSWORD },
          headers: { Origin: TEST_ORIGIN, "X-Forwarded-For": randomUUID() },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const created = results.find((r) => r.status === 201);
    // The first account on an empty instance is the admin.
    expect(created?.body.user).toMatchObject({ username: "zed", role: "admin" });
    expect(created?.headers.get("set-cookie")).toMatch(/chatui_session=/);
  });

  it("first run: the first registration creates the admin, then registration is closed", async () => {
    const run = await start();
    const register = (username: string) =>
      call(run, "POST", "/api/auth/register", {
        body: { username, password: TEST_PASSWORD },
        headers: { Origin: TEST_ORIGIN, "X-Forwarded-For": randomUUID() },
      });
    const session = await call(run, "GET", "/api/auth/session");
    expect(session.body.registrationOpen).toBe(true);
    const first = await register("boss");
    expect(first.status).toBe(201);
    expect(first.body.user).toMatchObject({ username: "boss", role: "admin" });
    const second = await register("late");
    expect(second.status).toBe(403);
    expect(second.body.error?.code).toBe("REGISTRATION_CLOSED");
    const after = await call(run, "GET", "/api/auth/session");
    expect(after.body.registrationOpen).toBe(false);
  });

  it("first run: concurrent registrations create exactly one account", async () => {
    const run = await start();
    const results = await Promise.all(
      ["one", "two", "three", "four"].map((username) =>
        call(run, "POST", "/api/auth/register", {
          body: { username, password: TEST_PASSWORD },
          headers: { Origin: TEST_ORIGIN, "X-Forwarded-For": randomUUID() },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(3);
  });

  it("rejects invalid usernames and short passwords", async () => {
    const run = await start({ auth: { registrationMode: "open" } });
    for (const body of [
      { username: "ab", password: TEST_PASSWORD },
      { username: "no spaces", password: TEST_PASSWORD },
      { username: "fine", password: "short" },
    ]) {
      const res = await call(run, "POST", "/api/auth/register", {
        body,
        headers: { Origin: TEST_ORIGIN },
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("INV-62: limits", () => {
  it("login attempts are limited per address and per username with Retry-After", async () => {
    const run = await start();
    await signIn(run.base, run.chatui);
    let limited;
    for (let i = 0; i < 12; i++) limited = await login(run, "alice", "wrong-password!");
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
    // Forwarded headers are ignored without TRUST_PROXY: still the same address.
    const spoof = await login(run, "someone-else", "wrong-password!", {
      "X-Forwarded-For": "10.9.8.7",
    });
    expect(spoof.status).toBe(429);
  });

  it("a full password-hashing queue is rejected with RATE_LIMITED instead of queueing without bound", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    /** A hasher whose work finishes only when the test releases it. */
    class GatedHasher extends PasswordHasher {
      override verify(): Promise<boolean> {
        return this.slot(() => gate.then(() => false));
      }
    }
    const hasher = new GatedHasher({ concurrency: 1, queue: 1 });
    const run = await start({ hasher });
    const inFlight = [login(run, "u1", "pw-pw-pw-pw"), login(run, "u2", "pw-pw-pw-pw")];
    await vi.waitFor(() => {
      expect(hasher.active + hasher.queued).toBe(2);
    });
    const rejected = await login(run, "u3", "pw-pw-pw-pw");
    expect(rejected.status).toBe(429);
    expect(rejected.body.error?.code).toBe("RATE_LIMITED");
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
    release();
    expect((await Promise.all(inFlight)).map((r) => r.status)).toEqual([401, 401]);
  });

  it("per-user generation cap and per-user SSE connection cap", async () => {
    const run = await start({ auth: { maxActiveGenerationsPerUser: 1, maxSsePerUser: 1 } });
    const alice = await signIn(run.base, run.chatui);
    const bob = await signIn(run.base, run.chatui, "bob");
    const first = await send(run, alice, "one");
    expect(first.status).toBe(202);
    const second = await send(run, alice, "two");
    expect(second.status).toBe(429);
    expect(second.body.error?.code).toBe("RATE_LIMITED");
    expect((await send(run, bob, "bob is fine")).status).toBe(202);
    const url = `${run.base}/api/generations/${first.body.generationId as string}/stream`;
    const controller = new AbortController();
    const open = readSse(url, { headers: alice.headers(), signal: controller.signal });
    await vi.waitFor(() => {
      expect(run.chatui.services.sseConnections.size).toBe(1);
    });
    const extra = await fetch(url, { headers: alice.headers() });
    expect(extra.status).toBe(429);
    await extra.text();
    controller.abort();
    await open.catch(() => undefined);
  });
});

describe("session-bound streams (contracts §5)", () => {
  for (const [name, end] of [
    ["logout", (run: Run, s: TestSession) => call(run, "POST", "/api/auth/logout", { session: s })],
    [
      "password change",
      (run: Run, s: TestSession) =>
        call(run, "POST", "/api/auth/password", {
          session: s,
          body: { currentPassword: TEST_PASSWORD, newPassword: "a different password" },
        }),
    ],
  ] as const) {
    it(`an open stream closes on ${name} while the generation continues`, async () => {
      const run = await start();
      const alice = await signIn(run.base, run.chatui);
      const sent = await send(run, alice, "keep going");
      const gid = sent.body.generationId as string;
      const stream = readSse(`${run.base}/api/generations/${gid}/stream`, {
        headers: alice.headers(),
      });
      await vi.waitFor(() => {
        expect(run.chatui.services.sseConnections.size).toBe(1);
      });
      await end(run, alice);
      const result = await stream;
      expect(result.frames.some((f) => f.event === "terminal")).toBe(false);
      expect(run.chatui.services.sseConnections.size).toBe(0);
      await run.chatui.services.generations.settled(gid);
      expect(run.chatui.services.generations.snapshot(gid).state).toBe("completed");
    });
  }

  it("an open stream closes when its session expires (checked at heartbeats)", async () => {
    let clock = Date.now();
    const run = await start({
      now: () => new Date(clock),
      sse: { heartbeatMs: 25 },
      auth: { sessionIdleTtlMs: 60_000 },
    });
    const alice = await signIn(run.base, run.chatui);
    const sent = await send(run, alice, "expire me");
    const gid = sent.body.generationId as string;
    const stream = readSse(`${run.base}/api/generations/${gid}/stream`, {
      headers: alice.headers(),
    });
    await vi.waitFor(() => {
      expect(run.chatui.services.sseConnections.size).toBe(1);
    });
    clock += 5 * 60_000;
    const result = await stream;
    expect(result.frames.some((f) => f.event === "terminal")).toBe(false);
    await run.chatui.services.generations.settled(gid);
    expect(run.chatui.services.generations.snapshot(gid).state).toBe("completed");
  });
});

describe("INV-59: account changes and stale tokens", () => {
  it("two tabs, same user: a login in one rotates the session; the other recovers with one refetch and retry", async () => {
    const run = await start();
    const tabA = await signIn(run.base, run.chatui);
    const tabB = await login(run, "alice", TEST_PASSWORD, { Cookie: tabA.cookie });
    const sharedCookie = (tabB.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // Tab A still holds the old CSRF token; the browser now sends the new cookie.
    const stale = await call(run, "POST", "/api/conversations", {
      body: {},
      headers: {
        Cookie: sharedCookie,
        "X-CSRF-Token": tabA.csrfToken,
        "X-Expected-User": tabA.userId,
      },
    });
    expect(stale.body.error?.code).toBe("CSRF_INVALID");
    const refreshed = await call(run, "GET", "/api/auth/session", {
      headers: { Cookie: sharedCookie },
    });
    expect((refreshed.body.user as { id: string }).id).toBe(tabA.userId);
    const retry = await call(run, "POST", "/api/conversations", {
      body: {},
      headers: {
        Cookie: sharedCookie,
        "X-CSRF-Token": refreshed.body.csrfToken as string,
        "X-Expected-User": tabA.userId,
      },
    });
    expect(retry.status).toBe(201);
  });

  it("a mutation carrying a stale X-Expected-User is SESSION_CHANGED with no mutation", async () => {
    const run = await start();
    const alice = await signIn(run.base, run.chatui);
    const bob = await signIn(run.base, run.chatui, "bob");
    const res = await call(run, "POST", "/api/conversations", {
      body: {},
      headers: {
        Cookie: bob.cookie,
        "X-CSRF-Token": bob.csrfToken,
        "X-Expected-User": alice.userId,
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("SESSION_CHANGED");
    expect(
      (await call(run, "GET", "/api/conversations", { session: bob })).body.conversations,
    ).toEqual([]);
  });
});

describe("fresh volume", () => {
  it("never reads or writes a legacy pre-auth demo directory (no user.json)", async () => {
    const dataDir = tempDataDir();
    const legacy = path.join(dataDir, "5f0c6a3e-9d0b-4c1e-8f2a-3b6d7e8f9a01");
    mkdirSync(path.join(legacy, "chats"), { recursive: true });
    const demoFile = path.join(legacy, "chats", "0b7e7c2a-1111-4a1a-8a1a-111111111111.md");
    writeFileSync(demoFile, "---\nformatVersion: 1\n");
    const run = await start({ dataDir });
    const alice = await signIn(run.base, run.chatui);
    expect(alice.userId).not.toBe("5f0c6a3e-9d0b-4c1e-8f2a-3b6d7e8f9a01");
    expect(readdirSync(legacy)).toEqual(["chats"]);
    expect(readFileSync(demoFile, "utf8")).toBe("---\nformatVersion: 1\n");
    expect(
      (await call(run, "GET", "/api/conversations", { session: alice })).body.conversations,
    ).toEqual([]);
  });
});

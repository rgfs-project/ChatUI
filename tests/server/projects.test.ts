import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { providerConfig, signIn, tempDataDir, testApp, type TestSession } from "./helpers.ts";

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
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function serve() {
  const { chatui } = testApp({
    config: { dataDir: tempDataDir(), provider: providerConfig({ baseUrl: llama.url }) },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, chatui };
}

interface Prefs {
  projects: { id: string; name: string }[];
  chatProjects: Record<string, string>;
  pins: string[];
  error?: { code: string };
  conversationId?: string;
  generationId?: string;
}

async function api(base: string, who: TestSession, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...who.headers(method !== "GET"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Prefs };
}

async function chat(base: string, who: TestSession, content: string, extra = {}) {
  const res = await api(base, who, "POST", "/api/generations", {
    providerId: "local",
    model: MOCK_MODELS.chat,
    content,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
    ...extra,
  });
  await (
    await fetch(`${base}/api/generations/${res.json.generationId ?? ""}/stream`, {
      headers: who.headers(),
    })
  ).text();
  return res.json.conversationId ?? "";
}

describe("projects (Phase 13g)", () => {
  it("create, rename, move chats in and out, delete; names unique; owner only", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const created = await api(base, alice, "POST", "/api/projects", { name: "  Trip   to Rome " });
    expect(created.status).toBe(201);
    const [project] = created.json.projects;
    expect(project?.name).toBe("Trip to Rome");
    const id = project?.id ?? "";
    expect((await api(base, alice, "POST", "/api/projects", { name: "trip TO rome" })).status).toBe(
      409,
    );
    expect((await api(base, alice, "POST", "/api/projects", { name: "   " })).status).toBe(400);
    // Line breaks collapse into one line.
    const folded = await api(base, alice, "POST", "/api/projects", { name: "a\nb" });
    expect(folded.json.projects.at(-1)?.name).toBe("a b");
    await api(base, alice, "DELETE", `/api/projects/${folded.json.projects.at(-1)?.id ?? ""}`);
    const renamed = await api(base, alice, "PATCH", `/api/projects/${id}`, { name: "Rome" });
    expect(renamed.json.projects[0]?.name).toBe("Rome");

    const conversation = await chat(base, alice, "plan it");
    const moved = await api(base, alice, "PUT", `/api/conversations/${conversation}/project`, {
      projectId: id,
    });
    expect(moved.json.chatProjects).toEqual({ [conversation]: id });
    // Other accounts can't see or move into it.
    expect(
      (
        await api(base, bob, "PUT", `/api/conversations/${conversation}/project`, {
          projectId: null,
        })
      ).status,
    ).toBe(404);
    expect((await api(base, bob, "GET", "/api/preferences")).json.projects).toEqual([]);
    // PATCH /api/preferences can't change projects.
    expect((await api(base, alice, "PATCH", "/api/preferences", { projects: [] })).status).toBe(
      400,
    );

    const out = await api(base, alice, "PUT", `/api/conversations/${conversation}/project`, {
      projectId: null,
    });
    expect(out.json.chatProjects).toEqual({});
    await api(base, alice, "PUT", `/api/conversations/${conversation}/project`, { projectId: id });
    const deleted = await api(base, alice, "DELETE", `/api/projects/${id}`);
    expect(deleted.json).toMatchObject({ projects: [], chatProjects: {} });
    // The chat itself stays.
    expect((await api(base, alice, "GET", `/api/conversations/${conversation}`)).status).toBe(200);
  });

  it("deleting a chat removes its place; temporary chats can't be moved", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const id =
      (await api(base, alice, "POST", "/api/projects", { name: "Work" })).json.projects[0]?.id ??
      "";
    const conversation = await chat(base, alice, "keep");
    await api(base, alice, "PUT", `/api/conversations/${conversation}/project`, { projectId: id });
    await api(base, alice, "DELETE", `/api/conversations/${conversation}`);
    expect((await api(base, alice, "GET", "/api/preferences")).json.chatProjects).toEqual({});
    const temporary = await chat(base, alice, "ghost", { temporary: true });
    expect(
      (await api(base, alice, "PUT", `/api/conversations/${temporary}/project`, { projectId: id }))
        .status,
    ).toBe(400);
  });
});

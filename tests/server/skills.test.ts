import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SkillDto } from "@shared/skills";
import type { ChatUiApp } from "../../server/create-app.ts";
import { expandSkill } from "../../server/chat/skills.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { readSse } from "../support/sse-client.ts";
import { providerConfig, signIn, testApp, type TestSession } from "./helpers.ts";

/** Skills (user request, Phase 10): storage, API and prompt expansion. */

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama();
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

async function start() {
  const { chatui } = testApp({ config: { provider: providerConfig({ baseUrl: llama.url }) } });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, chatui, alice: await signIn(base, chatui, "alice") };
}

function api(base: string, session: TestSession) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...session.headers(method !== "GET"),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return {
    list: async () => (await call("GET", "/api/skills")).body.skills as SkillDto[],
    create: (body: unknown) => call("POST", "/api/skills", body),
    update: (id: string, body: unknown) => call("PATCH", `/api/skills/${id}`, body),
    remove: (id: string) => call("DELETE", `/api/skills/${id}`),
    send: async (content: string) => {
      const res = await fetch(`${base}/api/generations`, {
        method: "POST",
        headers: { ...session.headers(true), "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "local",
          model: MOCK_MODELS.chat,
          content,
          operationKey: crypto.randomUUID(),
          operationIssuedAt: new Date().toISOString(),
        }),
      });
      const started = (await res.json()) as { generationId: string; conversationId: string };
      await readSse(`${base}/api/generations/${started.generationId}/stream`, {
        headers: session.headers(),
      });
      return started;
    },
  };
}

/** The user message content of the provider's last chat request. */
function lastPromptUser(): string {
  const body = llama.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body as
    { messages: { role: string; content: string }[] } | undefined;
  return body?.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
}

const SKILL = {
  name: "haiku",
  description: "Answer as a haiku",
  instructions: "Reply only with a 5-7-5 haiku.",
};

describe("skills API", () => {
  it("creates, lists, updates and deletes the signed-in user's skills", async () => {
    const { base, alice } = await start();
    const a = api(base, alice);
    const created = await a.create(SKILL);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...SKILL, enabled: true });
    const id = created.body.id as string;
    expect((await a.list()).map((s) => s.name)).toEqual(["haiku"]);
    const updated = await a.update(id, { enabled: false, description: "Off for now" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ enabled: false, description: "Off for now" });
    expect((await a.remove(id)).status).toBe(200);
    expect(await a.list()).toEqual([]);
    expect((await a.remove(id)).status).toBe(404);
  });

  it("rejects invalid, reserved and duplicate names and empty instructions", async () => {
    const { base, alice } = await start();
    const a = api(base, alice);
    for (const name of ["Has Caps", "with space", "-dash-first", "settings", "x".repeat(41)])
      expect((await a.create({ ...SKILL, name })).status, name).toBe(400);
    expect((await a.create({ ...SKILL, instructions: "   " })).status).toBe(400);
    expect((await a.create(SKILL)).status).toBe(201);
    expect((await a.create(SKILL)).body).toMatchObject({ error: { code: "CONFLICT" } });
    const other = await a.create({ ...SKILL, name: "other" });
    expect((await a.update(other.body.id as string, { name: "haiku" })).status).toBe(409);
  });

  it("is private: another user can neither see nor change them", async () => {
    const { base, chatui, alice } = await start();
    const created = await api(base, alice).create(SKILL);
    const bob = api(base, await signIn(base, chatui, "bob"));
    expect(await bob.list()).toEqual([]);
    expect((await bob.update(created.body.id as string, { enabled: false })).status).toBe(404);
    expect((await bob.remove(created.body.id as string)).status).toBe(404);
  });

  it("requires a session and a CSRF token", async () => {
    const { base, alice } = await start();
    expect((await fetch(`${base}/api/skills`)).status).toBe(401);
    const noCsrf = await fetch(`${base}/api/skills`, {
      method: "POST",
      headers: { Cookie: alice.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(SKILL),
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("skills in prompts", () => {
  it('"/name" puts the instructions in front of that message for the provider only', async () => {
    const { base, chatui, alice } = await start();
    const a = api(base, alice);
    await a.create(SKILL);
    const { conversationId } = await a.send("/haiku the sea at night");
    expect(lastPromptUser()).toBe(
      '<skill name="haiku">\nReply only with a 5-7-5 haiku.\n</skill>\n\nthe sea at night',
    );
    // The stored message keeps what the user typed.
    const conversation = await chatui.services.conversationDto(alice.userId, conversationId);
    expect(conversation.messages[0]?.content).toBe("/haiku the sea at night");
  });

  it("disabled or unknown skills are sent as typed", async () => {
    const { base, alice } = await start();
    const a = api(base, alice);
    const created = await a.create(SKILL);
    await a.update(created.body.id as string, { enabled: false });
    await a.send("/haiku the sea");
    expect(lastPromptUser()).toBe("/haiku the sea");
    await a.send("/nothing here");
    expect(lastPromptUser()).toBe("/nothing here");
  });
});

describe("expandSkill", () => {
  const skills = new Map<string, SkillDto>([
    [
      "haiku",
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "haiku",
        description: "",
        instructions: "Use {{username}} as-is.",
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
    ],
  ]);

  it("only a leading command counts; instructions are inserted once, never re-expanded", () => {
    expect(expandSkill("/haiku", skills)).toBe(
      '<skill name="haiku">\nUse {{username}} as-is.\n</skill>',
    );
    expect(expandSkill("tell me /haiku", skills)).toBe("tell me /haiku");
    expect(expandSkill("/haikus please", skills)).toBe("/haikus please");
    expect(expandSkill("/haiku\nline two", skills)).toBe(
      '<skill name="haiku">\nUse {{username}} as-is.\n</skill>\n\nline two',
    );
  });
});

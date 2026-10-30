import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import type { SendHooks } from "../../server/chat/send-service.ts";
import { parseConversation, serializeConversation } from "../../server/storage/markdown.ts";
import { calculate, CalcError, formatNumber } from "../../server/tools/calculate.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  localProvider,
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  writeProviders,
  type TestSession,
} from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4, toolDelayMs: 40 });
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
  options: { dataDir?: string; hooks?: SendHooks; tools?: boolean; contextTokens?: number } = {},
) {
  const dataDir = options.dataDir ?? tempDataDir();
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [
      localProvider(llama.url, {
        capabilities: { inputModalities: ["text"], reasoning: true, tools: options.tools ?? true },
        ...(options.contextTokens ? { contextTokens: options.contextTokens } : {}),
      }),
    ]);
  const { chatui } = testApp({
    config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
    ...(options.hooks ? { send: { hooks: options.hooks } } : {}),
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    chatui,
    dataDir,
  };
}

interface Proposal {
  id: string;
  tool: string;
  name: string;
  content: string | null;
  status: string;
  stale: boolean;
}

interface Json {
  [key: string]: unknown;
  error: { code: string; message: string };
  id: string;
  name: string;
  body: string;
  revision: string;
  omitted: boolean;
  status: string;
  stale: boolean;
  conversationId: string;
  generationId: string;
  memories: { id: string; name: string; body: string; revision: string; omitted: boolean }[];
  proposals: Proposal[];
  messages: { id: string; role: string; content: string; status: string; tools: string[] }[];
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
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

async function send(
  base: string,
  who: TestSession,
  content: string,
  conversationId?: string,
  model: string = MOCK_MODELS.tools,
) {
  const res = await api(base, who, "POST", "/api/generations", {
    ...(conversationId ? { conversationId } : {}),
    providerId: "local",
    model,
    content,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });
  expect(res.status).toBe(202);
  const stream = await (
    await fetch(`${base}/api/generations/${res.json.generationId}/stream`, {
      headers: who.headers(),
    })
  ).text();
  const conversation = (
    await api(base, who, "GET", `/api/conversations/${res.json.conversationId}`)
  ).json;
  return { id: res.json.conversationId, conversation, stream };
}

const reply = (c: Json) => c.messages.filter((m) => m.role === "assistant").at(-1);
const chatFile = (dataDir: string, userId: string, id: string) =>
  readFileSync(path.join(dataDir, userId, "chats", `${id}.md`), "utf8");
/** Chat request bodies the mock received since `from`. */
const chatRequests = (from: number) =>
  llama.requests
    .slice(from)
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => r.body as { tools?: unknown[]; messages: { role: string; content: unknown }[] });

describe("approved memories (contracts §12)", () => {
  it("CRUD with UUID files, case-insensitive NFC names, conditional changes and ownership", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const created = await api(base, alice, "POST", "/api/memories", {
      name: "  Café ",
      body: "Likes coffee",
    });
    expect(created.status).toBe(201);
    expect(created.json.name).toBe("Café");
    // The file is named by a server UUID; the name lives inside it (INV-12).
    const files = readdirSync(path.join(dataDir, alice.userId, "memories"));
    expect(files).toEqual([`${created.json.id}.md`]);
    expect(
      readFileSync(path.join(dataDir, alice.userId, "memories", files[0] ?? ""), "utf8"),
    ).toMatch(/^---\nformatVersion: 1\nid: [0-9a-f-]{36}\nname: "Café"\n/);
    // NFC + case-folded collision: "CAFE" + combining acute.
    const clash = await api(base, alice, "POST", "/api/memories", {
      name: "CAFÉ",
      body: "x",
    });
    expect(clash.status).toBe(409);
    for (const name of ["", "a\nb", "x".repeat(65)]) {
      expect((await api(base, alice, "POST", "/api/memories", { name, body: "x" })).status).toBe(
        name === "" ? 400 : 400,
      );
    }
    const stale = await api(base, alice, "PATCH", `/api/memories/${created.json.id}`, {
      body: "Likes tea",
      expectedRevision: "a".repeat(64),
    });
    expect(stale.status).toBe(409);
    const updated = await api(base, alice, "PATCH", `/api/memories/${created.json.id}`, {
      body: "Likes tea",
      expectedRevision: created.json.revision,
    });
    expect(updated.json.body).toBe("Likes tea");
    // Another account sees nothing and can change nothing.
    expect((await api(base, bob, "GET", "/api/memories")).json.memories).toEqual([]);
    expect(
      (
        await api(base, bob, "DELETE", `/api/memories/${created.json.id}`, {
          expectedRevision: updated.json.revision,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(base, alice, "DELETE", `/api/memories/${created.json.id}`, {
          expectedRevision: updated.json.revision,
        })
      ).status,
    ).toBe(200);
    expect((await api(base, alice, "GET", "/api/memories")).json.memories).toEqual([]);
  });

  it("approved notes reach the prompt whole, in name order; over-budget notes are omitted and shown", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    for (const name of ["b-note", "a-note"])
      await api(base, alice, "POST", "/api/memories", { name, body: `${name} body` });
    for (let i = 0; i < 4; i++)
      await api(base, alice, "POST", "/api/memories", {
        name: `z-big-${String(i)}`,
        body: "y".repeat(1_990),
      });
    const listed = (await api(base, alice, "GET", "/api/memories")).json.memories;
    expect(listed.map((m) => m.name).slice(0, 2)).toEqual(["a-note", "b-note"]);
    expect(listed.filter((m) => m.omitted).length).toBeGreaterThan(0);
    const from = llama.requests.length;
    await send(base, alice, "hello", undefined, MOCK_MODELS.chat);
    const system = JSON.stringify(chatRequests(from)[0]?.messages[0]);
    expect(system.indexOf("### a-note")).toBeLessThan(system.indexOf("### b-note"));
    const omitted = listed.find((m) => m.omitted);
    expect(system).not.toContain(omitted?.name ?? "missing");
    // Notes are never cut mid-body.
    expect(system.match(/y{1990}/g)?.length ?? 0).toBe(
      listed.filter((m) => m.name.startsWith("z") && !m.omitted).length,
    );
  });
});

describe("the shared tool loop (D2 amendment to contracts §4.3)", () => {
  it("text before a call and the follow-up become one assistant block; no tool content is stored", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const from = llama.requests.length;
    const { id, conversation, stream } = await send(
      base,
      alice,
      "say Let me work it out.; calc 2*(3+4)^2",
    );
    const last = reply(conversation);
    expect(last?.status).toBe("complete");
    expect(last?.content).toBe("Let me work it out.\n\nDone: 98");
    expect(last?.tools).toEqual(["calculate"]);
    expect(stream).toContain("event: tool");
    const file = chatFile(dataDir, alice.userId, id);
    expect(file).toContain('tools="calculate"');
    expect(file).not.toMatch(/tool_calls|call_\d|cc:tool/);
    // Reasoning from both requests is one block.
    expect(file).toContain("Planning tools.\n\nSummarizing.");
    const requests = chatRequests(from);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.length).toBeGreaterThan(0);
    expect(requests[1]?.messages.map((m) => m.role).slice(-2)).toEqual(["assistant", "tool"]);

    // The next turn never sees earlier tool messages.
    const next = llama.requests.length;
    await send(base, alice, "plain question", id);
    const roles = chatRequests(next)[0]?.messages.map((m) => m.role) ?? [];
    expect(roles).not.toContain("tool");
    expect(JSON.stringify(chatRequests(next)[0]?.messages)).not.toContain("tool_calls");
  });

  it("rounds are bounded: the request after the last round offers no tools", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const from = llama.requests.length;
    const { conversation } = await send(base, alice, "loop 1+1");
    const requests = chatRequests(from);
    expect(requests).toHaveLength(4);
    expect(requests.slice(0, 3).every((r) => (r.tools?.length ?? 0) > 0)).toBe(true);
    expect(requests[3]?.tools).toBeUndefined();
    expect(reply(conversation)?.content).toMatch(/^Final: 2 \| 2 \| 2$/);
  });

  it("invalid, unknown and malformed calls are dropped without failing the answer", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const { conversation } = await send(base, alice, "bogus; badargs; calc 1+1; forget Nobody");
    const last = reply(conversation);
    expect(last?.status).toBe("complete");
    expect(last?.content).toContain("Not run: unknown tool.");
    expect(last?.content).toContain("Not recorded: invalid suggestion.");
    expect(last?.tools).toEqual(["calculate"]);
    expect(conversation.proposals).toEqual([]);
  });

  it("a provider that rejects tool results ends the reply with the text so far", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const { conversation } = await send(base, alice, "say Hi there.; calc 1+1; rejectfollow");
    expect(reply(conversation)?.status).toBe("complete");
    expect(reply(conversation)?.content).toBe("Hi there.");
    expect(JSON.stringify(conversation)).not.toContain("UPSTREAM-SECRET");
  });

  it("models without verified tool support are never offered tools", async () => {
    const { base, chatui } = await serve({ tools: false });
    const alice = await signIn(base, chatui);
    const from = llama.requests.length;
    const { conversation } = await send(base, alice, "remember Dog: Rex");
    expect(chatRequests(from)[0]?.tools).toBeUndefined();
    expect(reply(conversation)?.content).toBe("Echo: remember Dog: Rex");
  });

  it("general tools read only the caller's own chats", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    await send(base, bob, "bob talks about zeppelins", undefined, MOCK_MODELS.chat);
    await send(base, alice, "alice talks about zeppelins too", undefined, MOCK_MODELS.chat);
    const { conversation } = await send(base, alice, "search zeppelins");
    const content = reply(conversation)?.content ?? "";
    expect(content).toContain("alice talks about zeppelins");
    expect(content).not.toContain("bob talks");
    expect(reply(conversation)?.tools).toEqual(["search_chats"]);
  });

  it("a follow-up that cannot fit the context is skipped; the reply keeps the text so far", async () => {
    const { base, chatui, dataDir } = await serve({ contextTokens: 2_500 });
    const alice = await signIn(base, chatui);
    // A long chat on disk: reading it returns a result capped at 6,000 characters.
    const long = crypto.randomUUID();
    mkdirSync(path.join(dataDir, alice.userId, "chats"), { recursive: true });
    writeFileSync(
      path.join(dataDir, alice.userId, "chats", `${long}.md`),
      serializeConversation({
        title: "Long",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        blocks: [{ type: "user", id: crypto.randomUUID(), body: "w ".repeat(20_000) }],
      }),
    );
    const from = llama.requests.length;
    const { conversation } = await send(base, alice, `say Partial answer.; read ${long}`);
    // The schemas fit, the tool result does not: one request, the text before the call.
    expect(chatRequests(from)).toHaveLength(1);
    expect(reply(conversation)?.status).toBe("complete");
    expect(reply(conversation)?.content).toBe("Partial answer.");
  });
});

describe("memory proposals (INV-37, INV-38)", () => {
  it("a suggestion is only recorded; the user accepts it (idempotently) or rejects it", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const { id, conversation, stream } = await send(
      base,
      alice,
      "remember Dog: Has a dog named Rex; remember Car: Drives a red car",
    );
    expect(stream).toContain("event: proposals");
    // Actionable ids arrive only with a complete terminal event.
    expect(stream).toMatch(/"proposalIds":\["[0-9a-f-]{36}","[0-9a-f-]{36}"\]/);
    expect((await api(base, alice, "GET", "/api/memories")).json.memories).toEqual([]);
    const [dog, car] = conversation.proposals;
    expect(dog).toMatchObject({ tool: "remember", name: "Dog", status: "pending" });
    const accepted = await api(
      base,
      alice,
      "POST",
      `/api/conversations/${id}/proposals/${dog?.id ?? ""}/accept`,
    );
    expect(accepted.json.status).toBe("accepted");
    const again = await api(
      base,
      alice,
      "POST",
      `/api/conversations/${id}/proposals/${dog?.id ?? ""}/accept`,
    );
    expect(again.status).toBe(200);
    expect(
      (await api(base, alice, "GET", "/api/memories")).json.memories.map((m) => m.body),
    ).toEqual(["Has a dog named Rex"]);
    const rejected = await api(
      base,
      alice,
      "POST",
      `/api/conversations/${id}/proposals/${car?.id ?? ""}/reject`,
    );
    expect(rejected.json.status).toBe("rejected");
    expect(
      (await api(base, alice, "POST", `/api/conversations/${id}/proposals/${car?.id ?? ""}/accept`))
        .status,
    ).toBe(409);
    // Another account can't act on them.
    const bob = await signIn(base, chatui, "bob");
    expect(
      (await api(base, bob, "POST", `/api/conversations/${id}/proposals/${dog?.id ?? ""}/accept`))
        .status,
    ).toBe(404);
  });

  it("duplicates of pending, rejected and current memory are suppressed", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const first = await send(base, alice, "remember Dog: Rex");
    const second = await send(base, alice, "remember Dog: Rex", first.id);
    expect(second.conversation.proposals.map((p) => p.status)).toEqual(["pending", "suppressed"]);
    await api(base, alice, "POST", "/api/memories", { name: "Cat", body: "Tom" });
    const third = await send(base, alice, "update Cat: Tom", first.id);
    expect(third.conversation.proposals.at(-1)?.status).toBe("suppressed");
    expect(reply(third.conversation)?.content).toContain("Already suggested; not repeated.");
  });

  it("a note changed after the reply's snapshot conflicts at acceptance and is never overwritten", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const cat = (await api(base, alice, "POST", "/api/memories", { name: "Cat", body: "Tom" }))
      .json;
    const { id, conversation } = await send(base, alice, "update Cat: Tom the second");
    const proposal = conversation.proposals[0];
    expect(proposal).toMatchObject({ tool: "update_memory", status: "pending" });
    const manual = await api(base, alice, "PATCH", `/api/memories/${cat.id}`, {
      body: "Tom, edited by hand",
      expectedRevision: cat.revision,
    });
    expect(manual.status).toBe(200);
    const res = await api(
      base,
      alice,
      "POST",
      `/api/conversations/${id}/proposals/${proposal?.id ?? ""}/accept`,
    );
    expect(res.status).toBe(409);
    const after = (await api(base, alice, "GET", `/api/conversations/${id}`)).json;
    expect(after.proposals[0]).toMatchObject({ status: "pending", stale: true });
    expect((await api(base, alice, "GET", "/api/memories")).json.memories[0]?.body).toBe(
      "Tom, edited by hand",
    );
  });

  it("update and forget must name a note that was in the prompt", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    await api(base, alice, "POST", "/api/memories", { name: "Huge", body: "h".repeat(1_990) });
    for (let i = 0; i < 2; i++)
      await api(base, alice, "POST", "/api/memories", {
        name: `A-${String(i)}`,
        body: "a".repeat(1_990),
      });
    const omitted = (await api(base, alice, "GET", "/api/memories")).json.memories.find(
      (m) => m.omitted,
    );
    expect(omitted?.name).toBe("Huge");
    const { conversation } = await send(base, alice, "forget Huge; forget Missing");
    expect(conversation.proposals).toEqual([]);
  });

  it("edit, regenerate and delete invalidate pending suggestions of the removed turns", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const { id, conversation } = await send(base, alice, "remember Dog: Rex");
    const user = conversation.messages.find((m) => m.role === "user");
    const edited = await api(
      base,
      alice,
      "PATCH",
      `/api/conversations/${id}/messages/${user?.id ?? ""}`,
      {
        content: "never mind",
        expectedRevision: (conversation as unknown as { revision: string }).revision,
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.json.proposals[0]?.status).toBe("invalid");
  });

  it("deleting a conversation removes its sidecar; accepted memories stay", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const { id, conversation } = await send(base, alice, "remember Dog: Rex");
    await api(
      base,
      alice,
      "POST",
      `/api/conversations/${id}/proposals/${conversation.proposals[0]?.id ?? ""}/accept`,
    );
    const sidecar = path.join(dataDir, alice.userId, "proposals", `${id}.json`);
    expect(existsSync(sidecar)).toBe(true);
    expect((await api(base, alice, "DELETE", `/api/conversations/${id}`)).status).toBe(200);
    expect(existsSync(sidecar)).toBe(false);
    expect((await api(base, alice, "GET", "/api/memories")).json.memories).toHaveLength(1);
  });
});

describe("recovery (INV-60, contracts §2 steps 5–6)", () => {
  it("a crash after the assistant write writes the staged suggestions exactly once at restart", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const first = await serve({
      dataDir,
      hooks: {
        afterAssistantWrite: () => {
          if (crash) throw new Error("simulated crash");
        },
      },
    });
    const alice = await signIn(first.base, first.chatui);
    const { id, conversation } = await send(first.base, alice, "remember Dog: Rex");
    expect(reply(conversation)?.status).toBe("complete");
    expect(conversation.proposals).toEqual([]);
    crash = false;
    const second = await serve({ dataDir });
    await serve({ dataDir }); // a second restart changes nothing
    const after = (await api(second.base, alice, "GET", `/api/conversations/${id}`)).json;
    expect(after.proposals).toHaveLength(1);
    expect(after.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("an interrupted reply's staged suggestions are discarded", async () => {
    const dataDir = tempDataDir();
    const first = await serve({ dataDir, hooks: {} });
    const alice = await signIn(first.base, first.chatui);
    const { id } = await send(first.base, alice, "hello", undefined, MOCK_MODELS.chat);
    // A `running` checkpoint with nothing decided is written as interrupted.
    await first.chatui.checkpoints.write({
      version: 1,
      generationId: crypto.randomUUID(),
      userId: alice.userId,
      conversationId: id,
      assistantMessageId: crypto.randomUUID(),
      operationKey: "",
      providerId: "local",
      model: MOCK_MODELS.tools,
      state: "running",
      content: "partial",
      reasoning: "",
      lastEventId: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      outcome: null,
    });
    const second = await serve({ dataDir });
    const after = (await api(second.base, alice, "GET", `/api/conversations/${id}`)).json;
    expect(reply(after)?.status).toBe("interrupted");
    expect(after.proposals).toEqual([]);
  });

  it.each(["afterIntent", "afterApply"] as const)(
    "an acceptance interrupted %s is completed at restart",
    async (point) => {
      const dataDir = tempDataDir();
      const first = await serve({ dataDir });
      const alice = await signIn(first.base, first.chatui);
      const { id, conversation } = await send(first.base, alice, "remember Dog: Rex");
      first.chatui.services.memory.hooks = {
        [point]: () => Promise.reject(new Error("simulated crash")),
      };
      const res = await api(
        first.base,
        alice,
        "POST",
        `/api/conversations/${id}/proposals/${conversation.proposals[0]?.id ?? ""}/accept`,
      );
      expect(res.status).toBe(500);
      const second = await serve({ dataDir });
      const after = (await api(second.base, alice, "GET", `/api/conversations/${id}`)).json;
      expect(after.proposals[0]?.status).toBe("accepted");
      expect(
        (await api(second.base, alice, "GET", "/api/memories")).json.memories.map((m) => m.body),
      ).toEqual(["Rex"]);
    },
  );

  it("an interrupted acceptance whose note changed meanwhile is reported, not applied", async () => {
    const dataDir = tempDataDir();
    const first = await serve({ dataDir });
    const alice = await signIn(first.base, first.chatui);
    const cat = (
      await api(first.base, alice, "POST", "/api/memories", { name: "Cat", body: "Tom" })
    ).json;
    const { id, conversation } = await send(first.base, alice, "update Cat: Tom II");
    first.chatui.services.memory.hooks = {
      afterIntent: () => Promise.reject(new Error("simulated crash")),
    };
    await api(
      first.base,
      alice,
      "POST",
      `/api/conversations/${id}/proposals/${conversation.proposals[0]?.id ?? ""}/accept`,
    );
    first.chatui.services.memory.hooks = {};
    await api(first.base, alice, "PATCH", `/api/memories/${cat.id}`, {
      body: "Tom by hand",
      expectedRevision: cat.revision,
    });
    const second = await serve({ dataDir });
    const after = (await api(second.base, alice, "GET", `/api/conversations/${id}`)).json;
    expect(after.proposals[0]).toMatchObject({ status: "pending", stale: true });
    expect((await api(second.base, alice, "GET", "/api/memories")).json.memories[0]?.body).toBe(
      "Tom by hand",
    );
  });
});

describe("calculate (an interpreter, never eval)", () => {
  it("evaluates arithmetic with precedence and right-associative powers", () => {
    expect(calculate("2+3*4")).toBe(14);
    expect(calculate("2^3^2")).toBe(512);
    expect(calculate("-2^2")).toBe(-4);
    expect(calculate("max(1, 5, 3) + sqrt(16) % 3")).toBe(6);
    expect(formatNumber(calculate("1/3"))).toBe("0.333333333333");
    expect(calculate("6 × 7 ÷ 2")).toBe(21);
  });

  it("refuses anything else", () => {
    for (const bad of [
      "process.exit(1)",
      "constructor",
      "1/0",
      "2+",
      "(1",
      "a=1",
      "1;2",
      "x".repeat(201),
      "((((((((((((((((((((((((((((((((((1))))))))))))))))))))))))))))))))))",
    ])
      expect(() => calculate(bad), bad).toThrow(CalcError);
  });
});

describe("stored format amendment: tools on assistant blocks", () => {
  it("round-trips and rejects invalid lists", () => {
    const text = serializeConversation({
      title: "t",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      blocks: [
        { type: "user", id: "00000000-0000-4000-8000-000000000001", body: "q" },
        {
          type: "assistant",
          id: "00000000-0000-4000-8000-000000000002",
          status: "complete",
          tools: ["calculate", "search_chats"],
          body: "a",
        },
      ],
    });
    expect(text).toContain('tools="calculate,search_chats"');
    const parsed = parseConversation(text);
    expect(parsed.ok && serializeConversation(parsed.conversation)).toBe(text);
    for (const bad of ['tools="Bad-Name"', 'tools="a,a"', "tools=calculate", 'tools=""'])
      expect(parseConversation(text.replace('tools="calculate,search_chats"', bad)).ok).toBe(false);
  });
});

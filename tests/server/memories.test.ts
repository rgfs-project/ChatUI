import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConversationDto } from "../../shared/conversations.ts";
import type { MemoryDto, MemoryList, ProposalDto } from "../../shared/memories.ts";
import { memoryNameKey, memoryNameProblem } from "../../shared/memories.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { MEMORY_TOOLS, TOOL_RESULTS } from "../../server/chat/memory-tools.ts";
import { KeyedLocks } from "../../server/storage/locks.ts";
import {
  MemoryStore,
  parseMemory,
  selectForPrompt,
  serializeMemory,
  type StoredMemory,
} from "../../server/storage/memories.ts";
import { DataPaths } from "../../server/storage/paths.ts";
import { parseConversation } from "../../server/storage/markdown.ts";
import type { GenerationCheckpoint } from "../../server/storage/checkpoints.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
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

/** Phase 13b: approved memories, proposal-only tools, continuation, acceptance, recovery. */

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 8 });
});
afterAll(async () => {
  await llama.close();
});

const servers: { server: Server; chatui: ChatUiApp }[] = [];
async function stopAll() {
  for (const { server, chatui } of servers.splice(0)) {
    await chatui.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}
afterEach(stopAll);

interface Served {
  base: string;
  chatui: ChatUiApp;
  dataDir: string;
  session: TestSession;
}

const TOOLS = { inputModalities: ["text"], reasoning: true, tools: true };

async function serve(
  options: TestAppOptions & { tools?: boolean; contextTokens?: number; username?: string } = {},
): Promise<Served> {
  const dataDir = options.config?.dataDir ?? tempDataDir();
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [
      localProvider(llama.url, {
        maxActiveGenerations: 8,
        ...(options.tools === false ? {} : { capabilities: TOOLS }),
        ...(options.contextTokens ? { contextTokens: options.contextTokens } : {}),
      }),
    ]);
  const { chatui } = testApp({
    ...options,
    config: {
      provider: providerConfig({ baseUrl: llama.url }),
      ...options.config,
      dataDir,
    },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const session = await signIn(base, chatui, options.username ?? "alice");
  return { base, chatui, dataDir, session };
}

type Body = Record<string, unknown> & { error?: { code: string; details?: { reason?: string } } };

async function api(
  s: Served,
  method: string,
  url: string,
  body?: unknown,
  session: TestSession = s.session,
): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${s.base}${url}`, {
    method,
    headers: {
      ...session.headers(method !== "GET"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

let keySeq = 0;
const key = () => `00000000-0000-4000-9000-${String(++keySeq).padStart(12, "0")}`;

async function send(
  s: Served,
  content: string,
  extra: Record<string, unknown> = {},
  model: string = MOCK_MODELS.tools,
) {
  const res = await api(s, "POST", "/api/generations", {
    providerId: "local",
    model,
    content,
    operationKey: key(),
    operationIssuedAt: new Date().toISOString(),
    ...extra,
  });
  if (res.status === 202)
    await s.chatui.services.generations.settled(String(res.body.generationId));
  return res;
}

const conversationOf = async (s: Served, id: string) =>
  (await api(s, "GET", `/api/conversations/${id}`)).body as unknown as ConversationDto;
const proposalsOf = async (s: Served, id: string) =>
  ((await api(s, "GET", `/api/conversations/${id}/proposals`)).body.proposals ??
    []) as ProposalDto[];
const memoriesOf = async (s: Served) =>
  (await api(s, "GET", "/api/memories")).body as unknown as MemoryList;

function chatRequests(mock: MockLlama, since: number) {
  return mock.requests
    .slice(since)
    .filter((r) => r.path === "/v1/chat/completions")
    .map(
      (r) =>
        r.body as {
          model: string;
          tools?: unknown[];
          messages: {
            role: string;
            content: unknown;
            tool_calls?: { id: string; function: { name: string } }[];
            tool_call_id?: string;
          }[];
        },
    );
}

function markdown(s: Served, conversationId: string): string {
  return readFileSync(
    path.join(s.dataDir, s.session.userId, "chats", `${conversationId}.md`),
    "utf8",
  );
}

function assistantBlocks(s: Served, conversationId: string) {
  const parsed = parseConversation(markdown(s, conversationId));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.conversation.blocks.filter((b) => b.type === "assistant" || b.type === "reasoning");
}

async function createMemory(s: Served, name: string, content: string): Promise<MemoryDto> {
  const res = await api(s, "POST", "/api/memories", { name, content });
  expect(res.status).toBe(201);
  return res.body as unknown as MemoryDto;
}

// ---------------------------------------------------------------------------

describe("memory file format and names (contracts §12)", () => {
  const note = {
    id: "0a1b2c3d-0000-4000-8000-000000000001",
    name: 'Coffee "order" <b>',
    content: "Oat flat white.\n\nNo sugar.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };

  it("serializes exactly the specified front matter and round-trips", () => {
    const text = serializeMemory(note);
    expect(text.split("\n").slice(0, 7)).toEqual([
      "---",
      "formatVersion: 1",
      `id: "${note.id}"`,
      'name: "Coffee \\"order\\" \\u003cb\\u003e"',
      `createdAt: "${note.createdAt}"`,
      `updatedAt: "${note.updatedAt}"`,
      "---",
    ]);
    expect(parseMemory(text, note.id)).toEqual(note);
    // The filename is authoritative; extra keys or a wrong version are malformed.
    expect(parseMemory(text, "0a1b2c3d-0000-4000-8000-000000000002")).toBeNull();
    expect(parseMemory(text.replace("formatVersion: 1", "formatVersion: 2"), note.id)).toBeNull();
    expect(parseMemory(text.replace("---\n\n", 'extra: "x"\n---\n\n'), note.id)).toBeNull();
  });

  it("validates names and folds case and normalization for uniqueness", () => {
    expect(memoryNameProblem("")).toBeDefined();
    expect(memoryNameProblem("   ")).toBeDefined();
    expect(memoryNameProblem("a".repeat(65))).toBeDefined();
    expect(memoryNameProblem("line\nbreak")).toBeDefined();
    expect(memoryNameProblem("tab\there")).toBeDefined();
    expect(memoryNameProblem("sep x")).toBeDefined();
    expect(memoryNameProblem("🙂".repeat(64))).toBeUndefined();
    expect(memoryNameKey("Coffee")).toBe(memoryNameKey("  COFFEE "));
    expect(memoryNameKey("Straße")).toBe(memoryNameKey("STRASSE"));
    expect(memoryNameKey("Café")).toBe(memoryNameKey("Café"));
  });

  it("includes whole notes in name-then-id order within the byte budget", () => {
    const mk = (id: number, name: string, content: string): StoredMemory => ({
      id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      name,
      content,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      revision: String(id),
      bytes: Buffer.from(""),
    });
    const notes = [
      mk(3, "beta", "b".repeat(10)),
      mk(2, "Alpha", "a"),
      mk(1, "zeta", "z".repeat(500)),
    ];
    const { included, omitted } = selectForPrompt(notes, 60);
    expect(included.map((n) => n.name)).toEqual(["Alpha", "beta"]);
    expect(omitted.map((n) => n.name)).toEqual(["zeta"]);
    // Deterministic regardless of input order.
    expect(selectForPrompt([...notes].reverse(), 60).included.map((n) => n.id)).toEqual(
      included.map((n) => n.id),
    );
  });

  it("names collide case-insensitively in the store; files are named only by UUID", async () => {
    const dataDir = tempDataDir();
    const paths = new DataPaths(dataDir);
    const userId = "11111111-1111-4111-8111-111111111111";
    mkdirSync(path.join(dataDir, userId), { recursive: true });
    const store = new MemoryStore({ paths, locks: new KeyedLocks() });
    await store.create(userId, { name: "Coffee", content: "Flat white" });
    await expect(
      store.create(userId, { name: "COFFEE", content: "Espresso" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      store
        .create(userId, { name: "Café", content: "x" })
        .then(() => store.create(userId, { name: "CAFÉ", content: "y" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const files = readdirSync(path.join(dataDir, userId, "memories"));
    expect(files).toHaveLength(2);
    for (const file of files) expect(file).toMatch(/^[0-9a-f-]{36}\.md$/);
    // Files that are not canonical UUID names (e.g. from a case-insensitive
    // copy) are never read as memories.
    writeFileSync(
      path.join(dataDir, userId, "memories", "Coffee.md"),
      serializeMemory({
        ...note,
        id: "not-a-uuid",
      }),
    );
    writeFileSync(
      path.join(dataDir, userId, "memories", files[0]?.toUpperCase().replace(".MD", ".md") ?? ""),
      "junk",
    );
    expect((await store.list(userId)).notes).toHaveLength(2);
  });

  it("enforces the per-note, count and total caps", async () => {
    const dataDir = tempDataDir();
    const userId = "22222222-2222-4222-8222-222222222222";
    mkdirSync(path.join(dataDir, userId), { recursive: true });
    const store = new MemoryStore({ paths: new DataPaths(dataDir), locks: new KeyedLocks() });
    await expect(
      store.create(userId, { name: "big", content: "x".repeat(4_097) }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    for (let i = 0; i < 16; i++)
      await store.create(userId, { name: `n${String(i)}`, content: "x".repeat(4_000) });
    await expect(
      store.create(userId, { name: "one more", content: "x".repeat(2_000) }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});

describe("memory CRUD (INV-37, INV-39)", () => {
  it("creates, lists, updates and deletes with expected revisions; other users see nothing", async () => {
    const s = await serve();
    const created = await createMemory(s, "Coffee", "Flat white");
    expect((await memoriesOf(s)).memories.map((m) => m.name)).toEqual(["Coffee"]);
    const dup = await api(s, "POST", "/api/memories", { name: "coffee", content: "x" });
    expect(dup.status).toBe(409);
    const updated = await api(s, "PATCH", `/api/memories/${created.id}`, {
      content: "Oat flat white",
      expectedRevision: created.revision,
    });
    expect(updated.status).toBe(200);
    const stale = await api(s, "PATCH", `/api/memories/${created.id}`, {
      content: "stale",
      expectedRevision: created.revision,
    });
    expect(stale.status).toBe(409);
    // Another account: 404 for the same id, empty list.
    const bob = await signIn(s.base, s.chatui, "bob");
    expect((await api(s, "GET", "/api/memories", undefined, bob)).body.memories).toEqual([]);
    const theirs = await api(
      s,
      "PATCH",
      `/api/memories/${created.id}`,
      { content: "hijack", expectedRevision: String(updated.body.revision) },
      bob,
    );
    expect(theirs.status).toBe(404);
    // CSRF is required for mutations.
    const noCsrf = await fetch(`${s.base}/api/memories`, {
      method: "POST",
      headers: { ...s.session.headers(false), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", content: "y" }),
    });
    expect(noCsrf.status).toBe(403);
    const del = await api(
      s,
      "DELETE",
      `/api/memories/${created.id}?expectedRevision=${String(updated.body.revision)}`,
    );
    expect(del.status).toBe(200);
    expect((await memoriesOf(s)).memories).toEqual([]);
  });

  it("reports notes omitted by MEMORY_PROMPT_BUDGET", async () => {
    const s = await serve({ config: { memories: { promptBudgetBytes: 40 } } });
    await createMemory(s, "Alpha", "short");
    const big = await createMemory(s, "Zeta", "z".repeat(100));
    const list = await memoriesOf(s);
    expect(list.omittedIds).toEqual([big.id]);
    expect(list.promptBudgetBytes).toBe(40);
  });
});

describe("approved memories in the prompt (contracts §4 item 3)", () => {
  it("follow the per-model prompt, are never template-expanded and omit notes over budget", async () => {
    const s = await serve({ tools: false, config: { memories: { promptBudgetBytes: 200 } } });
    await createMemory(s, "Name", "Call me {{username}} literally");
    await createMemory(s, "Zeta", "z".repeat(400));
    const since = llama.requests.length;
    await send(s, "hello", {}, MOCK_MODELS.chat);
    const [request] = chatRequests(llama, since);
    const system = request?.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("### Name\nCall me {{username}} literally");
    expect(system?.content).not.toContain("zzzz");
    // Tools are offered only to verified tool-capable models.
    expect(request?.tools).toBeUndefined();
  });

  it("records the memory snapshot with the generation checkpoint", async () => {
    const s = await serve();
    const note = await createMemory(s, "Coffee", "Flat white");
    const res = await send(s, "hi");
    const checkpoint = await s.chatui.checkpoints.read(String(res.body.generationId));
    expect(checkpoint?.memorySnapshot).toEqual([
      { id: note.id, name: "Coffee", revision: note.revision },
    ]);
  });

  it("counts the tool schemas in the budget", async () => {
    const s = await serve({ contextTokens: 1_024 });
    const text = "x".repeat(600);
    const withTools = await send(s, text);
    expect(withTools.status).toBe(422);
    expect(withTools.body.error?.code).toBe("CONTEXT_TOO_LARGE");
    await stopAll();
    const plain = await serve({ tools: false, contextTokens: 1_024 });
    expect((await send(plain, text, {}, MOCK_MODELS.tools)).status).toBe(202);
  });
});

describe("proposal tools and the single continuation (contracts §4.3)", () => {
  it("text before a call: one assistant block, no tool content in Markdown, a tool-free continuation", async () => {
    const s = await serve();
    const since = llama.requests.length;
    const res = await send(s, "I drink tea [[create Drink|Prefers green tea]]");
    expect(res.status).toBe(202);
    const conversationId = String(res.body.conversationId);
    const [first, second, ...rest] = chatRequests(llama, since);
    expect(rest).toEqual([]);
    expect(first?.tools).toHaveLength(MEMORY_TOOLS.length);
    // The continuation: same prompt + tool-call message + one fixed result; no tools.
    expect(second?.tools).toBeUndefined();
    const tail = second?.messages.slice(-2) ?? [];
    expect(tail[0]).toMatchObject({ role: "assistant", content: "Noted: I drink tea" });
    expect(tail[0]?.tool_calls?.[0]?.function.name).toBe("propose_memory_create");
    expect(tail[1]).toEqual({ role: "tool", tool_call_id: "call_0", content: TOOL_RESULTS.valid });
    expect(second?.messages.slice(0, -2)).toEqual(first?.messages);

    expect(assistantBlocks(s, conversationId)).toEqual([
      expect.objectContaining({ type: "reasoning", body: "Thinking.\n\nContinuing." }),
      expect.objectContaining({
        type: "assistant",
        status: "complete",
        body: "Noted: I drink tea\n\nContinued after 1 result(s).",
      }),
    ]);
    const text = markdown(s, conversationId);
    expect(text).not.toContain("propose_memory");
    expect(text).not.toContain(TOOL_RESULTS.valid);
    expect(text).not.toContain("call_0");
    // The suggested text appears only where the user typed it (and the title).
    for (const block of assistantBlocks(s, conversationId))
      expect(block.body).not.toContain("Prefers green tea");
    const proposals = await proposalsOf(s, conversationId);
    expect(proposals).toEqual([
      expect.objectContaining({
        tool: "create",
        name: "Drink",
        content: "Prefers green tea",
        status: "pending",
      }),
    ]);
    // INV-37: nothing was written to approved memory by the model.
    expect((await memoriesOf(s)).memories).toEqual([]);

    // No tool content in any later prompt.
    const later = llama.requests.length;
    await send(s, "next", { conversationId });
    const [next] = chatRequests(llama, later);
    const serialized = JSON.stringify(next?.messages);
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain('"tool"');
    expect(serialized).not.toContain("Recorded as a pending");
    expect(serialized).not.toContain("propose_memory");
  });

  it("previews over SSE while streaming; the terminal event lists actionable ids", async () => {
    const s = await serve();
    const res = await send(s, "[[create Pet|Has a cat]]");
    const stream = await fetch(
      `${s.base}/api/generations/${String(res.body.generationId)}/stream`,
      {
        headers: { ...s.session.headers(), "Last-Event-ID": "0" },
      },
    );
    const text = await stream.text();
    const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({
      type: m[1],
      data: JSON.parse(m[2] ?? "null") as Record<string, unknown>,
    }));
    const preview = events.find((e) => e.type === "proposals");
    expect(preview?.data.proposals).toEqual([
      expect.objectContaining({ name: "Pet", status: "pending", tool: "create" }),
    ]);
    const terminal = events.find((e) => e.type === "terminal");
    const [proposal] = await proposalsOf(s, String(res.body.conversationId));
    expect(terminal?.data.proposalIds).toEqual([proposal?.id]);
    // Previews come before the terminal event.
    expect(events.indexOf(preview as never)).toBeLessThan(events.indexOf(terminal as never));
  });

  it("call-only and multi-call responses each produce one assistant block", async () => {
    const s = await serve();
    const only = await send(s, "[[calls-only]] [[create A|one]]");
    expect(assistantBlocks(s, String(only.body.conversationId)).at(-1)).toMatchObject({
      body: "Continued after 1 result(s).",
      status: "complete",
    });
    const since = llama.requests.length;
    const multi = await send(s, "x [[create B|two]] [[create C|three]] [[forget Missing]]");
    const cid = String(multi.body.conversationId);
    expect(assistantBlocks(s, cid).filter((b) => b.type === "assistant")).toHaveLength(1);
    const results = chatRequests(llama, since)[1]?.messages.filter((m) => m.role === "tool");
    expect(results?.map((m) => m.content)).toEqual([
      TOOL_RESULTS.valid,
      TOOL_RESULTS.valid,
      TOOL_RESULTS.invalid,
    ]);
    expect((await proposalsOf(s, cid)).map((p) => p.name)).toEqual(["B", "C"]);
  });

  it("drops invalid, unknown, oversized and over-cap calls; the answer stays complete", async () => {
    const s = await serve({
      config: { memories: { maxToolCalls: 4, maxToolArgumentBytes: 8_192 } },
    });
    const since = llama.requests.length;
    const res = await send(s, "text [[bad]] [[unknown]] [[huge]] [[many 6]]");
    const cid = String(res.body.conversationId);
    expect(assistantBlocks(s, cid).at(-1)).toMatchObject({ status: "complete" });
    const proposals = await proposalsOf(s, cid);
    // Calls 0–2 are invalid, call 3 is the only one within the cap of 4.
    expect(proposals.map((p) => p.name)).toEqual(["Note 1"]);
    const results = chatRequests(llama, since)[1]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(results).toHaveLength(9);
    expect(results.filter((m) => m.content === TOOL_RESULTS.valid)).toHaveLength(1);
    // The oversized arguments were never buffered in full.
    const call = chatRequests(llama, since)[1]?.messages.at(-10) as unknown as {
      tool_calls: { function: { arguments: string } }[];
    };
    expect(call.tool_calls[2]?.function.arguments).toBe("");
  });

  it("tracks a bounded number of calls", async () => {
    const s = await serve();
    const since = llama.requests.length;
    await send(s, "[[many 40]]");
    const results = chatRequests(llama, since)[1]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(results).toHaveLength(32);
  });

  it("suppresses duplicates of pending, rejected and current memory", async () => {
    const s = await serve();
    const first = await send(s, "[[create Coffee|Flat white]]");
    const cid = String(first.body.conversationId);
    await send(s, "[[create coffee|Flat white]]", { conversationId: cid });
    let proposals = await proposalsOf(s, cid);
    expect(proposals.map((p) => p.status)).toEqual(["pending", "suppressed"]);
    const firstId = proposals[0]?.id ?? "";
    expect(
      (await api(s, "POST", `/api/conversations/${cid}/proposals/${firstId}/reject`, {})).status,
    ).toBe(200);
    await send(s, "[[create Coffee|Flat white]]", { conversationId: cid });
    proposals = await proposalsOf(s, cid);
    expect(proposals.at(-1)?.status).toBe("suppressed");
    // Effect already matches current approved memory.
    await createMemory(s, "Tea", "Green");
    await send(s, "[[update Tea|Green]]", { conversationId: cid });
    expect((await proposalsOf(s, cid)).at(-1)).toMatchObject({ name: "Tea", status: "suppressed" });
  });

  it("skips the continuation when output tokens are exhausted, keeping the proposals", async () => {
    const s = await serve();
    const since = llama.requests.length;
    const res = await send(s, "done [[exhaust]] [[create Book|Dune]]");
    expect(chatRequests(llama, since)).toHaveLength(1);
    const cid = String(res.body.conversationId);
    expect(assistantBlocks(s, cid).at(-1)).toMatchObject({
      status: "complete",
      body: "Noted: done",
    });
    expect((await proposalsOf(s, cid)).map((p) => p.status)).toEqual(["pending"]);
  });

  it("skips a continuation that would not fit the context rather than overflowing", async () => {
    const s = await serve({ contextTokens: 2_048 });
    const since = llama.requests.length;
    const res = await send(s, "long [[big 6000]]");
    expect(res.status).toBe(202);
    expect(chatRequests(llama, since)).toHaveLength(1);
    expect(assistantBlocks(s, String(res.body.conversationId)).at(-1)).toMatchObject({
      status: "complete",
      body: "Noted: long",
    });
  });

  it("a provider that rejects tool results ends with the text so far; an empty answer stays complete", async () => {
    const s = await serve();
    const res = await send(s, "hello [[reject-continuation]] [[create Car|Blue]]");
    const cid = String(res.body.conversationId);
    expect(assistantBlocks(s, cid).at(-1)).toMatchObject({
      status: "complete",
      body: "Noted: hello",
    });
    expect((await proposalsOf(s, cid))[0]?.status).toBe("pending");
    const empty = await send(s, "[[calls-only]] [[reject-continuation]] [[create Bike|Red]]");
    const eid = String(empty.body.conversationId);
    expect(assistantBlocks(s, eid).at(-1)).toMatchObject({ status: "complete", body: "" });
    expect((await proposalsOf(s, eid))[0]?.status).toBe("pending");
    const conv = await conversationOf(s, eid);
    expect(conv.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "",
      status: "complete",
    });
  });

  it("continuation failure and timeout end the generation with that status; proposals are discarded", async () => {
    const s = await serve();
    const failed = await send(s, "x [[fail-continuation]] [[create Fail|x]]");
    const fid = String(failed.body.conversationId);
    expect(assistantBlocks(s, fid).at(-1)).toMatchObject({ status: "failed" });
    expect(await proposalsOf(s, fid)).toEqual([]);
    await stopAll();
    const slow = await serve({
      config: { provider: providerConfig({ baseUrl: llama.url, timeoutMs: 300 }) },
    });
    const timed = await send(slow, "x [[hang-continuation]] [[create Slow|x]]");
    const tid = String(timed.body.conversationId);
    expect(assistantBlocks(slow, tid).at(-1)).toMatchObject({
      status: "timed_out",
      body: "Noted: x\n\nPartial continuation ",
    });
    expect(await proposalsOf(slow, tid)).toEqual([]);
  });

  it("update and forget must target a note in the prompt snapshot", async () => {
    const s = await serve({ config: { memories: { promptBudgetBytes: 40 } } });
    await createMemory(s, "Alpha", "short");
    await createMemory(s, "Zeta", "z".repeat(100));
    const res = await send(s, "[[forget Zeta]] [[update Nope|x]] [[forget alpha]]");
    const proposals = await proposalsOf(s, String(res.body.conversationId));
    expect(proposals.map((p) => [p.tool, p.name])).toEqual([["forget", "Alpha"]]);
  });
});

describe("accepting and rejecting proposals (INV-37, INV-38)", () => {
  it("accept applies once; a second accept is idempotent; rejected cannot be accepted", async () => {
    const s = await serve();
    const res = await send(s, "[[create Coffee|Flat white]] [[create Tea|Green]]");
    const cid = String(res.body.conversationId);
    const [coffee, tea] = await proposalsOf(s, cid);
    const accept = (id: string) =>
      api(s, "POST", `/api/conversations/${cid}/proposals/${id}/accept`, {});
    const once = await accept(coffee?.id ?? "");
    expect(once.status).toBe(200);
    expect(once.body.status).toBe("accepted");
    const twice = await accept(coffee?.id ?? "");
    expect(twice.body.resultMemoryId).toBe(once.body.resultMemoryId);
    expect((await memoriesOf(s)).memories.map((m) => [m.name, m.content])).toEqual([
      ["Coffee", "Flat white"],
    ]);
    const rejected = await api(
      s,
      "POST",
      `/api/conversations/${cid}/proposals/${tea?.id ?? ""}/reject`,
      {},
    );
    expect(rejected.body.status).toBe("rejected");
    const late = await accept(tea?.id ?? "");
    expect(late.status).toBe(409);
    expect(late.body.error?.details?.reason).toBe("not_actionable");
    // Another account can't act on it.
    const bob = await signIn(s.base, s.chatui, "bob");
    const theirs = await api(
      s,
      "POST",
      `/api/conversations/${cid}/proposals/${coffee?.id ?? ""}/accept`,
      {},
      bob,
    );
    expect(theirs.status).toBe(404);
  });

  it("a note changed manually after the suggestion conflicts instead of being overwritten", async () => {
    const s = await serve();
    const note = await createMemory(s, "Coffee", "Flat white");
    const res = await send(s, "[[update Coffee|Espresso]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    await api(s, "PATCH", `/api/memories/${note.id}`, {
      content: "Cortado",
      expectedRevision: note.revision,
    });
    const accept = await api(
      s,
      "POST",
      `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`,
      {},
    );
    expect(accept.status).toBe(409);
    expect(accept.body.error?.details?.reason).toBe("note_changed");
    expect((await memoriesOf(s)).memories[0]?.content).toBe("Cortado");
  });

  it("INV-38: a note edited between generation acceptance and the tool call conflicts at acceptance", async () => {
    let edit: (() => Promise<void>) | undefined;
    const s = await serve({
      send: {
        hooks: {
          afterCommit: async () => {
            await edit?.();
          },
        },
      },
    });
    const note = await createMemory(s, "Coffee", "Flat white");
    edit = async () => {
      edit = undefined;
      await s.chatui.services.memories.update(s.session.userId, note.id, {
        content: "Cortado",
        expectedRevision: note.revision,
      });
    };
    const res = await send(s, "[[update Coffee|Espresso]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    expect(proposal?.status).toBe("pending");
    const accept = await api(
      s,
      "POST",
      `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`,
      {},
    );
    expect(accept.status).toBe(409);
    expect((await memoriesOf(s)).memories[0]?.content).toBe("Cortado");
  });

  it("forget deletes the note; concurrent acceptance and a manual update never both apply", async () => {
    const s = await serve();
    const note = await createMemory(s, "Coffee", "Flat white");
    const res = await send(s, "[[update Coffee|Espresso]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    const [accept, manual] = await Promise.all([
      api(s, "POST", `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`, {}),
      api(s, "PATCH", `/api/memories/${note.id}`, {
        content: "Mocha",
        expectedRevision: note.revision,
      }),
    ]);
    expect([accept.status, manual.status].sort()).toEqual([200, 409]);
    const content = (await memoriesOf(s)).memories[0]?.content;
    expect(content).toBe(accept.status === 200 ? "Espresso" : "Mocha");

    const current = (await memoriesOf(s)).memories[0];
    const forget = await send(s, "[[forget Coffee]]", { conversationId: cid });
    expect(forget.status).toBe(202);
    const last = (await proposalsOf(s, cid)).at(-1);
    expect(last).toMatchObject({ tool: "forget", targetMemoryId: current?.id });
    await api(s, "POST", `/api/conversations/${cid}/proposals/${last?.id ?? ""}/accept`, {});
    expect((await memoriesOf(s)).memories).toEqual([]);
  });

  it("edit, delete exchange and regenerate invalidate the affected pending proposals", async () => {
    const s = await serve();
    const res = await send(s, "[[create One|1]]");
    const cid = String(res.body.conversationId);
    await send(s, "[[create Two|2]]", { conversationId: cid });
    await send(s, "[[create Three|3]]", { conversationId: cid });
    let conv = await conversationOf(s, cid);
    const users = conv.messages.filter((m) => m.role === "user");
    // Delete exchange 2: only its proposal becomes invalid.
    const del = await api(
      s,
      "DELETE",
      `/api/conversations/${cid}/messages/${users[1]?.id ?? ""}?expectedRevision=${conv.revision}`,
    );
    expect(del.status).toBe(200);
    expect((await proposalsOf(s, cid)).map((p) => [p.name, p.status])).toEqual([
      ["One", "pending"],
      ["Two", "invalid"],
      ["Three", "pending"],
    ]);
    // Regenerate turn 3: its old reply's proposal is invalid; the new one is fresh.
    conv = await conversationOf(s, cid);
    const regen = await api(s, "POST", `/api/conversations/${cid}/regenerate`, {
      userMessageId: users[2]?.id,
      providerId: "local",
      model: MOCK_MODELS.tools,
      expectedRevision: conv.revision,
      operationKey: key(),
      operationIssuedAt: new Date().toISOString(),
    });
    expect(regen.status).toBe(202);
    await s.chatui.services.generations.settled(String(regen.body.generationId));
    const afterRegen = await proposalsOf(s, cid);
    expect(afterRegen.map((p) => [p.name, p.status])).toEqual([
      ["One", "pending"],
      ["Two", "invalid"],
      ["Three", "invalid"],
      ["Three", "pending"],
    ]);
    // Edit turn 1: everything after it goes.
    conv = await conversationOf(s, cid);
    await api(s, "PATCH", `/api/conversations/${cid}/messages/${users[0]?.id ?? ""}`, {
      content: "edited",
      expectedRevision: conv.revision,
    });
    const stale = await proposalsOf(s, cid);
    expect(stale.every((p) => p.status === "invalid")).toBe(true);
    const accept = await api(
      s,
      "POST",
      `/api/conversations/${cid}/proposals/${stale[0]?.id ?? ""}/accept`,
      {},
    );
    expect(accept.status).toBe(409);
  });

  it("validity is rechecked at acceptance even if sidecar cleanup was missed", async () => {
    const s = await serve();
    const res = await send(s, "[[create Keep|x]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    // Remove the reply behind the app's back (no invalidation ran).
    const file = path.join(s.dataDir, s.session.userId, "chats", `${cid}.md`);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, `${text.slice(0, text.indexOf("<!-- cc:reasoning")).trimEnd()}\n`);
    const accept = await api(
      s,
      "POST",
      `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`,
      {},
    );
    expect(accept.status).toBe(409);
    expect(accept.body.error?.details?.reason).toBe("source_removed");
    expect((await proposalsOf(s, cid))[0]?.status).toBe("invalid");
  });

  it("deleting a conversation removes its sidecar after the Markdown; clear history keeps memories", async () => {
    const s = await serve();
    const res = await send(s, "[[create Keep|x]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    await api(s, "POST", `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`, {});
    const sidecar = path.join(s.dataDir, s.session.userId, "proposals", `${cid}.json`);
    expect(existsSync(sidecar)).toBe(true);
    const other = await send(s, "[[create Other|y]]");
    const cleared = await api(s, "DELETE", "/api/conversations");
    expect(cleared.body.deleted).toBe(2);
    expect(existsSync(sidecar)).toBe(false);
    expect(
      existsSync(
        path.join(
          s.dataDir,
          s.session.userId,
          "proposals",
          `${String(other.body.conversationId)}.json`,
        ),
      ),
    ).toBe(false);
    expect((await memoriesOf(s)).memories.map((m) => m.name)).toEqual(["Keep"]);
  });
});

describe("recovery (INV-60)", () => {
  async function restart(dataDir: string, options: TestAppOptions = {}) {
    await stopAll();
    return serve({ ...options, config: { ...options.config, dataDir } });
  }

  it("a crash after the intent and before the note write leaves the proposal retryable", async () => {
    const dataDir = tempDataDir();
    const s = await serve({
      config: { dataDir },
      proposalHooks: {
        afterIntent: () => {
          throw new Error("crash after intent");
        },
      },
    });
    const res = await send(s, "[[create Coffee|Flat white]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    const failed = await api(
      s,
      "POST",
      `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`,
      {},
    );
    expect(failed.status).toBe(500);
    const again = await restart(dataDir);
    const report = await again.chatui.ready;
    expect(report.memoryIntents).toEqual({ applied: 0, retryable: 1, conflicts: 0 });
    expect((await memoriesOf(again)).memories).toEqual([]);
    expect((await proposalsOf(again, cid))[0]?.status).toBe("pending");
    const retry = await api(
      again,
      "POST",
      `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`,
      {},
    );
    expect(retry.status).toBe(200);
    expect((await memoriesOf(again)).memories).toHaveLength(1);
  });

  it("a crash after the note write finalizes as accepted; the note is never rolled back", async () => {
    const dataDir = tempDataDir();
    const s = await serve({
      config: { dataDir },
      proposalHooks: {
        afterApply: () => {
          throw new Error("crash after apply");
        },
      },
    });
    const res = await send(s, "[[create Coffee|Flat white]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    await api(s, "POST", `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`, {});
    const again = await restart(dataDir);
    expect((await again.chatui.ready).memoryIntents?.applied).toBe(1);
    const [recovered] = await proposalsOf(again, cid);
    expect(recovered?.status).toBe("accepted");
    expect((await memoriesOf(again)).memories.map((m) => m.id)).toEqual([
      recovered?.resultMemoryId,
    ]);
    // Later conversation edits never roll it back.
    const conv = await conversationOf(again, cid);
    await api(
      again,
      "DELETE",
      `/api/conversations/${cid}/messages/${conv.messages[0]?.id ?? ""}?expectedRevision=${conv.revision}`,
    );
    expect((await memoriesOf(again)).memories).toHaveLength(1);
  });

  it("anything else than the before/after hash is a reported conflict and is left untouched", async () => {
    const dataDir = tempDataDir();
    const s = await serve({
      config: { dataDir },
      proposalHooks: {
        afterApply: () => {
          throw new Error("crash after apply");
        },
      },
    });
    const note = await createMemory(s, "Coffee", "Flat white");
    const res = await send(s, "[[update Coffee|Espresso]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    await api(s, "POST", `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`, {});
    // An operator edits the note file by hand before the restart.
    const file = path.join(dataDir, s.session.userId, "memories", `${note.id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace("Espresso", "Hand edited"));
    const again = await restart(dataDir);
    expect((await again.chatui.ready).memoryIntents?.conflicts).toBe(1);
    expect((await memoriesOf(again)).memories[0]?.content).toBe("Hand edited");
  });

  it("conversation deletion settles a pending acceptance intent before removing the Markdown", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const s = await serve({
      config: { dataDir },
      proposalHooks: {
        afterApply: () => {
          if (crash) throw new Error("I/O failure after apply");
        },
      },
    });
    const res = await send(s, "[[create Coffee|Flat white]]");
    const cid = String(res.body.conversationId);
    const [proposal] = await proposalsOf(s, cid);
    await api(s, "POST", `/api/conversations/${cid}/proposals/${proposal?.id ?? ""}/accept`, {});
    crash = false;
    const sidecar = path.join(dataDir, s.session.userId, "proposals", `${cid}.json`);
    expect(readFileSync(sidecar, "utf8")).toContain('"intent":{');
    const del = await api(s, "DELETE", `/api/conversations/${cid}`);
    expect(del.status).toBe(200);
    expect(existsSync(sidecar)).toBe(false);
    // The applied note stays approved.
    expect((await memoriesOf(s)).memories.map((m) => m.name)).toEqual(["Coffee"]);
  });

  it("a crash after the assistant write writes the proposals exactly once, also after a backup restore", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const s = await serve({
      config: { dataDir },
      send: {
        hooks: {
          afterAssistantWrite: () => {
            if (crash) throw new Error("crash after assistant write");
          },
        },
      },
    });
    const res = await send(s, "[[create Coffee|Flat white]] [[create Tea|Green]]");
    const cid = String(res.body.conversationId);
    crash = false;
    expect(assistantBlocks(s, cid).at(-1)).toMatchObject({ status: "complete" });
    expect(existsSync(path.join(dataDir, s.session.userId, "proposals", `${cid}.json`))).toBe(
      false,
    );
    const checkpoint = (await s.chatui.checkpoints.read(
      String(res.body.generationId),
    )) as GenerationCheckpoint;
    expect(checkpoint.state).toBe("terminal-decided");
    expect(checkpoint.outcome?.proposals).toHaveLength(2);
    await stopAll();
    // An operator backup of the whole data directory, restored elsewhere.
    const restored = tempDataDir();
    cpSync(dataDir, restored, { recursive: true });
    for (const dir of [dataDir, restored]) {
      const again = await restart(dir);
      expect((await proposalsOf(again, cid)).map((p) => p.name)).toEqual(["Coffee", "Tea"]);
      const twice = await restart(dir);
      expect(await proposalsOf(twice, cid)).toHaveLength(2);
      expect(assistantBlocks(twice, cid).filter((b) => b.type === "assistant")).toHaveLength(1);
    }
  });

  it("a crash after terminal-decided before the Markdown write writes the reply, then the proposals", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const s = await serve({
      config: { dataDir },
      send: {
        hooks: {
          afterAssistantWrite: () => {
            if (crash) throw new Error("crash");
          },
        },
      },
    });
    const res = await send(s, "[[create Coffee|Flat white]]");
    const cid = String(res.body.conversationId);
    crash = false;
    // Undo the reply to simulate a crash just before the Markdown write.
    const file = path.join(dataDir, s.session.userId, "chats", `${cid}.md`);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, `${text.slice(0, text.indexOf("<!-- cc:reasoning")).trimEnd()}\n`);
    const again = await restart(dataDir);
    expect(assistantBlocks(again, cid).at(-1)).toMatchObject({
      status: "complete",
      body: "Noted: \n\nContinued after 1 result(s).",
    });
    expect(await proposalsOf(again, cid)).toHaveLength(1);
  });

  it("staged proposals are discarded for an interrupted reply or a deleted conversation", async () => {
    const dataDir = tempDataDir();
    const s = await serve({
      config: { dataDir, provider: providerConfig({ baseUrl: llama.url, timeoutMs: 60_000 }) },
    });
    const res = await api(s, "POST", "/api/generations", {
      providerId: "local",
      model: MOCK_MODELS.tools,
      content: "x [[hang-continuation]] [[create Lost|x]]",
      operationKey: key(),
      operationIssuedAt: new Date().toISOString(),
    });
    const cid = String(res.body.conversationId);
    for (let i = 0; i < 200; i++) {
      const cp = await s.chatui.checkpoints.read(String(res.body.generationId));
      if (cp?.continuation) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Shutdown leaves it `running` (as a crash would).
    const again = await restart(dataDir);
    expect(assistantBlocks(again, cid).at(-1)).toMatchObject({ status: "interrupted" });
    expect(await proposalsOf(again, cid)).toEqual([]);

    // terminal-decided, but the conversation was deleted before recovery.
    let crash = true;
    const t = await restart(dataDir, {
      send: {
        hooks: {
          afterAssistantWrite: () => {
            if (crash) throw new Error("crash");
          },
        },
      },
    });
    const gone = await send(t, "[[create Gone|x]]");
    crash = false;
    const gid = String(gone.body.conversationId);
    const { rmSync } = await import("node:fs");
    rmSync(path.join(dataDir, t.session.userId, "chats", `${gid}.md`));
    await restart(dataDir);
    expect(existsSync(path.join(dataDir, t.session.userId, "chats", `${gid}.md`))).toBe(false);
    expect(existsSync(path.join(dataDir, t.session.userId, "proposals", `${gid}.json`))).toBe(
      false,
    );
  });
});

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import type { SendHooks } from "../../server/chat/send-service.ts";
import {
  parseConversation,
  serializeConversation,
  type Block,
} from "../../server/storage/markdown.ts";
import { makePng } from "../support/media.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  writeProviders,
  localProvider,
  type TestSession,
} from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4, chunkDelayMs: 30, slowChunks: 200 });
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

async function serve(options: { dataDir?: string; hooks?: SendHooks; baseUrl?: string } = {}) {
  const dataDir = options.dataDir ?? tempDataDir();
  const { chatui } = testApp({
    config: { dataDir, provider: providerConfig({ baseUrl: options.baseUrl ?? llama.url }) },
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

interface Json {
  [key: string]: unknown;
  error: { code: string; message: string };
  revision: string;
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
  userMessageId: string;
  messages: { id: string; role: string; content: string; attachments: { id: string }[] }[];
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

const waitFor = async (base: string, who: TestSession, generationId: string) => {
  await (
    await fetch(`${base}/api/generations/${generationId}/stream`, { headers: who.headers() })
  ).text();
};

async function send(
  base: string,
  who: TestSession,
  content: string,
  conversationId?: string,
  extra: Record<string, unknown> = {},
) {
  const res = await api(base, who, "POST", "/api/generations", {
    ...(conversationId ? { conversationId } : {}),
    providerId: "local",
    model: MOCK_MODELS.chat,
    content,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
    ...extra,
  });
  if (res.status === 202) await waitFor(base, who, res.json.generationId);
  return res;
}

const get = async (base: string, who: TestSession, id: string) =>
  (await api(base, who, "GET", `/api/conversations/${id}`)).json;

const regenerate = (
  base: string,
  who: TestSession,
  conversationId: string,
  messageId: string,
  expectedRevision: string,
  extra: Record<string, unknown> = {},
) =>
  api(base, who, "POST", `/api/conversations/${conversationId}/messages/${messageId}/regenerate`, {
    providerId: "local",
    model: MOCK_MODELS.chat,
    expectedRevision,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
    ...extra,
  });

/** A conversation with three answered turns and a system block after the first. */
async function threeTurns(base: string, who: TestSession) {
  const first = await send(base, who, "one");
  const id = first.json.conversationId;
  await send(base, who, "two", id);
  await send(base, who, "three", id);
  return { id, conversation: await get(base, who, id) };
}

const userIds = (c: Json) => c.messages.filter((m) => m.role === "user").map((m) => m.id);

/** Writes a canonical file directly (irregular layouts and system blocks). */
function writeChat(dataDir: string, userId: string, id: string, blocks: Block[]) {
  const text = serializeConversation({
    title: "Hand made",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    blocks,
  });
  writeFileSync(path.join(dataDir, userId, "chats", `${id}.md`), text);
  return text;
}

const uid = () => crypto.randomUUID();

describe("edit, delete exchange, regenerate (contracts §4.2)", () => {
  it("edit keeps the id and time, replaces the text and removes every later block", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const { id, conversation } = await threeTurns(base, alice);
    const [first] = userIds(conversation);
    const stale = await api(
      base,
      alice,
      "PATCH",
      `/api/conversations/${id}/messages/${String(first)}`,
      {
        content: "one, edited",
        expectedRevision: "a".repeat(64),
      },
    );
    expect(stale.status).toBe(409);
    const edited = await api(
      base,
      alice,
      "PATCH",
      `/api/conversations/${id}/messages/${String(first)}`,
      {
        content: "one, edited",
        expectedRevision: conversation.revision,
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.json.messages.map((m) => [m.id, m.content])).toEqual([[first, "one, edited"]]);
    expect(edited.json.revision).not.toBe(conversation.revision);
  });

  it("delete exchange removes exactly one exchange; later turns and system blocks stay", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const id = uid();
    const [u1, a1, s1, u2, a2] = [uid(), uid(), uid(), uid(), uid()];
    await send(base, alice, "seed"); // creates the chats directory
    writeChat(dataDir, alice.userId, id, [
      { type: "user", id: u1, body: "first" },
      { type: "assistant", id: a1, status: "complete", body: "reply one" },
      { type: "system", id: s1, body: "be brief" },
      { type: "user", id: u2, body: "second" },
      { type: "assistant", id: a2, status: "complete", body: "reply two" },
    ]);
    const before = await get(base, alice, id);
    const res = await api(base, alice, "DELETE", `/api/conversations/${id}/messages/${u1}`, {
      expectedRevision: before.revision,
    });
    expect(res.status).toBe(200);
    expect(res.json.messages.map((m) => m.id)).toEqual([s1, u2, a2]);

    // Edit removes the mid-conversation system block with the later turns.
    const id2 = uid();
    writeChat(dataDir, alice.userId, id2, [
      { type: "user", id: u1, body: "first" },
      { type: "assistant", id: a1, status: "complete", body: "reply one" },
      { type: "system", id: s1, body: "be brief" },
      { type: "user", id: u2, body: "second" },
    ]);
    const before2 = await get(base, alice, id2);
    const edit = await api(base, alice, "PATCH", `/api/conversations/${id2}/messages/${u1}`, {
      content: "first again",
      expectedRevision: before2.revision,
    });
    expect(edit.json.messages.map((m) => m.id)).toEqual([u1]);
  });

  it("irregular regions are refused and the file is left unchanged", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    await send(base, alice, "seed");
    const id = uid();
    const [lead, u1, a1, extra] = [uid(), uid(), uid(), uid()];
    const text = writeChat(dataDir, alice.userId, id, [
      { type: "assistant", id: lead, status: "complete", body: "imported lead" },
      { type: "user", id: u1, body: "question" },
      { type: "assistant", id: a1, status: "complete", body: "answer" },
      { type: "assistant", id: extra, status: "complete", body: "a second answer" },
    ]);
    const { revision } = await get(base, alice, id);
    const file = () => readFileSync(path.join(dataDir, alice.userId, "chats", `${id}.md`), "utf8");
    for (const [method, url, body] of [
      [
        "PATCH",
        `/api/conversations/${id}/messages/${u1}`,
        { content: "x", expectedRevision: revision },
      ],
      ["DELETE", `/api/conversations/${id}/messages/${u1}`, { expectedRevision: revision }],
      ["DELETE", `/api/conversations/${id}/messages/${lead}`, { expectedRevision: revision }],
    ] as const) {
      const res = await api(base, alice, method, url, body);
      expect(res.status, `${method} ${url}`).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
    const regen = await regenerate(base, alice, id, u1, revision);
    expect(regen.status).toBe(400);
    expect(file()).toBe(text);
  });

  it("regenerate replaces the reply with fresh ids, never duplicates the user turn, and is idempotent by key", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const { id, conversation } = await threeTurns(base, alice);
    const [, second] = userIds(conversation);
    const oldReplies = conversation.messages.filter((m) => m.role === "assistant").map((m) => m.id);
    const operationKey = crypto.randomUUID();
    const first = await regenerate(base, alice, id, String(second), conversation.revision, {
      operationKey,
    });
    expect(first.status).toBe(202);
    expect(first.json.userMessageId).toBe(second);
    // The same key again: the original answer, no second truncation.
    const again = await regenerate(base, alice, id, String(second), conversation.revision, {
      operationKey,
    });
    expect(again.json).toEqual(first.json);
    await waitFor(base, alice, first.json.generationId);
    const after = await get(base, alice, id);
    expect(userIds(after)).toEqual(userIds(conversation).slice(0, 2));
    const replies = after.messages.filter((m) => m.role === "assistant").map((m) => m.id);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toBe(first.json.assistantMessageId);
    expect(oldReplies).not.toContain(replies[1]);
    expect(after.messages.at(-1)?.content).toBe("Echo: two");
  });

  it("regenerate works on an unanswered turn; edit → regenerate with an intervening change is CONFLICT", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const { id, conversation } = await threeTurns(base, alice);
    const [, second] = userIds(conversation);
    const edited = await api(
      base,
      alice,
      "PATCH",
      `/api/conversations/${id}/messages/${String(second)}`,
      {
        content: "two, edited",
        expectedRevision: conversation.revision,
      },
    );
    // Unanswered now; another change sneaks in before the regenerate.
    await api(base, alice, "PATCH", `/api/conversations/${id}`, { title: "Renamed" });
    const conflict = await regenerate(base, alice, id, String(second), edited.json.revision);
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("CONFLICT");
    const kept = await get(base, alice, id);
    expect(kept.messages.at(-1)?.content).toBe("two, edited");
    const ok = await regenerate(base, alice, id, String(second), kept.revision);
    expect(ok.status).toBe(202);
    await waitFor(base, alice, ok.json.generationId);
    expect((await get(base, alice, id)).messages.at(-1)?.content).toBe("Echo: two, edited");
  });

  it("an unreachable provider or a missing capability leaves the conversation untruncated", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(makePng())]), "p.png");
    const up = (await (
      await fetch(`${base}/api/attachments`, {
        method: "POST",
        headers: alice.headers(true),
        body: form,
      })
    ).json()) as { id: string };
    const sent = await send(base, alice, "look", undefined, {
      model: MOCK_MODELS.vision,
      attachmentIds: [up.id],
    });
    const id = sent.json.conversationId;
    const before = await get(base, alice, id);
    const file = () => readFileSync(path.join(dataDir, alice.userId, "chats", `${id}.md`), "utf8");
    const text = file();
    const capability = await regenerate(
      base,
      alice,
      id,
      before.messages[0]?.id ?? "",
      before.revision,
    );
    expect(capability.status).toBe(422);
    expect(file()).toBe(text);

    // The provider goes away: the fresh contact fails before anything is removed.
    writeProviders(dataDir, [localProvider("http://127.0.0.1:9")]);
    const down = await serve({ dataDir, baseUrl: "http://127.0.0.1:9" });
    // Sessions live on disk, so the same sign-in works on the restarted server.
    const unreachable = await regenerate(
      down.base,
      alice,
      id,
      before.messages[0]?.id ?? "",
      before.revision,
      {
        model: MOCK_MODELS.vision,
      },
    );
    expect(unreachable.status).toBe(502);
    expect(file()).toBe(text);
  });

  it("mutations wait for the running reply: GENERATION_IN_PROGRESS, then cancel, then succeed", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const first = await send(base, alice, "one");
    const id = first.json.conversationId;
    const running = await api(base, alice, "POST", "/api/generations", {
      conversationId: id,
      providerId: "local",
      model: MOCK_MODELS.slow,
      content: "slow one",
      operationKey: crypto.randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    const now = await get(base, alice, id);
    const target = userIds(now)[0] ?? "";
    for (const res of [
      await api(base, alice, "PATCH", `/api/conversations/${id}/messages/${target}`, {
        content: "x",
        expectedRevision: now.revision,
      }),
      await api(base, alice, "DELETE", `/api/conversations/${id}/messages/${target}`, {
        expectedRevision: now.revision,
      }),
      await regenerate(base, alice, id, target, now.revision),
      await api(base, alice, "POST", "/api/conversations/clear", { confirm: true }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe("GENERATION_IN_PROGRESS");
    }
    await api(base, alice, "POST", `/api/generations/${running.json.generationId}/cancel`, {});
    await waitFor(base, alice, running.json.generationId);
    const settled = await get(base, alice, id);
    const res = await api(base, alice, "DELETE", `/api/conversations/${id}/messages/${target}`, {
      expectedRevision: settled.revision,
    });
    expect(res.status).toBe(200);
    expect(res.json.messages.map((m) => m.content)).toEqual(["slow one", expect.any(String)]);
  });

  it("removed turns take their files; clear history removes chats, files and pins but keeps other settings", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const upload = async () => {
      const form = new FormData();
      form.append("file", new Blob(["text"]), "t.txt");
      return (
        (await (
          await fetch(`${base}/api/attachments`, {
            method: "POST",
            headers: alice.headers(true),
            body: form,
          })
        ).json()) as { id: string }
      ).id;
    };
    const f1 = await upload();
    const first = await send(base, alice, "one", undefined, { attachmentIds: [f1] });
    const id = first.json.conversationId;
    const f2 = await upload();
    await send(base, alice, "two", id, { attachmentIds: [f2] });
    const dir = path.join(dataDir, alice.userId, "attachments");
    const before = await get(base, alice, id);
    // Editing turn one removes turn two and its file; turn one's file stays.
    await api(
      base,
      alice,
      "PATCH",
      `/api/conversations/${id}/messages/${userIds(before)[0] ?? ""}`,
      {
        content: "one again",
        expectedRevision: before.revision,
      },
    );
    expect(existsSync(path.join(dir, f2))).toBe(false);
    expect(existsSync(path.join(dir, f1))).toBe(true);

    const other = await send(base, alice, "keep me pinned");
    await api(base, alice, "PATCH", "/api/preferences", {
      pins: [id, other.json.conversationId],
      imageMaxEdge: 1024,
    });
    const cleared = await api(base, alice, "POST", "/api/conversations/clear", { confirm: true });
    expect(cleared.json.deleted).toBe(2);
    expect((await api(base, alice, "GET", "/api/conversations")).json.conversations).toEqual([]);
    expect(existsSync(path.join(dir, f1))).toBe(false);
    const prefs = (await api(base, alice, "GET", "/api/preferences")).json;
    expect(prefs.pins).toEqual([]);
    expect(prefs.imageMaxEdge).toBe(1024);
  });

  it("a crash after a regeneration's Markdown write is resolved by hashes at restart; no reply is duplicated", async () => {
    const dataDir = tempDataDir();
    let crash = false;
    const first = await serve({
      dataDir,
      hooks: {
        afterCommit: () => {
          if (crash) throw new Error("simulated crash");
        },
      },
    });
    const alice = await signIn(first.base, first.chatui);
    const sent = await send(first.base, alice, "one");
    const id = sent.json.conversationId;
    const before = await get(first.base, alice, id);
    crash = true;
    const res = await regenerate(first.base, alice, id, userIds(before)[0] ?? "", before.revision);
    expect(res.status).toBe(500);
    crash = false;
    await serve({ dataDir });
    const text = readFileSync(path.join(dataDir, alice.userId, "chats", `${id}.md`), "utf8");
    const parsed = parseConversation(text);
    const blocks = parsed.ok ? parsed.conversation.blocks : [];
    // One user block and exactly one (interrupted) reply after it.
    expect(blocks.filter((b) => b.type === "user")).toHaveLength(1);
    const replies = blocks.filter((b) => b.type === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.type === "assistant" && replies[0].status).toBe("interrupted");
  });
});

describe("search and pins", () => {
  it("search is per user, bounded, skips malformed files and points at the matching message", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const a = await send(base, alice, "The quick brown fox jumps over the lazy dog");
    await send(base, bob, "a fox of bob's");
    const bad = uid();
    writeFileSync(path.join(dataDir, alice.userId, "chats", `${bad}.md`), "not a conversation fox");
    // A restart reconciles the index: the malformed file is listed as such.
    const again = await serve({ dataDir });
    const res = await api(again.base, alice, "GET", "/api/search?q=FOX");
    expect(res.status).toBe(200);
    const chats = res.json.chats as {
      conversationId: string;
      matches: number;
      first: { messageId: string; text: string; match: [number, number] };
    }[];
    expect(chats.map((c) => c.conversationId)).toEqual([a.json.conversationId]);
    // The auto-title, the user message and the echoed reply all match.
    expect(chats[0]?.matches).toBe(3);
    const first = chats[0]?.first;
    expect(first?.text.slice(first.match[0], first.match[1]).toLowerCase()).toBe("fox");
    const listed = (await api(again.base, alice, "GET", "/api/conversations")).json
      .conversations as {
      id: string;
      malformed: boolean;
    }[];
    expect(listed.find((c) => c.id === bad)?.malformed).toBe(true);
    expect((await api(again.base, alice, "GET", `/api/search?q=${"x".repeat(201)}`)).status).toBe(
      400,
    );
    expect((await api(again.base, alice, "GET", "/api/search?q=fox&limit=51")).status).toBe(400);
    // The limit caps the results, not only the parameter.
    await send(again.base, alice, "another fox, newer");
    const two = (await api(again.base, alice, "GET", "/api/search?q=fox")).json.chats as unknown[];
    expect(two).toHaveLength(2);
    const one = (await api(again.base, alice, "GET", "/api/search?q=fox&limit=1")).json.chats as {
      title: string;
    }[];
    expect(one).toHaveLength(1);
    expect((await api(again.base, alice, "GET", "/api/search?q=%20")).json.chats).toEqual([]);
  });

  it("INV-34: deleting a chat removes its pin; an index rebuild keeps the others", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const a = (await send(base, alice, "a")).json.conversationId;
    const b = (await send(base, alice, "b")).json.conversationId;
    await api(base, alice, "PATCH", "/api/preferences", { pins: [b, a] });
    await api(base, alice, "DELETE", `/api/conversations/${a}`);
    expect((await api(base, alice, "GET", "/api/preferences")).json.pins).toEqual([b]);
    const indexFile = path.join(dataDir, alice.userId, "index", "chats.json");
    writeFileSync(indexFile, "corrupt");
    const again = await serve({ dataDir });
    expect((await api(again.base, alice, "GET", "/api/preferences")).json.pins).toEqual([b]);
    expect(
      (await api(again.base, alice, "GET", "/api/conversations")).json.conversations,
    ).toHaveLength(1);
  });
});

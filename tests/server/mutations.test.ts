import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConversationDto, SearchResponse } from "../../shared/conversations.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { isSourceValid, segments, truncateAfter, deleteExchange } from "../../server/chat/turns.ts";
import {
  parseConversation,
  serializeConversation,
  type Block,
  type ConversationModel,
} from "../../server/storage/markdown.ts";
import { sha256Hex } from "../../server/storage/operations.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { png } from "../support/media.ts";
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

interface Served {
  base: string;
  chatui: ChatUiApp;
  dataDir: string;
}

async function serve(options: TestAppOptions & { provider?: MockLlama } = {}): Promise<Served> {
  const mock = options.provider ?? llama;
  const dataDir = options.config?.dataDir ?? tempDataDir();
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [localProvider(mock.url, { maxActiveGenerations: 4 })]);
  const { chatui } = testApp({
    ...options,
    config: { provider: providerConfig({ baseUrl: mock.url }), ...options.config, dataDir },
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

async function api(
  base: string,
  session: TestSession,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & { error?: { code: string } } }> {
  const mutation = method !== "GET";
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...session.headers(mutation),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let keySeq = 0;
const key = () => `00000000-0000-4000-9000-${String(++keySeq).padStart(12, "0")}`;

async function settle(s: Served, session: TestSession, generationId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const res = await api(s.base, session, "GET", `/api/generations/${generationId}`);
    if (
      ["completed", "failed", "cancelled", "timed_out"].includes(String(res.body.state)) &&
      res.body.revision
    )
      return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("generation did not settle");
}

async function send(
  s: Served,
  session: TestSession,
  content: string,
  extra: Record<string, unknown> = {},
  model: string = MOCK_MODELS.chat,
) {
  const res = await api(s.base, session, "POST", "/api/generations", {
    providerId: "local",
    model,
    content,
    operationKey: key(),
    operationIssuedAt: new Date().toISOString(),
    ...extra,
  });
  if (res.status === 202) await settle(s, session, String(res.body.generationId));
  return res;
}

async function dto(s: Served, session: TestSession, id: string): Promise<ConversationDto> {
  return (await api(s.base, session, "GET", `/api/conversations/${id}`))
    .body as unknown as ConversationDto;
}

function file(s: Served, session: TestSession, id: string): string {
  return path.join(s.dataDir, session.userId, "chats", `${id}.md`);
}

/** A three-exchange conversation; returns ids and the DTO. */
async function threeTurns(s: Served, session: TestSession) {
  const first = await send(s, session, "one");
  const conversationId = String(first.body.conversationId);
  await send(s, session, "two", { conversationId });
  await send(s, session, "three", { conversationId });
  const conv = await dto(s, session, conversationId);
  const users = conv.messages.filter((m) => m.role === "user");
  return { conversationId, conv, users };
}

function writeModel(s: Served, session: TestSession, id: string, model: ConversationModel) {
  writeFileSync(file(s, session, id), serializeConversation(model));
}

const at = "2026-01-01T00:00:00.000Z";
const u = (id: string, body = "q"): Block => ({ type: "user", id, body });
const a = (id: string, body = "a"): Block => ({ type: "assistant", id, status: "complete", body });
const r = (id: string): Block => ({ type: "reasoning", id, body: "think" });
const sys = (id: string): Block => ({ type: "system", id, body: "rule" });
const model = (blocks: Block[]): ConversationModel => ({
  title: "t",
  createdAt: at,
  updatedAt: at,
  blocks,
});
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("turn grammar (contracts §4.2)", () => {
  it("parses exchanges, mid-conversation system blocks and irregular regions", () => {
    const blocks = [
      sys(ID(1)),
      u(ID(2)),
      r(ID(3)),
      a(ID(3)),
      u(ID(4)),
      u(ID(5)),
      a(ID(6)),
      sys(ID(7)),
      u(ID(8)),
    ];
    expect(segments(blocks).map((s) => `${s.kind}:${String(s.start)}-${String(s.end)}`)).toEqual([
      "system:0-1",
      "exchange:1-4",
      "exchange:4-5",
      "exchange:5-7",
      "system:7-8",
      "exchange:8-9",
    ]);
    // A leading assistant and a second response are irregular.
    expect(segments([a(ID(1)), u(ID(2))]).map((s) => s.kind)).toEqual(["irregular", "exchange"]);
    expect(segments([u(ID(1)), a(ID(2)), a(ID(3)), u(ID(4))]).map((s) => s.kind)).toEqual([
      "irregular",
      "exchange",
    ]);
    expect(segments([u(ID(1)), r(ID(2)), u(ID(3))]).map((s) => s.kind)).toEqual([
      "irregular",
      "exchange",
    ]);
  });

  it("INV-35: edit/regenerate truncation removes every later block, delete keeps them", () => {
    const m = model([u(ID(1)), a(ID(2)), sys(ID(3)), u(ID(4)), a(ID(5))]);
    const edited = truncateAfter(m, ID(1), (b) => ({ ...b, body: "new" }));
    if ("kind" in edited) throw new Error(edited.kind);
    expect(edited.model.blocks).toEqual([{ ...u(ID(1)), body: "new" }]);
    expect(edited.removed.map((b) => b.id)).toEqual([ID(2), ID(3), ID(4), ID(5)]);
    const deleted = deleteExchange(m, ID(1));
    if ("kind" in deleted) throw new Error(deleted.kind);
    expect(deleted.model.blocks.map((b) => b.id)).toEqual([ID(3), ID(4), ID(5)]);
    // An irregular region in the truncation range is refused; deleting a regular exchange before it works.
    const irregular = model([u(ID(1)), a(ID(2)), u(ID(3)), a(ID(4)), a(ID(5))]);
    expect(truncateAfter(irregular, ID(1))).toEqual({ kind: "irregular" });
    expect("kind" in deleteExchange(irregular, ID(1))).toBe(false);
    expect(deleteExchange(irregular, ID(3))).toEqual({ kind: "irregular" });
    expect(truncateAfter(m, ID(9))).toEqual({ kind: "not_found" });
  });

  it("source validity: the user block must survive and the assistant must still answer it", () => {
    const m = model([u(ID(1)), a(ID(2)), u(ID(3))]);
    expect(isSourceValid(m, { userMessageId: ID(1), assistantMessageId: ID(2) })).toBe(true);
    expect(isSourceValid(m, { userMessageId: ID(3) })).toBe(true);
    expect(isSourceValid(m, { userMessageId: ID(3), assistantMessageId: ID(2) })).toBe(false);
    expect(
      isSourceValid(model([u(ID(1))]), { userMessageId: ID(1), assistantMessageId: ID(2) }),
    ).toBe(false);
    expect(isSourceValid(m, { userMessageId: ID(9) })).toBe(false);
  });
});

describe("edit and delete exchange", () => {
  it("INV-35: edit keeps the id and time, truncates downstream (system blocks too) and returns the new revision", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const { conversationId, conv, users } = await threeTurns(s, alice);
    // A mid-conversation system block after the first exchange.
    const parsed = parseConversation(readFileSync(file(s, alice, conversationId), "utf8"));
    if (!parsed.ok) throw new Error(parsed.reason);
    const blocks = [...parsed.conversation.blocks];
    // After the first reply (the mock also writes a reasoning block before it).
    blocks.splice(blocks.findIndex((b) => b.type === "assistant") + 1, 0, sys(randomUUID()));
    writeModel(s, alice, conversationId, { ...parsed.conversation, blocks });
    const fresh = await dto(s, alice, conversationId);
    const target = users[0];
    if (!target) throw new Error("no user turn");
    const res = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${target.id}`,
      {
        content: "one (edited)",
        expectedRevision: fresh.revision,
      },
    );
    expect(res.status).toBe(200);
    const after = res.body as unknown as ConversationDto;
    expect(after.messages).toEqual([
      expect.objectContaining({
        id: target.id,
        role: "user",
        content: "one (edited)",
        time: target.time,
      }),
    ]);
    expect(after.revision).toBe(sha256Hex(readFileSync(file(s, alice, conversationId))));
    // The old revision is now stale: CONFLICT, file unchanged.
    const bytes = readFileSync(file(s, alice, conversationId));
    const stale = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${target.id}`,
      {
        content: "again",
        expectedRevision: conv.revision,
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("CONFLICT");
    expect(readFileSync(file(s, alice, conversationId)).equals(bytes)).toBe(true);
  });

  it("INV-35: delete exchange removes exactly one exchange and keeps later turns and system blocks", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const { conversationId, conv, users } = await threeTurns(s, alice);
    const res = await api(
      s.base,
      alice,
      "DELETE",
      `/api/conversations/${conversationId}/messages/${users[1]?.id ?? ""}?expectedRevision=${conv.revision}`,
    );
    expect(res.status).toBe(200);
    const after = res.body as unknown as ConversationDto;
    expect(after.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "one",
      "three",
    ]);
    expect(after.messages).toHaveLength(4);
  });

  it("irregular layouts are rejected and the file is left unchanged", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const { conversationId } = await threeTurns(s, alice);
    const leading = model([a(ID(1)), u(ID(2)), a(ID(3)), a(ID(4)), u(ID(5))]);
    writeModel(s, alice, conversationId, leading);
    const bytes = readFileSync(file(s, alice, conversationId));
    const revision = sha256Hex(bytes);
    const edit = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${ID(2)}`,
      {
        content: "x",
        expectedRevision: revision,
      },
    );
    expect(edit.status).toBe(400);
    expect(edit.body.error?.code).toBe("VALIDATION");
    const del = await api(
      s.base,
      alice,
      "DELETE",
      `/api/conversations/${conversationId}/messages/${ID(2)}?expectedRevision=${revision}`,
    );
    expect(del.status).toBe(400);
    expect(readFileSync(file(s, alice, conversationId)).equals(bytes)).toBe(true);
    // The trailing regular exchange can still be edited and the file still sends.
    const ok = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${ID(5)}`,
      {
        content: "fine",
        expectedRevision: revision,
      },
    );
    expect(ok.status).toBe(200);
  });

  it("a running generation blocks mutations (GENERATION_IN_PROGRESS); cancel → terminal → mutation works", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const first = await send(s, alice, "one");
    const conversationId = String(first.body.conversationId);
    const running = await api(s.base, alice, "POST", "/api/generations", {
      conversationId,
      providerId: "local",
      model: MOCK_MODELS.slow,
      content: "slow",
      operationKey: key(),
      operationIssuedAt: new Date().toISOString(),
    });
    expect(running.status).toBe(202);
    const conv = await dto(s, alice, conversationId);
    const target = conv.messages.find((m) => m.role === "user");
    const blocked = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${target?.id ?? ""}`,
      {
        content: "x",
        expectedRevision: conv.revision,
      },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.code).toBe("GENERATION_IN_PROGRESS");
    await api(
      s.base,
      alice,
      "POST",
      `/api/generations/${String(running.body.generationId)}/cancel`,
    );
    const after = await dto(s, alice, conversationId);
    expect(after.messages.at(-1)).toMatchObject({ role: "assistant", status: "cancelled" });
    const edit = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${target?.id ?? ""}`,
      {
        content: "x",
        expectedRevision: after.revision,
      },
    );
    expect(edit.status).toBe(200);
  });

  it("attachments of removed turns are deleted after the Markdown; retained ones stay linked", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const upload = async (name: string) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(png())]), name);
      const res = await fetch(`${s.base}/api/attachments`, {
        method: "POST",
        headers: alice.headers(true),
        body: form,
      });
      return ((await res.json()) as { id: string }).id;
    };
    const keep = await upload("keep.png");
    const first = await send(s, alice, "one", { attachmentIds: [keep] }, MOCK_MODELS.vision);
    const conversationId = String(first.body.conversationId);
    const drop = await upload("drop.png");
    await send(s, alice, "two", { conversationId, attachmentIds: [drop] }, MOCK_MODELS.vision);
    const conv = await dto(s, alice, conversationId);
    const firstUser = conv.messages.find((m) => m.role === "user");
    const res = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${firstUser?.id ?? ""}`,
      {
        content: "one edited",
        expectedRevision: conv.revision,
      },
    );
    expect(res.status).toBe(200);
    const dirs = readdirSync(path.join(s.dataDir, alice.userId, "attachments"));
    expect(dirs).toEqual([keep]);
    expect((res.body as unknown as ConversationDto).messages[0]?.attachments[0]).toMatchObject({
      id: keep,
      missing: false,
    });
    // Editing can drop an attachment and add a pending one.
    const added = await upload("new.png");
    const edited = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${firstUser?.id ?? ""}`,
      {
        content: "with new",
        attachmentIds: [added],
        expectedRevision: (res.body as unknown as ConversationDto).revision,
      },
    );
    expect(edited.status).toBe(200);
    expect(readdirSync(path.join(s.dataDir, alice.userId, "attachments"))).toEqual([added]);
    const meta = JSON.parse(
      readFileSync(path.join(s.dataDir, alice.userId, "attachments", added, "meta.json"), "utf8"),
    ) as { messageId: string };
    expect(meta.messageId).toBe(firstUser?.id);
  });
});

describe("regenerate (contracts §4.1, §4.2)", () => {
  it("INV-35: fresh generation and assistant ids, no duplicate user block, downstream removed", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const { conversationId, conv, users } = await threeTurns(s, alice);
    const target = users[0];
    const oldReply = conv.messages[1];
    const res = await api(
      s.base,
      alice,
      "POST",
      `/api/conversations/${conversationId}/regenerate`,
      {
        userMessageId: target?.id,
        providerId: "local",
        model: MOCK_MODELS.chat,
        expectedRevision: conv.revision,
        operationKey: key(),
        operationIssuedAt: new Date().toISOString(),
      },
    );
    expect(res.status).toBe(202);
    expect(res.body.userMessageId).toBe(target?.id);
    expect(res.body.assistantMessageId).not.toBe(oldReply?.id);
    await settle(s, alice, String(res.body.generationId));
    const after = await dto(s, alice, conversationId);
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(after.messages[0]?.id).toBe(target?.id);
    expect(after.messages[1]?.id).toBe(res.body.assistantMessageId);
    expect(after.messages[1]?.content).toBe("Echo: one");
  });

  it("works on an unanswered turn; the same operation key never truncates twice", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const first = await send(s, alice, "one");
    const conversationId = String(first.body.conversationId);
    const parsed = parseConversation(readFileSync(file(s, alice, conversationId), "utf8"));
    if (!parsed.ok) throw new Error(parsed.reason);
    const userId = parsed.conversation.blocks[0]?.id ?? "";
    writeModel(s, alice, conversationId, {
      ...parsed.conversation,
      blocks: parsed.conversation.blocks.slice(0, 1),
    });
    const revision = sha256Hex(readFileSync(file(s, alice, conversationId)));
    const body = {
      userMessageId: userId,
      providerId: "local",
      model: MOCK_MODELS.chat,
      expectedRevision: revision,
      operationKey: key(),
      operationIssuedAt: new Date().toISOString(),
    };
    const once = await api(
      s.base,
      alice,
      "POST",
      `/api/conversations/${conversationId}/regenerate`,
      body,
    );
    expect(once.status).toBe(202);
    await settle(s, alice, String(once.body.generationId));
    // A lost 202: the same request with the same key returns the original result.
    const again = await api(
      s.base,
      alice,
      "POST",
      `/api/conversations/${conversationId}/regenerate`,
      body,
    );
    expect(again.status).toBe(202);
    expect(again.body).toEqual(once.body);
    const mismatch = await api(
      s.base,
      alice,
      "POST",
      `/api/conversations/${conversationId}/regenerate`,
      {
        ...body,
        model: MOCK_MODELS.slow,
      },
    );
    expect(mismatch.body.error?.code).toBe("OPERATION_KEY_MISMATCH");
    expect((await dto(s, alice, conversationId)).messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("an unreachable provider or a capability rejection leaves the conversation untruncated", async () => {
    const down = await startMockLlama();
    const s = await serve({ provider: down });
    const alice = await signIn(s.base, s.chatui);
    const first = await send(s, alice, "one");
    const conversationId = String(first.body.conversationId);
    await send(s, alice, "two", { conversationId });
    const conv = await dto(s, alice, conversationId);
    const bytes = readFileSync(file(s, alice, conversationId));
    await down.close(); // the model list stays cached; the fresh contact fails
    const res = await api(
      s.base,
      alice,
      "POST",
      `/api/conversations/${conversationId}/regenerate`,
      {
        userMessageId: conv.messages[0]?.id,
        providerId: "local",
        model: MOCK_MODELS.chat,
        expectedRevision: conv.revision,
        operationKey: key(),
        operationIssuedAt: new Date().toISOString(),
      },
    );
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(readFileSync(file(s, alice, conversationId)).equals(bytes)).toBe(true);
  });

  it("INV-44: regenerating a turn with an image on a text-only model is refused unchanged", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png())]), "p.png");
    const up = (await (
      await fetch(`${s.base}/api/attachments`, {
        method: "POST",
        headers: alice.headers(true),
        body: form,
      })
    ).json()) as { id: string };
    const first = await send(s, alice, "look", { attachmentIds: [up.id] }, MOCK_MODELS.vision);
    const conversationId = String(first.body.conversationId);
    const conv = await dto(s, alice, conversationId);
    const bytes = readFileSync(file(s, alice, conversationId));
    const res = await api(
      s.base,
      alice,
      "POST",
      `/api/conversations/${conversationId}/regenerate`,
      {
        userMessageId: conv.messages[0]?.id,
        providerId: "local",
        model: MOCK_MODELS.chat,
        expectedRevision: conv.revision,
        operationKey: key(),
        operationIssuedAt: new Date().toISOString(),
      },
    );
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("MODEL_CAPABILITY_UNSUPPORTED");
    expect(readFileSync(file(s, alice, conversationId)).equals(bytes)).toBe(true);
  });

  it("edit → regenerate with an intervening change returns CONFLICT and keeps the edited turn", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const { conversationId, conv, users } = await threeTurns(s, alice);
    const target = users[0];
    const edit = await api(
      s.base,
      alice,
      "PATCH",
      `/api/conversations/${conversationId}/messages/${target?.id ?? ""}`,
      {
        content: "edited",
        expectedRevision: conv.revision,
      },
    );
    const edited = edit.body as unknown as ConversationDto;
    // Someone renames the conversation in between.
    await api(s.base, alice, "PATCH", `/api/conversations/${conversationId}`, { title: "Renamed" });
    const res = await api(
      s.base,
      alice,
      "POST",
      `/api/conversations/${conversationId}/regenerate`,
      {
        userMessageId: target?.id,
        providerId: "local",
        model: MOCK_MODELS.chat,
        expectedRevision: edited.revision,
        operationKey: key(),
        operationIssuedAt: new Date().toISOString(),
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("CONFLICT");
    const after = await dto(s, alice, conversationId);
    expect(after.messages).toEqual([
      expect.objectContaining({ id: target?.id, content: "edited" }),
    ]);
  });

  it("a crash during a regeneration's acceptance is resolved by hashes; the reply is written once", async () => {
    const dataDir = tempDataDir();
    let crash = false;
    const first = await serve({
      config: { dataDir },
      send: {
        hooks: {
          afterMarkdownWrite: () => {
            if (crash) throw new Error("simulated crash");
          },
        },
      },
    });
    const alice = await signIn(first.base, first.chatui);
    const { conversationId, conv, users } = await threeTurns(first, alice);
    crash = true;
    const res = await api(
      first.base,
      alice,
      "POST",
      `/api/conversations/${conversationId}/regenerate`,
      {
        userMessageId: users[1]?.id,
        providerId: "local",
        model: MOCK_MODELS.chat,
        expectedRevision: conv.revision,
        operationKey: key(),
        operationIssuedAt: new Date().toISOString(),
      },
    );
    expect(res.status).toBe(500);
    await first.chatui.shutdown();
    const second = await serve({ config: { dataDir } });
    const report = await second.chatui.ready;
    expect(report.generations?.orphanCommits).toBe(1);
    const after = await dto(second, alice, conversationId);
    expect(after.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:one",
      "assistant:Echo: one",
      "user:two",
      "assistant:",
    ]);
    expect(after.messages.at(-1)?.status).toBe("interrupted");
  });

  it("INV-35: a late reply for a superseded turn is never written (recovery)", async () => {
    const dataDir = tempDataDir();
    const first = await serve({ config: { dataDir } });
    const alice = await signIn(first.base, first.chatui);
    const { conversationId } = await threeTurns(first, alice);
    const before = readFileSync(path.join(dataDir, alice.userId, "chats", `${conversationId}.md`));
    // A leftover `running` checkpoint whose source user block is gone.
    const operationKey = randomUUID();
    const generationId = randomUUID();
    const opsDir = path.join(dataDir, alice.userId, "operations");
    writeFileSync(
      path.join(opsDir, `${sha256Hex(`${alice.userId}:${operationKey}`)}.json`),
      JSON.stringify({
        version: 1,
        operationKey,
        payloadHash: "x",
        conversationId,
        generationId,
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        beforeHash: null,
        afterHash: "a".repeat(64),
        status: "committed",
        terminalWritten: false,
        issuedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
      }),
    );
    mkdirSync(path.join(dataDir, "_system", "generations"), { recursive: true });
    writeFileSync(
      path.join(dataDir, "_system", "generations", `${generationId}.json`),
      JSON.stringify({
        version: 1,
        generationId,
        userId: alice.userId,
        conversationId,
        assistantMessageId: randomUUID(),
        operationKey,
        providerId: "local",
        model: "m",
        state: "running",
        content: "stale partial",
        reasoning: "",
        lastEventId: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        outcome: null,
      }),
    );
    await first.chatui.shutdown();
    const second = await serve({ config: { dataDir } });
    const report = await second.chatui.ready;
    expect(report.generations?.discarded).toBe(1);
    expect(
      readFileSync(path.join(dataDir, alice.userId, "chats", `${conversationId}.md`)).equals(
        before,
      ),
    ).toBe(true);
  });
});

describe("INV-36: search", () => {
  it("is user-scoped, case-insensitive, bounded, navigates to message ids and tolerates malformed files", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const bob = await signIn(s.base, s.chatui, "bob");
    const first = await send(s, alice, "Where is the Ünicode NEEDLE hidden?");
    const conversationId = String(first.body.conversationId);
    await send(s, bob, "bob also has a needle");
    const res = await api(s.base, alice, "GET", "/api/search?q=%C3%BCnicode%20needle");
    expect(res.status).toBe(200);
    const body = res.body as unknown as SearchResponse;
    const conv = await dto(s, alice, conversationId);
    // The auto-title (from the first message) matches first, then the messages.
    expect(body.results.map((x) => x.messageId)).toEqual([
      null,
      conv.messages[0]?.id,
      conv.messages[1]?.id,
    ]);
    expect(body.results[1]).toMatchObject({
      conversationId,
      role: "user",
      snippet: { before: "Where is the ", match: "Ünicode NEEDLE", after: " hidden?" },
    });
    // Bob's conversations are never searched for Alice.
    const bobs = (await api(s.base, alice, "GET", "/api/search?q=bob%20also"))
      .body as unknown as SearchResponse;
    expect(bobs.results).toEqual([]);
    // A malformed file is skipped and counted; other results still come back.
    mkdirSync(path.join(s.dataDir, alice.userId, "chats"), { recursive: true });
    writeFileSync(
      path.join(s.dataDir, alice.userId, "chats", `${randomUUID()}.md`),
      "not a conversation needle",
    );
    await s.chatui.services.admin.rebuildIndex(alice.userId);
    const tolerant = (await api(s.base, alice, "GET", "/api/search?q=needle"))
      .body as unknown as SearchResponse;
    expect(tolerant.skippedMalformed).toBe(1);
    expect(tolerant.results.length).toBeGreaterThan(0);
    // Limits.
    for (let i = 0; i < 4; i++) await send(s, alice, `needle ${String(i)}`);
    const limited = (await api(s.base, alice, "GET", "/api/search?q=needle&limit=2"))
      .body as unknown as SearchResponse;
    expect(limited.results).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    expect((await api(s.base, alice, "GET", `/api/search?q=${"x".repeat(201)}`)).status).toBe(400);
    expect((await api(s.base, alice, "GET", "/api/search?q=%20%20")).status).toBe(400);
    expect((await api(s.base, alice, "GET", "/api/search?q=x&limit=51")).status).toBe(400);
    // Regex metacharacters are literal.
    expect(
      ((await api(s.base, alice, "GET", "/api/search?q=.*")).body as unknown as SearchResponse)
        .results,
    ).toEqual([]);
  });
});

describe("pins and clear history", () => {
  it("INV-34: pins keep their order and other preferences, survive an index rebuild, and go with the conversation", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const ids: string[] = [];
    for (const text of ["a", "b", "c"])
      ids.push(String((await send(s, alice, text)).body.conversationId));
    await api(s.base, alice, "PATCH", "/api/preferences", { historyImages: "omit" });
    for (const id of [ids[2], ids[0]])
      expect((await api(s.base, alice, "PUT", `/api/conversations/${id ?? ""}/pin`)).status).toBe(
        200,
      );
    const pinned = await api(s.base, alice, "PUT", `/api/conversations/${ids[1] ?? ""}/pin`);
    expect(pinned.body.pins).toEqual([ids[2], ids[0], ids[1]]);
    expect((await api(s.base, alice, "PUT", `/api/conversations/${randomUUID()}/pin`)).status).toBe(
      404,
    );
    const unpinned = await api(s.base, alice, "DELETE", `/api/conversations/${ids[0] ?? ""}/pin`);
    expect(unpinned.body.pins).toEqual([ids[2], ids[1]]);
    await s.chatui.services.admin.rebuildIndex(alice.userId);
    const prefs = await api(s.base, alice, "GET", "/api/preferences");
    expect(prefs.body).toMatchObject({ pins: [ids[2], ids[1]], historyImages: "omit" });
    await api(s.base, alice, "DELETE", `/api/conversations/${ids[2] ?? ""}`);
    expect((await api(s.base, alice, "GET", "/api/preferences")).body.pins).toEqual([ids[1]]);
  });

  it("clear history deletes every conversation and its attachments, keeps other preferences and other users", async () => {
    const s = await serve();
    const alice = await signIn(s.base, s.chatui);
    const bob = await signIn(s.base, s.chatui, "bob");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png())]), "p.png");
    const up = (await (
      await fetch(`${s.base}/api/attachments`, {
        method: "POST",
        headers: alice.headers(true),
        body: form,
      })
    ).json()) as { id: string };
    const first = await send(s, alice, "one", { attachmentIds: [up.id] }, MOCK_MODELS.vision);
    await send(s, alice, "two");
    await send(s, bob, "bob's");
    await api(s.base, alice, "PUT", `/api/conversations/${String(first.body.conversationId)}/pin`);
    await api(s.base, alice, "PATCH", "/api/preferences", { imageMaxEdge: 1024 });
    const res = await api(s.base, alice, "DELETE", "/api/conversations");
    expect(res.body).toEqual({ deleted: 2 });
    expect((await api(s.base, alice, "GET", "/api/conversations")).body.conversations).toEqual([]);
    expect(readdirSync(path.join(s.dataDir, alice.userId, "attachments"))).toEqual([]);
    expect((await api(s.base, alice, "GET", "/api/preferences")).body).toMatchObject({
      pins: [],
      imageMaxEdge: 1024,
    });
    expect(
      ((await api(s.base, bob, "GET", "/api/conversations")).body.conversations as unknown[])
        .length,
    ).toBe(1);
  });
});

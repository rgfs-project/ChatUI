import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationDto } from "@shared/conversations";
import type { GenerationSnapshot } from "@shared/generations";
import type { ChatUiApp } from "../../server/create-app.ts";
import { parseConversation } from "../../server/storage/markdown.ts";
import { sha256Hex } from "../../server/storage/operations.ts";
import type { Provider } from "../../server/providers/types.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { readSse } from "../support/sse-client.ts";
import {
  signIn,
  type TestSession,
  providerConfig,
  storageConfig,
  tempDataDir,
  testApp,
  type TestAppOptions,
} from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ chunkDelayMs: 30, slowChunks: 10 });
});
afterAll(async () => {
  await llama.close();
});

interface Running {
  base: string;
  chatui: ChatUiApp;
  dataDir: string;
  logs: ReturnType<typeof testApp>["logs"];
  session: TestSession;
}
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

async function start(
  options: TestAppOptions & {
    dataDir?: string;
    storage?: Parameters<typeof storageConfig>[0];
  } = {},
) {
  const dataDir = options.dataDir ?? tempDataDir();
  const { storage, ...rest } = options;
  const { chatui, logs } = testApp({
    ...rest,
    config: {
      dataDir,
      storage: storageConfig(storage),
      provider: providerConfig({ baseUrl: llama.url, maxActiveGenerations: 4 }),
      ...options.config,
    },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, chatui, dataDir, logs, session: await signIn(base, chatui) } satisfies Running;
}

async function stop(run: Running) {
  const index = servers.findIndex((s) => s.chatui === run.chatui);
  const [entry] = servers.splice(index, 1);
  if (!entry) return;
  await entry.chatui.shutdown();
  entry.server.closeAllConnections();
  await new Promise<void>((resolve) =>
    entry.server.close(() => {
      resolve();
    }),
  );
}

async function api(run: Running, method: string, url: string, body?: unknown) {
  const res = await fetch(`${run.base}${url}`, {
    method,
    headers: {
      ...run.session.headers(method !== "GET"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown> & { error?: { code: string } },
  };
}

function sendBody(content: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: "local",
    model: MOCK_MODELS.chat,
    content,
    operationKey: randomUUID(),
    operationIssuedAt: new Date().toISOString(),
    ...extra,
  };
}

const chatFile = (run: Running, id: string) =>
  path.join(run.dataDir, run.session.userId, "chats", `${id}.md`);
const readModel = (run: Running, id: string) => {
  const parsed = parseConversation(readFileSync(chatFile(run, id), "utf8"));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.conversation;
};

async function waitTerminal(run: Running, generationId: string) {
  await run.chatui.services.generations.settled(generationId);
  return (await api(run, "GET", `/api/generations/${generationId}`))
    .body as unknown as GenerationSnapshot;
}

describe("conversations API", () => {
  it("creates, lists, reads, renames and deletes", async () => {
    const run = await start();
    const created = await api(run, "POST", "/api/conversations", {});
    expect(created.status).toBe(201);
    const dto = created.body as unknown as ConversationDto;
    expect(dto).toMatchObject({ title: "New conversation", messages: [], activeGeneration: null });
    expect(dto.createdAt).toBe(dto.updatedAt);
    expect(dto.revision).toBe(sha256Hex(readFileSync(chatFile(run, dto.id))));

    const listed = await api(run, "GET", "/api/conversations");
    expect(listed.body.conversations).toEqual([
      {
        id: dto.id,
        title: "New conversation",
        createdAt: dto.createdAt,
        updatedAt: dto.updatedAt,
        messageCount: 0,
        malformed: false,
      },
    ]);

    const renamed = await api(run, "PATCH", `/api/conversations/${dto.id}`, { title: "Trip" });
    expect(renamed.body).toMatchObject({ title: "Trip", createdAt: dto.createdAt });
    expect(renamed.body.revision).toBe(sha256Hex(readFileSync(chatFile(run, dto.id))));
    expect(renamed.body.revision).not.toBe(dto.revision);

    const stale = await api(run, "PATCH", `/api/conversations/${dto.id}`, {
      title: "X",
      expectedRevision: dto.revision,
    });
    expect(stale.body.error?.code).toBe("CONFLICT");

    expect((await api(run, "DELETE", `/api/conversations/${dto.id}`)).status).toBe(200);
    expect((await api(run, "GET", "/api/conversations")).body.conversations).toEqual([]);
    expect((await api(run, "GET", `/api/conversations/${dto.id}`)).status).toBe(404);
    expect((await api(run, "DELETE", `/api/conversations/${dto.id}`)).status).toBe(404);
  });

  it("rejects client-supplied timestamps and invalid titles", async () => {
    const run = await start();
    const { body } = await api(run, "POST", "/api/conversations", {});
    for (const payload of [
      { title: "t", createdAt: "2020-01-01T00:00:00.000Z" },
      { title: "t", updatedAt: "2020-01-01T00:00:00.000Z" },
      { title: "" },
      { title: "a\nb" },
      { title: "x".repeat(201) },
    ]) {
      expect(
        (await api(run, "PATCH", `/api/conversations/${body.id as string}`, payload)).status,
      ).toBe(400);
    }
    expect((await api(run, "POST", "/api/conversations", { createdAt: "x" })).status).toBe(400);
  });

  it("INV-12: path-like ids are rejected before touching storage", async () => {
    const run = await start();
    for (const bad of ["..%2F..%2Fetc", "NOT-A-UUID", run.session.userId.toUpperCase()]) {
      const res = await api(run, "GET", `/api/conversations/${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error?.code).toBe("VALIDATION");
    }
  });

  it("INV-10: a malformed conversation stays listed, refuses GET/PATCH/send, can be deleted, and never breaks others", async () => {
    const run = await start();
    const bad = (await api(run, "POST", "/api/conversations", { title: "bad" })).body.id as string;
    const good = (await api(run, "POST", "/api/conversations", { title: "good" })).body
      .id as string;
    writeFileSync(chatFile(run, bad), "---\nnot: valid\n---\n");
    const restarted = await start({ dataDir: run.dataDir });
    // Force a rebuild the way startup does when the index is dirty.
    writeFileSync(path.join(run.dataDir, run.session.userId, "index", "chats.dirty"), "");
    await stop(restarted);
    const again = await start({ dataDir: run.dataDir });
    const entries = (await api(again, "GET", "/api/conversations")).body.conversations as {
      id: string;
      malformed: boolean;
    }[];
    expect(entries.find((e) => e.id === bad)?.malformed).toBe(true);
    expect((await api(again, "GET", `/api/conversations/${bad}`)).body.error?.code).toBe(
      "CONVERSATION_MALFORMED",
    );
    expect(
      (await api(again, "PATCH", `/api/conversations/${bad}`, { title: "x" })).body.error?.code,
    ).toBe("CONVERSATION_MALFORMED");
    const send = await api(
      again,
      "POST",
      "/api/generations",
      sendBody("hi", { conversationId: bad }),
    );
    expect(send.body.error?.code).toBe("CONVERSATION_MALFORMED");
    expect(readFileSync(chatFile(run, bad), "utf8")).toBe("---\nnot: valid\n---\n");
    expect((await api(again, "GET", `/api/conversations/${good}`)).status).toBe(200);
    expect((await api(again, "DELETE", `/api/conversations/${bad}`)).status).toBe(200);
    expect(existsSync(chatFile(run, bad))).toBe(false);
  });
});

describe("send and persistence", () => {
  it("INV-08/INV-07: the user block is durable before 202; the assistant is written exactly once", async () => {
    const run = await start();
    const res = await api(run, "POST", "/api/generations", sendBody("hello there"));
    expect(res.status).toBe(202);
    const { conversationId, userMessageId, assistantMessageId, generationId } = res.body as Record<
      string,
      string
    >;
    const atAccept = readModel(run, conversationId ?? "");
    expect(atAccept.blocks).toEqual([
      { type: "user", id: userMessageId, time: expect.any(String) as string, body: "hello there" },
    ]);

    const snapshot = await waitTerminal(run, generationId ?? "");
    const final = readModel(run, conversationId ?? "");
    expect(final.blocks.map((b) => b.type)).toEqual(["user", "reasoning", "assistant"]);
    const assistantBlock = final.blocks[2];
    expect(assistantBlock).toMatchObject({
      id: assistantMessageId,
      status: "complete",
      provider: "local",
      model: MOCK_MODELS.chat,
      body: "Echo: hello there",
    });
    expect(final.blocks[1]).toMatchObject({
      id: assistantMessageId,
      body: "Considering the request.",
    });
    expect(final.blocks.filter((b) => b.type === "assistant")).toHaveLength(1);
    // Revision after the write (and auto-title) is in the terminal snapshot and the DTO.
    const fileHash = sha256Hex(readFileSync(chatFile(run, conversationId ?? "")));
    expect(snapshot.revision).toBe(fileHash);
    const dto = (await api(run, "GET", `/api/conversations/${conversationId ?? ""}`))
      .body as unknown as ConversationDto;
    expect(dto.revision).toBe(fileHash);
    expect(dto.title).toBe("hello there");
    expect(dto.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(dto.messages[1]).toMatchObject({
      reasoning: "Considering the request.",
      status: "complete",
    });
  });

  it("the terminal SSE event carries the post-write revision", async () => {
    const run = await start();
    const res = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("sse revision", { model: MOCK_MODELS.slow }),
    );
    const sse = await readSse(
      `${run.base}/api/generations/${res.body.generationId as string}/stream`,
      { headers: run.session.headers() },
    );
    const terminal = sse.frames.at(-1);
    expect(terminal?.event).toBe("terminal");
    expect((terminal?.data as { revision: string }).revision).toBe(
      sha256Hex(readFileSync(chatFile(run, res.body.conversationId as string))),
    );
  });

  it("new-block timestamps: user = acceptance time, assistant = terminal time", async () => {
    let clock = Date.now();
    const run = await start({ now: () => new Date((clock += 1000)) });
    const res = await api(run, "POST", "/api/generations", sendBody("time me"));
    await waitTerminal(run, res.body.generationId as string);
    const blocks = readModel(run, res.body.conversationId as string).blocks;
    const userTime = Date.parse((blocks[0] as { time: string }).time);
    const assistantTime = Date.parse((blocks[2] as { time: string }).time);
    expect(assistantTime).toBeGreaterThan(userTime);
  });

  it("INV-13: a second send while a reply is running is GENERATION_IN_PROGRESS and persists nothing", async () => {
    const run = await start();
    const first = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("one", { model: MOCK_MODELS.slow }),
    );
    const id = first.body.conversationId as string;
    const before = readFileSync(chatFile(run, id), "utf8");
    const second = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("two", { conversationId: id }),
    );
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe("GENERATION_IN_PROGRESS");
    expect(readFileSync(chatFile(run, id), "utf8")).toBe(before);
    const dto = (await api(run, "GET", `/api/conversations/${id}`))
      .body as unknown as ConversationDto;
    expect(dto.activeGeneration?.generationId).toBe(first.body.generationId);
    await waitTerminal(run, first.body.generationId as string);
  });

  it("server-side history: the next send includes earlier turns from storage", async () => {
    const run = await start();
    const first = await api(run, "POST", "/api/generations", sendBody("first question"));
    await waitTerminal(run, first.body.generationId as string);
    const second = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("second", { conversationId: first.body.conversationId }),
    );
    await waitTerminal(run, second.body.generationId as string);
    const sent = llama.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body as {
      messages: { role: string; content: string }[];
    };
    expect(sent.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Echo: first question" },
      { role: "user", content: "second" },
    ]);
  });

  it("first-send rejections leave no conversation behind", async () => {
    const run = await start();
    expect(
      (await api(run, "POST", "/api/generations", sendBody("x", { model: "nope" }))).body.error
        ?.code,
    ).toBe("MODEL_NOT_FOUND");
    const tooLong = await api(run, "POST", "/api/generations", sendBody("y".repeat(99_000)));
    expect(tooLong.body.error?.code).toBe("CONTEXT_TOO_LARGE");
    expect((await api(run, "GET", "/api/conversations")).body.conversations).toEqual([]);
    expect(
      readdirSync(path.join(run.dataDir, run.session.userId)).filter(
        (n) => n === "chats" || n === "operations",
      ),
    ).toEqual([]);
  });

  it("no lock is held while talking to the provider", async () => {
    let violations = 0;
    const storeRef: { current: ChatUiApp["services"]["conversations"] | undefined } = {
      current: undefined,
    };
    const real = (await import("../../server/providers/llamacpp.ts")).createLlamaCppProvider({
      baseUrl: llama.url,
      apiKey: undefined,
      timeoutMs: 5_000,
      maxResponseBytes: 1024 * 1024,
    });
    const check = () => {
      if ((storeRef.current?.heldLocks ?? 0) > 0) violations++;
    };
    const provider: Provider = {
      listModels: (s) => (check(), real.listModels(s)),
      discoverSlots: (s) => (check(), real.discoverSlots(s)),
      tokenize: (m, t, o) => (check(), real.tokenize(m, t, o)),
      applyTemplate: (m, msgs) => (check(), real.applyTemplate(m, msgs)),
      streamChat: (r, s) => (check(), real.streamChat(r, s)),
    };
    const run = await start({ providerFactory: () => provider });
    storeRef.current = run.chatui.services.conversations;
    const first = await api(run, "POST", "/api/generations", sendBody("a"));
    await waitTerminal(run, first.body.generationId as string);
    const second = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("b", { conversationId: first.body.conversationId }),
    );
    await waitTerminal(run, second.body.generationId as string);
    expect(violations).toBe(0);
  });

  it("revision race: one concurrent change is absorbed by recomputing; a second returns CONFLICT without mutation", async () => {
    let changes = 0;
    const target: { rename?: () => Promise<unknown> } = {};
    const run = await start({
      send: {
        hooks: {
          beforeRecheck: async () => {
            if (changes-- > 0) await target.rename?.();
          },
        },
      },
    });
    const created = (await api(run, "POST", "/api/conversations", {})).body.id as string;
    let n = 0;
    target.rename = () =>
      run.chatui.services.conversations.rename(
        run.session.userId,
        created,
        `renamed ${String(n++)}`,
      );

    changes = 1;
    const once = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("ok", { conversationId: created }),
    );
    expect(once.status).toBe(202);
    await waitTerminal(run, once.body.generationId as string);

    changes = 2;
    const before = readFileSync(chatFile(run, created), "utf8");
    const twice = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("conflict", { conversationId: created }),
    );
    expect(twice.body.error?.code).toBe("CONFLICT");
    const after = readModel(run, created);
    expect(after.blocks).toEqual(
      parseConversation(before).ok ? readModel(run, created).blocks : [],
    );
    expect(after.blocks.filter((b) => b.type === "user")).toHaveLength(1);
  });

  it("deleting a conversation mid-generation discards the reply instead of resurrecting it", async () => {
    const run = await start();
    const res = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("doomed", { model: MOCK_MODELS.slow }),
    );
    const id = res.body.conversationId as string;
    expect((await api(run, "DELETE", `/api/conversations/${id}`)).status).toBe(200);
    expect((await api(run, "GET", "/api/conversations")).body.conversations).toEqual([]);
    const snapshot = await waitTerminal(run, res.body.generationId as string);
    expect(snapshot.state).toBe("completed");
    expect(snapshot.revision).toBeNull();
    expect(existsSync(chatFile(run, id))).toBe(false);
    expect(JSON.stringify(run.logs.lines())).toContain("conversation was deleted");
  });

  it("restart persistence: conversations survive and the index rebuilds after deletion", async () => {
    const run = await start();
    const res = await api(run, "POST", "/api/generations", sendBody("persist me"));
    await waitTerminal(run, res.body.generationId as string);
    await stop(run);
    const { rmSync } = await import("node:fs");
    rmSync(path.join(run.dataDir, run.session.userId, "index"), { recursive: true, force: true });
    const again = await start({ dataDir: run.dataDir });
    const list = (await api(again, "GET", "/api/conversations")).body.conversations as {
      title: string;
      messageCount: number;
    }[];
    expect(list).toEqual([expect.objectContaining({ title: "persist me", messageCount: 2 })]);
  });
});

describe("auto-title (contracts §3.3)", () => {
  it("sets the title at a complete reply only while it is the sentinel; renaming to the sentinel re-enables it", async () => {
    const run = await start();
    const failed = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("will fail", { model: MOCK_MODELS.error500 }),
    );
    const id = failed.body.conversationId as string;
    await waitTerminal(run, failed.body.generationId as string);
    expect(readModel(run, id).title).toBe("New conversation");

    const ok = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("second message", { conversationId: id }),
    );
    await waitTerminal(run, ok.body.generationId as string);
    expect(readModel(run, id).title).toBe("will fail");

    await api(run, "PATCH", `/api/conversations/${id}`, { title: "Custom" });
    const keep = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("third", { conversationId: id }),
    );
    await waitTerminal(run, keep.body.generationId as string);
    expect(readModel(run, id).title).toBe("Custom");

    await api(run, "PATCH", `/api/conversations/${id}`, { title: "New conversation" });
    // Deleting the first reply (by hand edit here) does not block auto-titling.
    const edited = readFileSync(chatFile(run, id), "utf8").replace(
      /<!-- cc:assistant[^\n]*-->\n\n/,
      "",
    );
    writeFileSync(chatFile(run, id), edited);
    const retitle = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("fourth", { conversationId: id }),
    );
    await waitTerminal(run, retitle.body.generationId as string);
    expect(readModel(run, id).title).toBe("will fail");
  });

  it("truncates to 60 characters at a word boundary on one line", async () => {
    const run = await start();
    const text =
      "Plan a three week trip through Japan in spring\nwith kids, trains and lots of food stops";
    const res = await api(run, "POST", "/api/generations", sendBody(text));
    await waitTerminal(run, res.body.generationId as string);
    const title = readModel(run, res.body.conversationId as string).title;
    expect(title).toBe("Plan a three week trip through Japan in spring with kids,");
    expect(Array.from(title).length).toBeLessThanOrEqual(60);
  });
});

describe("INV-58: operation keys", () => {
  it("resending the same key and payload returns the original 202 (even while running) and lookup finds it", async () => {
    const run = await start();
    const body = sendBody("idempotent", { model: MOCK_MODELS.slow });
    const first = await api(run, "POST", "/api/generations", body);
    const retry = await api(run, "POST", "/api/generations", body);
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual(first.body);
    const lookup = await api(run, "GET", `/api/operations/${body.operationKey}`);
    expect(lookup.body).toEqual(first.body);
    await waitTerminal(run, first.body.generationId as string);
    expect(
      readModel(run, first.body.conversationId as string).blocks.filter((b) => b.type === "user"),
    ).toHaveLength(1);
    expect((await api(run, "GET", `/api/operations/${randomUUID()}`)).status).toBe(404);
  });

  it("concurrent duplicates with one key produce exactly one send", async () => {
    const run = await start();
    const body = sendBody("race", { model: MOCK_MODELS.slow });
    const results = await Promise.all(
      [1, 2, 3].map(() => api(run, "POST", "/api/generations", body)),
    );
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((await api(run, "GET", "/api/conversations")).body.conversations).toHaveLength(1);
    await waitTerminal(run, results[0]?.body.generationId as string);
  });

  it("two tabs sending identical text with different keys produce two sends", async () => {
    const run = await start();
    const a = await api(run, "POST", "/api/generations", sendBody("same text"));
    await waitTerminal(run, a.body.generationId as string);
    const b = await api(
      run,
      "POST",
      "/api/generations",
      sendBody("same text", { conversationId: a.body.conversationId }),
    );
    await waitTerminal(run, b.body.generationId as string);
    expect(b.body.generationId).not.toBe(a.body.generationId);
    expect(
      readModel(run, a.body.conversationId as string).blocks.filter((x) => x.type === "user"),
    ).toHaveLength(2);
  });

  it("same key with a different payload is OPERATION_KEY_MISMATCH", async () => {
    const run = await start();
    const body = sendBody("original");
    const first = await api(run, "POST", "/api/generations", body);
    await waitTerminal(run, first.body.generationId as string);
    const mismatch = await api(run, "POST", "/api/generations", { ...body, content: "changed" });
    expect(mismatch.body.error?.code).toBe("OPERATION_KEY_MISMATCH");
  });

  it("an old or future operationIssuedAt is OPERATION_EXPIRED with no mutation", async () => {
    const run = await start();
    for (const issued of [
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
      new Date(Date.now() + 2 * 86_400_000).toISOString(),
    ]) {
      const res = await api(
        run,
        "POST",
        "/api/generations",
        sendBody("late", { operationIssuedAt: issued }),
      );
      expect(res.body.error?.code).toBe("OPERATION_EXPIRED");
    }
    expect((await api(run, "GET", "/api/conversations")).body.conversations).toEqual([]);
  });

  it("records survive a restart: a retry after restart gets the original answer", async () => {
    const run = await start();
    const body = sendBody("before restart");
    const first = await api(run, "POST", "/api/generations", body);
    await waitTerminal(run, first.body.generationId as string);
    await stop(run);
    const again = await start({ dataDir: run.dataDir });
    const retry = await api(again, "POST", "/api/generations", body);
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual(first.body);
  });

  it("INV-60: a crash after the pending record (before Markdown) rolls back by hash; the conversation is untouched", async () => {
    let crash = true;
    const run = await start({
      send: {
        hooks: {
          afterPendingRecord: () => {
            if (crash) throw new Error("simulated crash");
          },
        },
      },
    });
    const created = (await api(run, "POST", "/api/conversations", {})).body.id as string;
    const before = readFileSync(chatFile(run, created), "utf8");
    const body = sendBody("crash one", { conversationId: created });
    const res = await api(run, "POST", "/api/generations", body);
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe("INTERNAL");
    expect(readFileSync(chatFile(run, created), "utf8")).toBe(before);
    crash = false;
    // The key is unknown again (rolled back), so a resend is a fresh, successful send.
    const retry = await api(run, "POST", "/api/generations", body);
    expect(retry.status).toBe(202);
    await waitTerminal(run, retry.body.generationId as string);
  });

  it("INV-60: a crash after the Markdown write (before committed) resolves to committed by hash", async () => {
    const run = await start({
      send: {
        hooks: {
          afterMarkdownWrite: () => {
            throw new Error("simulated crash");
          },
        },
      },
    });
    const body = sendBody("crash two");
    const res = await api(run, "POST", "/api/generations", body);
    expect(res.body.error?.code).toBe("INTERNAL");
    const lookup = await api(run, "GET", `/api/operations/${body.operationKey}`);
    expect(lookup.status).toBe(200);
    const retry = await api(run, "POST", "/api/generations", body);
    expect(retry.body).toEqual(lookup.body);
    const blocks = readModel(run, lookup.body.conversationId as string).blocks;
    expect(blocks).toHaveLength(1); // the user block stays unanswered before Phase 6
  });

  it("INV-60: startup recovery resolves pending records left by a real crash", async () => {
    const run = await start();
    const created = (await api(run, "POST", "/api/conversations", {})).body.id as string;
    const file = chatFile(run, created);
    const bytes = readFileSync(file);
    const opsDir = path.join(run.dataDir, run.session.userId, "operations");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(opsDir, { recursive: true });
    const record = (
      key: string,
      afterHash: string,
      beforeHash: string | null,
      conversationId = created,
    ) => ({
      version: 1,
      operationKey: key,
      payloadHash: "x",
      conversationId,
      generationId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      beforeHash,
      afterHash,
      status: "pending",
      terminalWritten: false,
      issuedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      committedAt: null,
    });
    const write = (key: string, value: object) => {
      writeFileSync(
        path.join(opsDir, `${sha256Hex(`${run.session.userId}:${key}`)}.json`),
        JSON.stringify(value),
      );
    };
    const committedKey = randomUUID();
    const rolledKey = randomUUID();
    const conflictKey = randomUUID();
    const deletedKey = randomUUID();
    write(committedKey, record(committedKey, sha256Hex(bytes), "0".repeat(64)));
    write(rolledKey, record(rolledKey, "f".repeat(64), sha256Hex(bytes)));
    write(conflictKey, record(conflictKey, "a".repeat(64), "b".repeat(64)));
    write(deletedKey, record(deletedKey, "c".repeat(64), null, randomUUID()));
    await stop(run);
    const again = await start({ dataDir: run.dataDir });
    const report = await again.chatui.ready;
    expect(report).toMatchObject({
      operationsCommitted: 1,
      operationsRolledBack: 2,
      operationConflicts: 1,
    });
    expect((await api(again, "GET", `/api/operations/${committedKey}`)).status).toBe(200);
    expect((await api(again, "GET", `/api/operations/${rolledKey}`)).status).toBe(404);
    // The committed record had no reply and no checkpoint: startup writes one
    // empty `interrupted` reply (contracts §4.1 step 5); nothing else changes.
    const after = parseConversation(readFileSync(file, "utf8"));
    if (!after.ok) throw new Error(after.reason);
    expect(after.conversation.blocks).toEqual([
      expect.objectContaining({ type: "assistant", status: "interrupted", body: "" }),
    ]);
    expect(readFileSync(file).subarray(0, 20)).toEqual(bytes.subarray(0, 20));
    expect(readdirSync(path.join(run.dataDir, run.session.userId, "chats"))).toHaveLength(1); // nothing recreated
  });

  it("expired committed records are removed by the retention sweep at startup", async () => {
    const run = await start();
    const res = await api(run, "POST", "/api/generations", sendBody("old"));
    await waitTerminal(run, res.body.generationId as string);
    await stop(run);
    const later = await start({
      dataDir: run.dataDir,
      now: () => new Date(Date.now() + 8 * 86_400_000),
    });
    expect(await later.chatui.ready).toMatchObject({ operationsExpired: 1 });
  });
});

vi.setConfig({ testTimeout: 20_000 });

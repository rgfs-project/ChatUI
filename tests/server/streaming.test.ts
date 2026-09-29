import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationEvent, GenerationSnapshot } from "@shared/generations";
import type { ChatUiApp } from "../../server/create-app.ts";
import { GenerationManager, type GenerationOutcome } from "../../server/generations/manager.ts";
import type { Provider, ProviderEvent } from "../../server/providers/types.ts";
import { parseConversation } from "../../server/storage/markdown.ts";
import { sha256Hex } from "../../server/storage/operations.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { readSse, type SseFrame } from "../support/sse-client.ts";
import {
  captureLogger,
  providerConfig,
  signIn,
  storageConfig,
  tempDataDir,
  testApp,
  type TestAppOptions,
  type TestSession,
} from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ chunkDelayMs: 25, slowChunks: 24 });
});
afterAll(async () => {
  await llama.close();
});

interface Run {
  base: string;
  chatui: ChatUiApp;
  server: Server;
  dataDir: string;
  session: TestSession;
}
const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await stop(run);
});

async function start(
  options: TestAppOptions & {
    dataDir?: string;
    storage?: Parameters<typeof storageConfig>[0];
  } = {},
): Promise<Run> {
  const dataDir = options.dataDir ?? tempDataDir();
  const { storage, ...rest } = options;
  const { chatui } = testApp({
    ...rest,
    config: {
      dataDir,
      storage: storageConfig(storage),
      provider: providerConfig({ baseUrl: llama.url, maxActiveGenerations: 8 }),
    },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const run = { base, chatui, server, dataDir, session: await signIn(base, chatui) };
  runs.push(run);
  return run;
}

async function stop(run: Run) {
  const index = runs.indexOf(run);
  if (index >= 0) runs.splice(index, 1);
  await run.chatui.shutdown();
  run.server.closeAllConnections();
  await new Promise<void>((resolve) =>
    run.server.close(() => {
      resolve();
    }),
  );
}

async function api(run: Run, method: string, url: string, body?: unknown) {
  const res = await fetch(`${run.base}${url}`, {
    method,
    headers: {
      ...run.session.headers(method !== "GET"),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown> & { error?: { code: string } },
  };
}

const send = (
  run: Run,
  content: string,
  model: string = MOCK_MODELS.slow,
  conversationId?: string,
) =>
  api(run, "POST", "/api/generations", {
    ...(conversationId ? { conversationId } : {}),
    providerId: "local",
    model,
    content,
    operationKey: randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });

const streamUrl = (run: Run, id: string, query = "") =>
  `${run.base}/api/generations/${id}/stream${query}`;
const contentOf = (frames: SseFrame[]) =>
  frames
    .filter((f) => f.event === "delta")
    .map((f) => (f.data as { content?: string }).content ?? "")
    .join("");
const blocksOf = (run: Run, conversationId: string) => {
  const parsed = parseConversation(
    readFileSync(
      path.join(run.dataDir, run.session.userId, "chats", `${conversationId}.md`),
      "utf8",
    ),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.conversation.blocks;
};
const EXPECTED_SLOW = Array.from({ length: 24 }, (_, i) => `part${String(i)} `).join("");

describe("INV-20: replay and resync", () => {
  it("a reconnect with Last-Event-ID inside the window replays exactly the missed events", async () => {
    const run = await start();
    const { body } = await send(run, "replay me");
    const id = body.generationId as string;
    const controller = new AbortController();
    const first = await readSse(streamUrl(run, id), {
      headers: run.session.headers(),
      signal: controller.signal,
      until: (_f, frames) => frames.filter((f) => f.event === "delta").length >= 4,
    });
    controller.abort();
    const last = first.frames.at(-1)?.id ?? 0;
    const second = await readSse(streamUrl(run, id), {
      headers: { ...run.session.headers(), "Last-Event-ID": String(last) },
    });
    expect(second.frames[0]?.id).toBe(last + 1);
    expect(second.frames.some((f) => f.event === "snapshot" || f.event === "resync")).toBe(false);
    expect(second.frames.at(-1)?.event).toBe("terminal");
    const ids = second.frames.map((f) => f.id ?? 0);
    expect(new Set(ids).size).toBe(ids.length);
    const snapshotContent = (first.frames[0]?.data as GenerationSnapshot).content;
    expect(snapshotContent + contentOf(first.frames) + contentOf(second.frames)).toBe(
      EXPECTED_SLOW,
    );
  });

  it("a cursor older than the window, unknown or in the future gets one resync with the full snapshot", async () => {
    const run = await start({ storage: { sseReplayEvents: 5 } });
    const { body } = await send(run, "resync me");
    const id = body.generationId as string;
    await vi.waitFor(async () => {
      expect(
        ((await api(run, "GET", `/api/generations/${id}`)).body as unknown as GenerationSnapshot)
          .lastEventId,
      ).toBeGreaterThan(10);
    });
    for (const cursor of ["1", "999999"]) {
      const controller = new AbortController();
      const sse = await readSse(streamUrl(run, id), {
        headers: { ...run.session.headers(), "Last-Event-ID": cursor },
        signal: controller.signal,
        until: (f) => f.event === "resync",
      });
      controller.abort();
      expect(sse.frames[0]?.event, cursor).toBe("resync");
      expect((sse.frames[0]?.data as GenerationSnapshot).content.length).toBeGreaterThan(0);
    }
    await run.chatui.services.generations.settled(id);
  });

  it("a recreated observer resumes from ?lastEventId; a present header wins over a stale query", async () => {
    const run = await start();
    const { body } = await send(run, "cursor rules");
    const id = body.generationId as string;
    await run.chatui.services.generations.settled(id);
    const total = (
      (await api(run, "GET", `/api/generations/${id}`)).body as unknown as GenerationSnapshot
    ).lastEventId;
    const byQuery = await readSse(streamUrl(run, id, `?lastEventId=${String(total - 2)}`), {
      headers: run.session.headers(),
    });
    expect(byQuery.frames.map((f) => f.id)).toEqual([total - 1, total]);
    expect(byQuery.frames.at(-1)?.event).toBe("terminal");
    const both = await readSse(streamUrl(run, id, "?lastEventId=1"), {
      headers: { ...run.session.headers(), "Last-Event-ID": String(total - 1) },
    });
    expect(both.frames.map((f) => f.id)).toEqual([total]);
    const none = await readSse(streamUrl(run, id), { headers: run.session.headers() });
    expect(none.frames.map((f) => f.event)).toEqual(["snapshot"]);
  });

  it("malformed cursors are VALIDATION errors; authorization precedes replay", async () => {
    const run = await start();
    const { body } = await send(run, "bad cursor", MOCK_MODELS.chat);
    const id = body.generationId as string;
    for (const init of [
      { url: streamUrl(run, id, "?lastEventId=-1"), headers: run.session.headers() },
      { url: streamUrl(run, id, "?lastEventId=abc"), headers: run.session.headers() },
      { url: streamUrl(run, id), headers: { ...run.session.headers(), "Last-Event-ID": "1e3" } },
      {
        url: streamUrl(run, id),
        headers: { ...run.session.headers(), "Last-Event-ID": "9".repeat(16) },
      },
    ]) {
      const res = await fetch(init.url, { headers: init.headers });
      expect(res.status, init.url).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
    }
    const other = await signIn(run.base, run.chatui, "mallory");
    const denied = await fetch(streamUrl(run, id), {
      headers: { ...other.headers(), "Last-Event-ID": "1" },
    });
    expect(denied.status).toBe(404);
  });

  it("a lagging observer is disconnected and resyncs with no duplicated or lost text", async () => {
    const flood = await startMockLlama({ floodChunks: 400, floodChunkBytes: 16 * 1024 });
    try {
      const dataDir = tempDataDir();
      const { chatui } = testApp({
        sse: { maxQueuedBytes: 512 * 1024 },
        config: {
          dataDir,
          storage: storageConfig({ sseReplayEvents: 50 }),
          provider: providerConfig({
            baseUrl: flood.url,
            maxActiveGenerations: 4,
            maxResponseBytes: 64 * 1024 * 1024,
          }),
        },
      });
      await chatui.ready;
      const server = createServer(chatui.handler);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      const run: Run = { base, chatui, server, dataDir, session: await signIn(base, chatui) };
      runs.push(run);
      const { body } = await send(run, "flood", MOCK_MODELS.flood);
      const id = body.generationId as string;
      const slow = await fetch(streamUrl(run, id), { headers: run.session.headers() });
      await run.chatui.services.generations.settled(id);
      // The slow reader was dropped; reading what it did receive and resuming is consistent.
      const partial = await slow.text().catch(() => "");
      const lastId = Math.max(
        0,
        ...[...partial.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
      );
      const resumed = await readSse(streamUrl(run, id), {
        headers: { ...run.session.headers(), "Last-Event-ID": String(lastId) },
      });
      const first = resumed.frames[0];
      const final = (await api(run, "GET", `/api/generations/${id}`))
        .body as unknown as GenerationSnapshot;
      expect(first?.event === "resync" || first?.id === lastId + 1).toBe(true);
      if (first?.event === "resync")
        expect((first.data as GenerationSnapshot).content).toBe(final.content);
      expect(final.content.length).toBe(400 * 16 * 1024);
    } finally {
      await flood.close();
    }
  });
});

describe("races (deterministic)", () => {
  function gated(): { provider: Provider; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return {
      release,
      provider: {
        listModels: () => Promise.resolve([]),
        discoverSlots: () => Promise.resolve(undefined),
        tokenize: () => Promise.resolve(1),
        applyTemplate: () => Promise.resolve(""),
        async *streamChat(): AsyncGenerator<ProviderEvent> {
          yield { type: "start" };
          yield { type: "content", text: "a" };
          await gate;
          yield { type: "content", text: "b" };
        },
      },
    };
  }

  it("an observer attaching during the terminal sequence receives the terminal event exactly once", async () => {
    const { provider, release } = gated();
    let persistRelease!: () => void;
    const persistGate = new Promise<void>((r) => (persistRelease = r));
    const generations = new GenerationManager({
      logger: captureLogger().logger,
      maxOutputTokens: 10,
      generationMaxMs: 10_000,
      maxActiveGenerations: 5,
      providerLimits: { p: 5 },
    });
    const id = randomUUID();
    generations.launch(generations.reserve("u", "u/c", "p"), {
      generationId: id,
      assistantMessageId: randomUUID(),
      conversationId: randomUUID(),
      provider,
      model: "m",
      messages: [],
      persist: async (_o: GenerationOutcome) => {
        await persistGate;
        return "rev";
      },
    });
    release();
    await vi.waitFor(() => {
      expect(generations.snapshot(id).content).toBe("ab");
    });
    // Decided but not yet published: attach now.
    const events: GenerationEvent[] = [];
    let closed = 0;
    generations.observe(id, { send: (e) => events.push(e), close: () => closed++ });
    persistRelease();
    await generations.settled(id);
    expect(events.filter((e) => e.type === "terminal")).toHaveLength(1);
    expect(closed).toBe(1);
    // Reconnecting after the terminal replays it and closes.
    const late: GenerationEvent[] = [];
    generations.observe(
      id,
      { send: (e) => late.push(e), close: () => undefined },
      undefined,
      events[0]?.id ?? 0,
    );
    expect(late.at(-1)?.type).toBe("terminal");
  });

  it("two concurrent sends to one conversation: one is accepted, the other is GENERATION_IN_PROGRESS", async () => {
    const run = await start();
    const created = (await api(run, "POST", "/api/conversations", {})).body.id as string;
    const results = await Promise.all([
      send(run, "one", MOCK_MODELS.slow, created),
      send(run, "two", MOCK_MODELS.slow, created),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409)?.body.error?.code).toBe("GENERATION_IN_PROGRESS");
    const accepted = results.find((r) => r.status === 202);
    await run.chatui.services.generations.settled(accepted?.body.generationId as string);
    expect(blocksOf(run, created).filter((b) => b.type === "user")).toHaveLength(1);
  });

  it("disabling an account cancels its running generations and ends its streams", async () => {
    const run = await start({ sse: { heartbeatMs: 30 } });
    const { body } = await send(run, "will be cancelled");
    const id = body.generationId as string;
    const stream = readSse(streamUrl(run, id), { headers: run.session.headers() });
    await vi.waitFor(() => {
      expect(run.chatui.services.sseConnections.size).toBe(1);
    });
    await run.chatui.services.users.update(run.session.userId, { status: "disabled" });
    await stream;
    await run.chatui.services.generations.settled(id);
    expect(run.chatui.services.generations.snapshot(id).state).toBe("cancelled");
    const blocks = blocksOf(run, body.conversationId as string);
    expect(blocks.filter((b) => b.type === "assistant")).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
  });
});

describe("INV-21 / INV-60: checkpoints and restart recovery", () => {
  it("checkpoints are throttled (never one write per token) and end terminal", async () => {
    const run = await start({ storage: { generationCheckpointMs: 250 } });
    const before = run.chatui.checkpoints.writes;
    const { body } = await send(run, "cadence");
    const id = body.generationId as string;
    const checkpointFile = path.join(run.dataDir, "_system", "generations", `${id}.json`);
    await run.chatui.services.generations.settled(id);
    const final = JSON.parse(readFileSync(checkpointFile, "utf8")) as {
      state: string;
      content: string;
    };
    expect(final).toMatchObject({ state: "terminal", content: EXPECTED_SLOW });
    // 24 content chunks over ~600 ms: running + transition + a few periodic + decided + terminal.
    const writes = run.chatui.checkpoints.writes - before;
    expect(writes).toBeGreaterThanOrEqual(4);
    expect(writes).toBeLessThan(12);
  });

  it("a restart with a running checkpoint writes the partial reply once as interrupted", async () => {
    const dataDir = tempDataDir();
    const run = await start({ dataDir });
    const { body } = await send(run, "cut me off");
    const id = body.generationId as string;
    const conversationId = body.conversationId as string;
    await vi.waitFor(async () => {
      expect(
        ((await api(run, "GET", `/api/generations/${id}`)).body as unknown as GenerationSnapshot)
          .content,
      ).toContain("part3");
    });
    await stop(run); // graceful: leaves the generation as a running checkpoint
    const checkpoint = JSON.parse(
      readFileSync(path.join(dataDir, "_system", "generations", `${id}.json`), "utf8"),
    ) as { state: string; content: string };
    expect(checkpoint.state).toBe("running");
    const again = await start({ dataDir });
    const blocks = blocksOf(again, conversationId);
    const assistants = blocks.filter((b) => b.type === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ status: "interrupted", id: body.assistantMessageId });
    expect(assistants[0]?.body.startsWith("part0 part1 part2 part3")).toBe(true);
    expect(assistants[0]?.body).toBe(checkpoint.content);
    await stop(again);
    const third = await start({ dataDir });
    expect(blocksOf(third, conversationId).filter((b) => b.type === "assistant")).toHaveLength(1);
  });

  async function craft(
    run: Run,
    state: "running" | "terminal-decided",
    options: { markdownHasReply?: boolean; deleteConversation?: boolean } = {},
  ) {
    const { body } = await send(run, "base", MOCK_MODELS.chat);
    await run.chatui.services.generations.settled(body.generationId as string);
    const conversationId = body.conversationId as string;
    const file = path.join(run.dataDir, run.session.userId, "chats", `${conversationId}.md`);
    const generationId = randomUUID();
    const assistantMessageId = randomUUID();
    const operationKey = randomUUID();
    if (options.markdownHasReply) {
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}\n<!-- cc:assistant id=${assistantMessageId} status=complete provider="local" model="m" -->\nfinal answer\n`,
      );
    }
    const dir = path.join(run.dataDir, "_system", "generations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${generationId}.json`),
      JSON.stringify({
        version: 1,
        generationId,
        userId: run.session.userId,
        conversationId,
        assistantMessageId,
        operationKey,
        providerId: "local",
        model: "m",
        state,
        content: "partial",
        reasoning: "",
        lastEventId: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        outcome:
          state === "terminal-decided"
            ? {
                state: "completed",
                content: "final answer",
                reasoning: "why",
                finishReason: "stop",
                error: null,
                finishedAt: new Date().toISOString(),
              }
            : null,
      }),
    );
    const opsDir = path.join(run.dataDir, run.session.userId, "operations");
    writeFileSync(
      path.join(opsDir, `${sha256Hex(`${run.session.userId}:${operationKey}`)}.json`),
      JSON.stringify({
        version: 1,
        operationKey,
        payloadHash: "x",
        conversationId,
        generationId,
        userMessageId: randomUUID(),
        assistantMessageId,
        beforeHash: null,
        afterHash: "a".repeat(64),
        status: "committed",
        terminalWritten: false,
        issuedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
      }),
    );
    if (options.deleteConversation) {
      const { rmSync } = await import("node:fs");
      rmSync(file);
    }
    return { conversationId, assistantMessageId, operationKey, file };
  }

  it("a crash after terminal-decided but before the Markdown write writes the recorded status once", async () => {
    const dataDir = tempDataDir();
    const run = await start({ dataDir });
    const crafted = await craft(run, "terminal-decided");
    await stop(run);
    const again = await start({ dataDir });
    const replies = blocksOf(again, crafted.conversationId).filter(
      (b) => b.id === crafted.assistantMessageId,
    );
    expect(replies).toEqual([
      expect.objectContaining({ type: "reasoning", body: "why" }),
      expect.objectContaining({ type: "assistant", status: "complete", body: "final answer" }),
    ]);
    const op = await again.chatui.services.operations.read(
      again.session.userId,
      crafted.operationKey,
    );
    expect(op?.terminalWritten).toBe(true);
  });

  it("a crash between the Markdown write and the checkpoint update does not duplicate the reply", async () => {
    const dataDir = tempDataDir();
    const run = await start({ dataDir });
    const crafted = await craft(run, "terminal-decided", { markdownHasReply: true });
    await stop(run);
    const again = await start({ dataDir });
    expect(
      blocksOf(again, crafted.conversationId).filter((b) => b.id === crafted.assistantMessageId),
    ).toHaveLength(1);
  });

  it("a running checkpoint whose conversation was deleted is discarded, never recreated", async () => {
    const dataDir = tempDataDir();
    const run = await start({ dataDir });
    const crafted = await craft(run, "running", { deleteConversation: true });
    await stop(run);
    const again = await start({ dataDir });
    const { existsSync } = await import("node:fs");
    expect(existsSync(crafted.file)).toBe(false);
    const report = await again.chatui.ready;
    expect(report.generations?.discarded).toBe(1);
  });

  it("a committed operation whose reply the user later deleted is not re-added", async () => {
    const dataDir = tempDataDir();
    const run = await start({ dataDir });
    const { body } = await send(run, "delete my reply", MOCK_MODELS.chat);
    await run.chatui.services.generations.settled(body.generationId as string);
    const file = path.join(
      dataDir,
      run.session.userId,
      "chats",
      `${body.conversationId as string}.md`,
    );
    // Hand-delete the reply (edit/delete arrive in Phase 13a).
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, text.indexOf("<!-- cc:reasoning")).trimEnd() + "\n");
    await stop(run);
    const again = await start({ dataDir });
    expect(
      blocksOf(again, body.conversationId as string).filter((b) => b.type === "assistant"),
    ).toHaveLength(0);
  });

  it("INV-60: a crash at each acceptance step recovers without duplicates or recreated conversations", async () => {
    for (const hook of ["afterPendingRecord", "afterMarkdownWrite", "afterCommit"] as const) {
      const dataDir = tempDataDir();
      const run = await start({
        dataDir,
        send: {
          hooks: {
            [hook]: () => {
              throw new Error(`crash at ${hook}`);
            },
          },
        },
      });
      const res = await send(run, `crash ${hook}`, MOCK_MODELS.chat);
      expect(res.status, hook).toBe(500);
      await stop(run);
      const again = await start({ dataDir });
      const list = (await api(again, "GET", "/api/conversations")).body.conversations as {
        id: string;
      }[];
      if (hook === "afterPendingRecord") {
        expect(list, hook).toEqual([]); // rolled back: nothing created
      } else {
        expect(list, hook).toHaveLength(1);
        const blocks = blocksOf(again, list[0]?.id ?? "");
        expect(
          blocks.filter((b) => b.type === "user"),
          hook,
        ).toHaveLength(1);
        const assistants = blocks.filter((b) => b.type === "assistant");
        expect(assistants, hook).toEqual([
          expect.objectContaining({ status: "interrupted", body: "" }),
        ]);
      }
    }
  });
});

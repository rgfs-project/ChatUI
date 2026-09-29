import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationSnapshot } from "@shared/generations";
import type { ChatUiApp } from "../../server/create-app.ts";
import {
  MOCK_MODELS,
  startMockLlama,
  UPSTREAM_SECRET,
  type MockLlama,
} from "../support/mock-llama.ts";
import { readSse, type SseFrame } from "../support/sse-client.ts";
import {
  providerConfig,
  signIn,
  testApp,
  type TestAppOptions,
  type TestSession,
} from "./helpers.ts";

const API_KEY = "sk-test-provider-key-123";
let llama: MockLlama;

beforeAll(async () => {
  llama = await startMockLlama({ apiKey: API_KEY, slots: 3, chunkDelayMs: 40, slowChunks: 15 });
});

afterAll(async () => {
  await llama.close();
});

interface Running {
  base: string;
  chatui: ChatUiApp;
  logs: ReturnType<typeof testApp>["logs"];
  /** Every HTTP response body seen by the test client (for leak checks). */
  seen: string[];
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
  provider: Parameters<typeof providerConfig>[0] = {},
  extra: TestAppOptions = {},
): Promise<Running> {
  const { chatui, logs } = testApp({
    ...extra,
    config: { provider: providerConfig({ baseUrl: llama.url, apiKey: API_KEY, ...provider }) },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, chatui, logs, seen: [], session: await signIn(base, chatui) };
}

async function api(run: Running, method: string, path: string, body?: unknown) {
  const res = await fetch(`${run.base}${path}`, {
    method,
    headers: {
      ...run.session.headers(method !== "GET"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  run.seen.push(text, JSON.stringify(Object.fromEntries(res.headers)));
  return {
    status: res.status,
    headers: res.headers,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

async function startGeneration(run: Running, model: string, content = "hello there") {
  return api(run, "POST", "/api/generations", {
    providerId: "local",
    model,
    content,
    operationKey: randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });
}

async function waitTerminal(run: Running, id: string): Promise<GenerationSnapshot> {
  let snapshot: GenerationSnapshot | undefined;
  await vi.waitFor(
    async () => {
      snapshot = (await api(run, "GET", `/api/generations/${id}`))
        .body as unknown as GenerationSnapshot;
      expect(["pending", "streaming"]).not.toContain(snapshot.state);
    },
    { timeout: 10_000, interval: 20 },
  );
  if (!snapshot) throw new Error("no snapshot");
  return snapshot;
}

function chatRequests() {
  return llama.requests.filter((r) => r.path === "/v1/chat/completions").length;
}

describe("model discovery", () => {
  interface Group {
    provider: { id: string; status: string };
    stale: boolean;
    models: {
      id: string;
      providerId: string;
      contextTokens: number;
      status: string;
      capabilities: unknown;
      capabilitySources: unknown;
    }[];
  }

  it("lists models grouped by provider as DTOs without raw provider fields (INV-04)", async () => {
    const run = await start();
    const res = await api(run, "GET", "/api/models");
    expect(res.status).toBe(200);
    const [group] = res.body.providers as Group[];
    expect(group?.provider).toMatchObject({ id: "local", status: "ok" });
    expect(group?.stale).toBe(false);
    expect(group?.models.find((m) => m.id === MOCK_MODELS.chat)).toEqual({
      providerId: "local",
      id: MOCK_MODELS.chat,
      contextTokens: 32_768,
      status: "loaded",
      capabilities: { inputModalities: ["text"], reasoning: true, tools: false },
      capabilitySources: { inputModalities: "config", reasoning: "config", tools: "config" },
    });
    expect(group?.models.find((m) => m.id === MOCK_MODELS.slow)).toMatchObject({
      contextTokens: 8_192,
      status: "unloaded",
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /secret\/path|llama-server|args|n_params|baseUrl|apiKey/,
    );
  });

  it("sends the configured API key to the provider and never to the client", async () => {
    const run = await start();
    await api(run, "GET", "/api/models?refresh=1");
    expect(llama.requests.at(-1)?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(run.seen.join("\n")).not.toContain(API_KEY);
  });

  it("an unreachable provider is listed as unavailable with no models; sends fail with PROVIDER_UNAVAILABLE", async () => {
    const run = await start({ baseUrl: "http://127.0.0.1:9" });
    const res = await api(run, "GET", "/api/models");
    expect(res.status).toBe(200);
    expect((res.body.providers as Group[])[0]).toMatchObject({
      provider: { status: "unavailable" },
      models: [],
    });
    const sent = await startGeneration(run, MOCK_MODELS.chat);
    expect(sent.body).toMatchObject({ error: { code: "PROVIDER_UNAVAILABLE" } });
  });

  it("rejected credentials make the provider unavailable without leaking the upstream body", async () => {
    const run = await start({ apiKey: "wrong" });
    const res = await api(run, "GET", "/api/models");
    expect((res.body.providers as Group[])[0]?.provider.status).toBe("unavailable");
    expect(JSON.stringify(res.body)).not.toContain(UPSTREAM_SECRET);
  });

  it("uses the provider's discovered slot count as its admission limit and the global default", async () => {
    const run = await start({ maxActiveGenerations: undefined });
    await api(run, "GET", "/api/models");
    await vi.waitFor(() => {
      expect(run.chatui.services.generations.providerLimit("local")).toBe(3);
      expect(run.chatui.services.generations.maxActiveGenerations).toBe(3);
    });
  });
});

describe("generations", () => {
  it("INV-05: a successful generation streams to exactly one completed state", async () => {
    const run = await start();
    const res = await startGeneration(run, MOCK_MODELS.chat, "hello there");
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual([
      "assistantMessageId",
      "conversationId",
      "generationId",
      "userMessageId",
    ]);
    const snapshot = await waitTerminal(run, res.body.generationId as string);
    expect(snapshot).toMatchObject({
      state: "completed",
      content: "Echo: hello there",
      reasoning: "Considering the request.",
      finishReason: "stop",
      error: null,
      model: MOCK_MODELS.chat,
    });
    expect(snapshot.finishedAt).not.toBeNull();
    const sent = llama.requests.at(-1)?.body as { max_tokens: number; stream: boolean };
    expect(sent).toMatchObject({ max_tokens: 256, stream: true });
  });

  it("keeps reasoning separate from content in state and events", async () => {
    const paced = await startMockLlama({ chatChunkDelayMs: 30 });
    const run = await start({ baseUrl: paced.url, apiKey: undefined });
    const { body } = await startGeneration(run, MOCK_MODELS.chat, "separate");
    const sse = await readSse(`${run.base}/api/generations/${body.generationId as string}/stream`, {
      headers: run.session.headers(),
    });
    await paced.close();
    const deltas = sse.frames
      .filter((f) => f.event === "delta")
      .map((f) => f.data as Record<string, string>);
    expect(deltas.some((d) => "reasoning" in d && !("content" in d))).toBe(true);
    expect(deltas.some((d) => "content" in d && !("reasoning" in d))).toBe(true);
    const snapshot = await waitTerminal(run, body.generationId as string);
    expect(snapshot.content).not.toContain("Considering");
    expect(snapshot.reasoning).not.toContain("Echo");
  });

  it("reports finish_reason length on a truncated completion", async () => {
    const run = await start();
    const { body } = await startGeneration(run, MOCK_MODELS.length);
    expect(await waitTerminal(run, body.generationId as string)).toMatchObject({
      state: "completed",
      finishReason: "length",
    });
  });

  it("rejects a missing model with VALIDATION and an unknown model with MODEL_NOT_FOUND, starting nothing", async () => {
    const run = await start();
    const before = chatRequests();
    const missing = await api(run, "POST", "/api/generations", {
      providerId: "local",
      content: "x",
      operationKey: randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: { code: "VALIDATION" } });
    const unknown = await startGeneration(run, "no-such-model");
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: { code: "MODEL_NOT_FOUND" } });
    expect(chatRequests()).toBe(before);
    expect(run.chatui.services.generations.activeCount).toBe(0);
  });

  it("rejects unknown fields and empty content", async () => {
    const run = await start();
    const base = {
      providerId: "local",
      model: MOCK_MODELS.chat,
      operationKey: randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    };
    const extra = await api(run, "POST", "/api/generations", {
      ...base,
      content: "x",
      temperature: 2,
    });
    expect(extra.status).toBe(400);
    const empty = await api(run, "POST", "/api/generations", { ...base, content: "  \n " });
    expect(empty.status).toBe(400);
    const legacy = await api(run, "POST", "/api/generations", {
      ...base,
      messages: [{ role: "user", content: "x" }],
    });
    expect(legacy.status).toBe(400);
  });

  it.each([
    [MOCK_MODELS.error500, "failed", "PROVIDER_ERROR"],
    [MOCK_MODELS.invalid, "failed", "PROVIDER_ERROR"],
    [MOCK_MODELS.earlyEnd, "failed", "PROVIDER_ERROR"],
    [MOCK_MODELS.overflow, "failed", "PROVIDER_ERROR"],
  ])("provider failure %s ends as %s/%s without upstream details", async (model, state, code) => {
    const run = await start();
    const { status, body } = await startGeneration(run, model);
    expect(status).toBe(202);
    const snapshot = await waitTerminal(run, body.generationId as string);
    expect(snapshot.state).toBe(state);
    expect(snapshot.error?.code).toBe(code);
    expect(JSON.stringify(snapshot)).not.toContain(UPSTREAM_SECRET);
    expect(JSON.stringify(snapshot)).not.toContain("tokens)");
  });

  it("explains a context overflow after 202", async () => {
    const run = await start();
    const { body } = await startGeneration(run, MOCK_MODELS.overflow);
    const snapshot = await waitTerminal(run, body.generationId as string);
    expect(snapshot.error?.message).toMatch(/too long for the model's context window/);
  });

  it("an idle provider stream times out as timed_out/PROVIDER_TIMEOUT", async () => {
    const run = await start({ timeoutMs: 200 });
    const { body } = await startGeneration(run, MOCK_MODELS.hang);
    const snapshot = await waitTerminal(run, body.generationId as string);
    expect(snapshot).toMatchObject({
      state: "timed_out",
      content: "partial ",
      error: { code: "PROVIDER_TIMEOUT" },
    });
  });

  it("a provider that never answers times out", async () => {
    const run = await start({ timeoutMs: 200 });
    const { body } = await startGeneration(run, MOCK_MODELS.noResponse);
    expect(await waitTerminal(run, body.generationId as string)).toMatchObject({
      state: "timed_out",
      error: { code: "PROVIDER_TIMEOUT" },
    });
  });

  it("GENERATION_MAX_MS caps the whole generation", async () => {
    const run = await start({ generationMaxMs: 150 });
    const { body } = await startGeneration(run, MOCK_MODELS.slow);
    expect(await waitTerminal(run, body.generationId as string)).toMatchObject({
      state: "timed_out",
    });
  });

  it("the provider response is capped by PROVIDER_MAX_RESPONSE_BYTES", async () => {
    const run = await start({ maxResponseBytes: 256 * 1024 });
    const { body } = await startGeneration(run, MOCK_MODELS.huge);
    const snapshot = await waitTerminal(run, body.generationId as string);
    expect(snapshot).toMatchObject({ state: "failed", error: { code: "PROVIDER_ERROR" } });
    expect(snapshot.content.length).toBeLessThan(256 * 1024);
  });

  it("cancellation ends the generation and closes the upstream request", async () => {
    const run = await start();
    const { body } = await startGeneration(run, MOCK_MODELS.slow);
    const id = body.generationId as string;
    await vi.waitFor(async () => {
      expect(
        ((await api(run, "GET", `/api/generations/${id}`)).body as { content: string }).content,
      ).not.toBe("");
    });
    const cancelled = await api(run, "POST", `/api/generations/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ state: "cancelled", error: null });
    const again = await api(run, "POST", `/api/generations/${id}/cancel`);
    expect(again.body).toMatchObject({ state: "cancelled", finishedAt: cancelled.body.finishedAt });
    await vi.waitFor(() => {
      expect(llama.openStreams()).toBe(0);
    });
    const content = (await waitTerminal(run, id)).content;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await waitTerminal(run, id)).content).toBe(content); // late chunks dropped
  });

  it("unknown generation ids return GENERATION_NOT_FOUND", async () => {
    const run = await start();
    for (const [method, path] of [
      ["GET", "/api/generations/00000000-0000-4000-8000-000000000000"],
      ["POST", "/api/generations/00000000-0000-4000-8000-000000000000/cancel"],
      ["GET", "/api/generations/00000000-0000-4000-8000-000000000000/stream"],
    ] as const) {
      const res = await api(run, method, path);
      expect(res.status, path).toBe(404);
      expect(res.body).toMatchObject({ error: { code: "GENERATION_NOT_FOUND" } });
    }
    expect((await api(run, "GET", "/api/generations/not-a-uuid")).status).toBe(400);
  });

  it("INV-62: admission beyond MAX_ACTIVE_GENERATIONS is 429 with Retry-After and starts nothing", async () => {
    const run = await start({ maxActiveGenerations: 1 });
    const first = await startGeneration(run, MOCK_MODELS.slow);
    expect(first.status).toBe(202);
    await vi.waitFor(() => {
      expect(llama.openStreams()).toBeGreaterThan(0);
    });
    const before = chatRequests();
    const second = await startGeneration(run, MOCK_MODELS.chat);
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(chatRequests()).toBe(before);
    await api(run, "POST", `/api/generations/${first.body.generationId as string}/cancel`);
    expect((await startGeneration(run, MOCK_MODELS.chat)).status).toBe(202);
  });

  it("evicts terminal generations after the retention TTL and beyond the retention cap", async () => {
    const run = await start({}, { generationRetention: { retentionMs: 150, maxRetained: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await startGeneration(run, MOCK_MODELS.chat, `n${String(i)}`);
      ids.push(body.generationId as string);
      await waitTerminal(run, body.generationId as string);
    }
    expect((await api(run, "GET", `/api/generations/${ids[0] ?? ""}`)).status).toBe(404);
    expect((await api(run, "GET", `/api/generations/${ids[2] ?? ""}`)).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await api(run, "GET", `/api/generations/${ids[2] ?? ""}`)).status).toBe(404);
    });
  });

  it("INV-04: no response contains the provider key, upstream bodies or model paths", async () => {
    const run = await start();
    for (const model of [
      MOCK_MODELS.chat,
      MOCK_MODELS.error500,
      MOCK_MODELS.invalid,
      MOCK_MODELS.overflow,
    ]) {
      const { body } = await startGeneration(run, model);
      const id = body.generationId as string;
      const sse = await readSse(`${run.base}/api/generations/${id}/stream`, {
        headers: run.session.headers(),
      });
      run.seen.push(sse.raw);
      await waitTerminal(run, id);
    }
    await api(run, "GET", "/api/models");
    await startGeneration(run, "no-such-model");
    const all = run.seen.join("\n");
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain(UPSTREAM_SECRET);
    expect(all).not.toContain("/secret/path");
    expect(all).not.toContain("chatcmpl-mock");
  });
});

describe("SSE observation", () => {
  const terminal = (frame: SseFrame) => frame.event === "terminal";

  it("uses the contract headers, a snapshot first and monotonically increasing ids", async () => {
    const run = await start();
    const { body } = await startGeneration(run, MOCK_MODELS.slow);
    const sse = await readSse(`${run.base}/api/generations/${body.generationId as string}/stream`, {
      headers: run.session.headers(),
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(sse.headers.get("cache-control")).toBe("no-cache");
    expect(sse.headers.get("x-accel-buffering")).toBe("no");
    expect(sse.headers.get("content-encoding")).toBeNull();
    expect(sse.frames[0]?.event).toBe("snapshot");
    expect(sse.frames.at(-1)?.event).toBe("terminal");
    expect(sse.frames.filter(terminal)).toHaveLength(1);
    const ids = sse.frames.map((f) => f.id ?? -1);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    const content = sse.frames
      .filter((f) => f.event === "delta")
      .map((f) => (f.data as { content?: string }).content ?? "")
      .join("");
    const snapshotContent = (sse.frames[0]?.data as GenerationSnapshot).content;
    expect(snapshotContent + content).toBe(
      (await waitTerminal(run, body.generationId as string)).content,
    );
  });

  it("sends heartbeat comments", async () => {
    const run = await start({}, { sse: { heartbeatMs: 20 } });
    const { body } = await startGeneration(run, MOCK_MODELS.slow);
    const sse = await readSse(`${run.base}/api/generations/${body.generationId as string}/stream`, {
      headers: run.session.headers(),
    });
    expect(sse.comments).toBeGreaterThan(0);
    expect(sse.raw).toContain(": ping\n\n");
  });

  it("INV-06: disconnecting never cancels; reconnect gets a snapshot then live events", async () => {
    const run = await start();
    const { body } = await startGeneration(run, MOCK_MODELS.slow);
    const id = body.generationId as string;
    const controller = new AbortController();
    const first = await readSse(`${run.base}/api/generations/${id}/stream`, {
      headers: run.session.headers(),
      signal: controller.signal,
      until: (_frame, frames) => frames.filter((f) => f.event === "delta").length >= 2,
    });
    controller.abort();
    const lastSeen = first.frames.at(-1)?.id ?? 0;

    const second = await readSse(`${run.base}/api/generations/${id}/stream`, {
      headers: run.session.headers(),
    });
    const snapshot = second.frames[0];
    expect(snapshot?.event).toBe("snapshot");
    expect(snapshot?.id).toBeGreaterThanOrEqual(lastSeen);
    expect((snapshot?.data as GenerationSnapshot).content.length).toBeGreaterThan(0);
    expect(second.frames.at(-1)?.event).toBe("terminal");
    expect((second.frames.at(-1)?.data as { state: string }).state).toBe("completed");
    const final = await waitTerminal(run, id);
    expect(final.content).toBe(Array.from({ length: 15 }, (_, i) => `part${String(i)} `).join(""));
  });

  it("observing a finished generation returns its snapshot and ends", async () => {
    const run = await start();
    const { body } = await startGeneration(run, MOCK_MODELS.chat);
    await waitTerminal(run, body.generationId as string);
    const sse = await readSse(`${run.base}/api/generations/${body.generationId as string}/stream`, {
      headers: run.session.headers(),
    });
    expect(sse.frames).toHaveLength(1);
    expect((sse.frames[0]?.data as GenerationSnapshot).state).toBe("completed");
  });

  it("INV-62: a slow observer is disconnected while the generation and a normal observer continue", async () => {
    const flood = await startMockLlama({ floodChunks: 600, floodChunkBytes: 32 * 1024 });
    try {
      const run = await start(
        { baseUrl: flood.url, apiKey: undefined, maxResponseBytes: 64 * 1024 * 1024 },
        { sse: { maxQueuedBytes: 6 * 1024 * 1024 } },
      );
      const { body } = await startGeneration(run, MOCK_MODELS.flood);
      const id = body.generationId as string;
      const url = `${run.base}/api/generations/${id}/stream`;

      // Slow observer: opens the stream and never reads it.
      const slow = await fetch(url, { headers: run.session.headers() });
      const normal = await readSse(url, { headers: run.session.headers() });
      expect(normal.frames.at(-1)?.event).toBe("terminal");
      const snapshot = await waitTerminal(run, id);
      expect(snapshot.state).toBe("completed");
      expect(snapshot.content.length).toBe(600 * 32 * 1024);
      await vi.waitFor(() => {
        expect(JSON.stringify(run.logs.lines())).toContain("disconnecting slow SSE observer");
      });
      await slow.body?.cancel().catch(() => undefined);
    } finally {
      await flood.close();
    }
  });
});

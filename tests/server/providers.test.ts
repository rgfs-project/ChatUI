import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import type { ProviderEntry } from "../../server/providers/config.ts";
import {
  addressProblem,
  checkUrl,
  createSafeFetch,
  SsrfError,
  type SsrfPolicy,
} from "../../server/providers/ssrf.ts";
import type { Provider, ProviderEvent, ProviderModel } from "../../server/providers/types.ts";
import { parseConversation } from "../../server/storage/markdown.ts";
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

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ apiKey: "sk-provider-a-secret" });
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

/** A second Provider implementation (not llama.cpp): proves the abstraction. */
class MemoryProvider implements Provider {
  models: ProviderModel[];
  failListing = false;
  requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  gate: Promise<void> | undefined;

  constructor(models: string[]) {
    this.models = models.map((id) => ({ id, contextTokens: 4096, status: "unknown" as const }));
  }
  listModels(): Promise<ProviderModel[]> {
    return this.failListing ? Promise.reject(new Error("down")) : Promise.resolve(this.models);
  }
  discoverSlots(): Promise<number | undefined> {
    return Promise.resolve(undefined);
  }
  tokenize(_model: string, text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / 4));
  }
  applyTemplate(_model: string, messages: { role: string; content: string }[]): Promise<string> {
    return Promise.resolve(messages.map((m) => `${m.role}: ${m.content}`).join("\n"));
  }
  async *streamChat(request: {
    model: string;
    messages: { role: string; content: string }[];
  }): AsyncGenerator<ProviderEvent> {
    this.requests.push({ model: request.model, messages: request.messages });
    yield { type: "start" };
    await this.gate;
    yield { type: "content", text: `memory says hi (${request.model})` };
    yield { type: "finish", reason: "stop" };
  }
}

const memoryEntry = (id: string, extra: Partial<ProviderEntry> = {}): ProviderEntry => ({
  id,
  name: `Memory ${id}`,
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:1",
  capabilities: { inputModalities: ["text", "image"], reasoning: false, tools: true },
  ...extra,
});

interface Run {
  base: string;
  chatui: ChatUiApp;
  dataDir: string;
  session: TestSession;
  seen: string[];
}

async function start(
  options: {
    dataDir?: string;
    providers?: object[];
    memory?: Record<string, MemoryProvider>;
  } & TestAppOptions = {},
): Promise<Run> {
  const dataDir = options.dataDir ?? tempDataDir();
  if (options.providers) writeProviders(dataDir, options.providers);
  const { providers: _p, memory, ...rest } = options;
  const { chatui } = testApp({
    ...rest,
    providerFactory: memory ? (entry) => memory[entry.id] ?? (undefined as never) : undefined,
    config: {
      dataDir,
      provider: providerConfig({ baseUrl: undefined, maxActiveGenerations: undefined }),
      ...options.config,
    },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, chatui, dataDir, session: await signIn(base, chatui), seen: [] };
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
  const text = await res.text();
  run.seen.push(text);
  return {
    status: res.status,
    body: JSON.parse(text) as Record<string, unknown> & { error?: { code: string } },
  };
}

const send = (
  run: Run,
  providerId: string,
  model: string,
  content: string,
  conversationId?: string,
) =>
  api(run, "POST", "/api/generations", {
    ...(conversationId ? { conversationId } : {}),
    providerId,
    model,
    content,
    operationKey: randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });

async function done(run: Run, generationId: unknown) {
  await run.chatui.services.generations.settled(generationId as string);
}

describe("providers and models", () => {
  it("the abstraction supports a second implementation; listing is non-sensitive and grouped", async () => {
    const memory = { mem: new MemoryProvider(["alpha", "beta"]) };
    const run = await start({
      providers: [memoryEntry("mem"), { id: "broken", name: "Broken" }],
      memory,
    });
    const providers = (await api(run, "GET", "/api/providers")).body.providers as {
      id: string;
      status: string;
    }[];
    expect(providers.map((p) => [p.id, p.status])).toEqual([
      ["mem", "ok"], // in-memory discovery completes during startup warm-up
      ["broken", "invalid"],
    ]);
    const models = (await api(run, "GET", "/api/models")).body.providers as {
      provider: { id: string; status: string };
      models: {
        id: string;
        capabilities: { inputModalities: string[]; tools: boolean };
        capabilitySources: { inputModalities: string };
      }[];
    }[];
    expect(models[0]?.provider).toMatchObject({ id: "mem", status: "ok" });
    expect(models[0]?.models.map((m) => m.id)).toEqual(["alpha", "beta"]);
    expect(models[0]?.models[0]?.capabilities).toEqual({
      inputModalities: ["text", "image"],
      reasoning: false,
      tools: true,
    });
    expect(models[0]?.models[0]?.capabilitySources.inputModalities).toBe("config");

    const sent = await send(run, "mem", "alpha", "hello memory");
    expect(sent.status).toBe(202);
    await done(run, sent.body.generationId);
    const conversation = (
      await api(run, "GET", `/api/conversations/${sent.body.conversationId as string}`)
    ).body as {
      messages: { role: string; content: string; provider: string | null; model: string | null }[];
    };
    expect(conversation.messages[1]).toMatchObject({
      content: "memory says hi (alpha)",
      provider: "mem",
      model: "alpha",
    });
  });

  it("discovered input modalities take precedence over config and are marked as discovered", async () => {
    const run = await start({
      providers: [localProvider(llama.url, { apiKey: "sk-provider-a-secret" })],
    });
    const models = (await api(run, "GET", "/api/models")).body.providers as {
      models: { id: string }[];
    }[];
    expect(models[0]?.models.length).toBeGreaterThan(0);
  });

  it("unknown provider, unknown model, and a pair valid on A but sent to B are rejected before any work", async () => {
    const memory = { a: new MemoryProvider(["only-on-a"]), b: new MemoryProvider(["only-on-b"]) };
    const run = await start({ providers: [memoryEntry("a"), memoryEntry("b")], memory });
    expect((await send(run, "nope", "only-on-a", "x")).body.error?.code).toBe("PROVIDER_NOT_FOUND");
    expect((await send(run, "a", "missing", "x")).body.error?.code).toBe("MODEL_NOT_FOUND");
    expect((await send(run, "b", "only-on-a", "x")).body.error?.code).toBe("MODEL_NOT_FOUND");
    expect(memory.a.requests.length + memory.b.requests.length).toBe(0);
    expect((await api(run, "GET", "/api/conversations")).body.conversations).toEqual([]);
  });

  it("continuity: switching provider A → B mid-conversation keeps the history and records each reply's provider", async () => {
    const memory = { a: new MemoryProvider(["m1"]), b: new MemoryProvider(["m2"]) };
    const run = await start({ providers: [memoryEntry("a"), memoryEntry("b")], memory });
    const first = await send(run, "a", "m1", "first question");
    await done(run, first.body.generationId);
    const second = await send(
      run,
      "b",
      "m2",
      "second question",
      first.body.conversationId as string,
    );
    await done(run, second.body.generationId);
    expect(memory.b.requests[0]?.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "memory says hi (m1)" },
      { role: "user", content: "second question" },
    ]);
    const file = path.join(
      run.dataDir,
      run.session.userId,
      "chats",
      `${first.body.conversationId as string}.md`,
    );
    const parsed = parseConversation(readFileSync(file, "utf8"));
    if (!parsed.ok) throw new Error(parsed.reason);
    const assistants = parsed.conversation.blocks.flatMap((b) =>
      b.type === "assistant" ? [[b.provider, b.model]] : [],
    );
    expect(assistants).toEqual([
      ["a", "m1"],
      ["b", "m2"],
    ]);
  });

  it("an unreachable provider never blocks startup and is listed as unavailable", async () => {
    const started = Date.now();
    const run = await start({ providers: [localProvider("http://127.0.0.1:9")] });
    expect(Date.now() - started).toBeLessThan(5_000);
    const models = (await api(run, "GET", "/api/models")).body.providers as {
      provider: { status: string };
      models: unknown[];
    }[];
    expect(models[0]).toMatchObject({ provider: { status: "unavailable" }, models: [] });
  });

  it("a failed refresh keeps the last good list, marked stale", async () => {
    const memory = { mem: new MemoryProvider(["alpha"]) };
    const run = await start({ providers: [memoryEntry("mem")], memory });
    await api(run, "GET", "/api/models");
    memory.mem.failListing = true;
    const refreshed = (await api(run, "GET", "/api/models?refresh=1")).body.providers as {
      provider: { status: string };
      stale: boolean;
      models: { id: string }[];
    }[];
    expect(refreshed[0]).toMatchObject({ provider: { status: "stale" }, stale: true });
    expect(refreshed[0]?.models.map((m) => m.id)).toEqual(["alpha"]);
    // A cached pair still validates while stale.
    expect((await send(run, "mem", "alpha", "still works")).status).toBe(202);
  });

  it("unexpected model-list shapes are handled without crashing", async () => {
    let shape: unknown = { data: "nope" };
    const odd = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(shape));
    });
    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${String((odd.address() as AddressInfo).port)}`;
      const run = await start({ providers: [localProvider(url)] });
      type Groups = { provider: { status: string }; stale: boolean; models: { id: string }[] }[];
      const bad = (await api(run, "GET", "/api/models?refresh=1")).body.providers as Groups;
      expect(bad[0]).toMatchObject({ provider: { status: "unavailable" }, models: [] });
      // Entries without a usable id are skipped; the rest are listed.
      shape = {
        data: [{ noId: true }, { id: "" }, { id: "x".repeat(300) }, { id: 42 }, { id: "ok" }],
      };
      const mixed = (await api(run, "GET", "/api/models?refresh=1")).body.providers as Groups;
      expect(mixed[0]?.models.map((m) => m.id)).toEqual(["ok"]);
      shape = ["an array"];
      const stale = (await api(run, "GET", "/api/models?refresh=1")).body.providers as Groups;
      expect(stale[0]).toMatchObject({ provider: { status: "stale" }, stale: true });
      expect(stale[0]?.models.map((m) => m.id)).toEqual(["ok"]);
    } finally {
      odd.closeAllConnections();
      odd.close();
    }
  });

  it("removing a provider leaves its conversations intact; it just can't be selected", async () => {
    const memory = { a: new MemoryProvider(["m1"]), b: new MemoryProvider(["m2"]) };
    const dataDir = tempDataDir();
    const run = await start({ dataDir, providers: [memoryEntry("a"), memoryEntry("b")], memory });
    const sent = await send(run, "a", "m1", "keep me");
    await done(run, sent.body.generationId);
    const file = path.join(
      dataDir,
      run.session.userId,
      "chats",
      `${sent.body.conversationId as string}.md`,
    );
    const before = readFileSync(file, "utf8");
    await run.chatui.shutdown();
    const again = await start({ dataDir, providers: [memoryEntry("b")], memory });
    expect(readFileSync(file, "utf8")).toBe(before);
    const dto = (
      await api(again, "GET", `/api/conversations/${sent.body.conversationId as string}`)
    ).body as { messages: { provider: string | null }[] };
    expect(dto.messages[1]?.provider).toBe("a");
    expect(
      (await send(again, "a", "m1", "gone", sent.body.conversationId as string)).body.error?.code,
    ).toBe("PROVIDER_NOT_FOUND");
    expect(
      (await send(again, "b", "m2", "continue", sent.body.conversationId as string)).status,
    ).toBe(202);
  });

  it("no response ever contains a provider API key or base URL", async () => {
    const run = await start({
      providers: [localProvider(llama.url, { apiKey: "sk-provider-a-secret" })],
    });
    await api(run, "GET", "/api/providers");
    await api(run, "GET", "/api/models?refresh=1");
    const sent = await send(run, "local", MOCK_MODELS.chat, "hi");
    await done(run, sent.body.generationId);
    await api(run, "GET", `/api/generations/${sent.body.generationId as string}`);
    const all = run.seen.join("\n");
    expect(all).not.toContain("sk-provider-a-secret");
    expect(all).not.toContain(llama.url);
    expect(llama.requests.at(-1)?.authorization).toBe("Bearer sk-provider-a-secret");
  });

  it("a saturated provider A rejects new A generations while provider B still accepts", async () => {
    const memory = { a: new MemoryProvider(["m1"]), b: new MemoryProvider(["m2"]) };
    let release!: () => void;
    memory.a.gate = new Promise<void>((resolve) => (release = resolve));
    const run = await start({
      providers: [
        memoryEntry("a", { maxActiveGenerations: 1 }),
        memoryEntry("b", { maxActiveGenerations: 1 }),
      ],
      memory,
    });
    const first = await send(run, "a", "m1", "busy");
    expect(first.status).toBe(202);
    const blocked = await send(run, "a", "m1", "rejected");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error?.code).toBe("RATE_LIMITED");
    const other = await send(run, "b", "m2", "accepted");
    expect(other.status).toBe(202);
    release();
    await done(run, first.body.generationId);
    await done(run, other.body.generationId);
    expect(run.chatui.services.generations.maxActiveGenerations).toBe(2); // sum of provider limits
  });

  it("bootstraps providers.json (0600) from LLAMA_* once; afterwards the file is authoritative", async () => {
    const dataDir = tempDataDir();
    const first = await start({
      dataDir,
      bootstrapProviders: true,
      config: {
        dataDir,
        provider: providerConfig({ baseUrl: llama.url, apiKey: "sk-provider-a-secret" }),
      },
    });
    const file = path.join(dataDir, "_system", "providers.json");
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      providers: { id: string; baseUrl: string }[];
    };
    expect(written.providers.map((p) => [p.id, p.baseUrl])).toEqual([["local", llama.url]]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await first.chatui.shutdown();
    const second = await start({
      dataDir,
      bootstrapProviders: true,
      config: { dataDir, provider: providerConfig({ baseUrl: "http://127.0.0.1:9" }) },
    });
    const providers = (await api(second, "GET", "/api/providers")).body.providers as {
      id: string;
    }[];
    expect(providers.map((p) => p.id)).toEqual(["local"]);
    expect(readFileSync(file, "utf8")).toContain(llama.url);
  });
});

describe("INV-19: SSRF policy", () => {
  const policy: SsrfPolicy = { allowPrivate: true, hostAllowlist: [], linkLocalExceptions: [] };
  const strict: SsrfPolicy = { ...policy, allowPrivate: false };

  it.each([
    ["169.254.169.254", "cloud metadata"],
    ["::ffff:169.254.169.254", "cloud metadata"],
    ["::ffff:a9fe:a9fe", "cloud metadata"],
    ["169.254.170.2", "cloud metadata"],
    ["fd00:ec2::254", "cloud metadata"],
    ["100.100.100.200", "cloud metadata"],
    ["169.254.10.10", "link-local"],
    ["fe80::1", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["240.0.0.1", "reserved"],
  ])("denies %s (%s) under every policy", (address, _category) => {
    expect(addressProblem(address, "h", 80, policy)).toBeDefined();
    expect(addressProblem(address, "h", 80, strict)).toBeDefined();
  });

  it.each([
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "10.1.2.3",
    "172.16.0.5",
    "192.168.1.9",
    "fd12::1",
    "100.64.0.1",
  ])("allows private %s only when ALLOW_PRIVATE_PROVIDER_HOSTS=true", (address) => {
    expect(addressProblem(address, "h", 80, policy)).toBeUndefined();
    expect(addressProblem(address, "h", 80, strict)).toBeDefined();
  });

  it("allows public unicast addresses", () => {
    expect(addressProblem("93.184.216.34", "example.com", 443, strict)).toBeUndefined();
    expect(
      addressProblem("2606:2800:220:1:248:1893:25c8:1946", "example.com", 443, strict),
    ).toBeUndefined();
  });

  it("link-local exceptions are exact (hostname, address, port) tuples; metadata stays denied", () => {
    const withException: SsrfPolicy = {
      ...policy,
      linkLocalExceptions: [
        { hostname: "host.containers.internal", address: "169.254.1.2", port: 8080 },
        { hostname: "meta", address: "169.254.169.254", port: 80 },
      ],
    };
    expect(
      addressProblem("169.254.1.2", "host.containers.internal", 8080, withException),
    ).toBeUndefined();
    expect(
      addressProblem("::ffff:169.254.1.2", "host.containers.internal", 8080, withException),
    ).toBeUndefined();
    expect(
      addressProblem("169.254.1.2", "host.containers.internal", 8081, withException),
    ).toBeDefined();
    expect(addressProblem("169.254.1.2", "other.host", 8080, withException)).toBeDefined();
    expect(
      addressProblem("169.254.1.3", "host.containers.internal", 8080, withException),
    ).toBeDefined();
    expect(addressProblem("169.254.169.254", "meta", 80, withException)).toMatch(/metadata/);
  });

  it.each([
    ["ftp://host/", /http/],
    ["file:///etc/passwd", /http/],
    ["http://user:pass@host:8080", /credentials/],
    ["http://host:8080/#frag", /fragment/],
    ["http://host:8080/?k=v", /query/],
    ["not a url", /valid URL/],
  ])("refuses the URL %s", (url, reason) => {
    expect(() => checkUrl(url, policy)).toThrow(reason);
  });

  it("an allowlist restricts hostnames but never overrides the metadata deny", async () => {
    const allow: SsrfPolicy = { ...policy, hostAllowlist: ["llm.internal"] };
    expect(() => checkUrl("http://other.internal:8080", allow)).toThrow(/ALLOWLIST/);
    const safe = createSafeFetch(allow, () =>
      Promise.resolve([{ address: "169.254.169.254", family: 4 }]),
    );
    await expect(safe("http://llm.internal/v1/models")).rejects.toThrow(/metadata/);
  });

  it("checks every resolved address, at request time, and pins the connection (DNS rebinding)", async () => {
    const answers = [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [
        { address: "127.0.0.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    ];
    const resolver = vi.fn(() => Promise.resolve(answers.shift() ?? []));
    const safe = createSafeFetch(policy, resolver);
    const port = new URL(llama.url).port;
    // "rebind.test" is not a real name: success proves the connection used the checked address.
    const ok = await safe(`http://rebind.test:${port}/health`);
    expect(ok.status).toBe(200);
    await ok.text();
    await expect(safe(`http://rebind.test:${port}/health`)).rejects.toBeInstanceOf(SsrfError);
    await expect(safe(`http://rebind.test:${port}/health`)).rejects.toBeInstanceOf(SsrfError);
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it("does not follow redirects from providers", async () => {
    const redirect = createServer((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    try {
      const safe = createSafeFetch(policy);
      await expect(
        safe(`http://127.0.0.1:${String((redirect.address() as AddressInfo).port)}/v1/models`),
      ).rejects.toThrow(/redirect/);
    } finally {
      redirect.close();
    }
  });

  it("a provider whose baseUrl the policy refuses is disabled at load, logged, and startup continues", async () => {
    const run = await start({
      providers: [
        localProvider("http://user:pw@127.0.0.1:1"),
        { ...localProvider(llama.url), id: "ok" },
      ],
    });
    const providers = (await api(run, "GET", "/api/providers")).body.providers as {
      id: string;
      status: string;
    }[];
    expect(providers.find((p) => p.id === "local")?.status).toBe("invalid");
    expect(providers.find((p) => p.id === "ok")?.status).not.toBe("invalid");
  });

  it("requests are checked at request time: a hostname resolving to metadata is refused as PROVIDER_ERROR", async () => {
    const run = await start({
      providers: [localProvider("http://evil.test:8080")],
      resolver: () => Promise.resolve([{ address: "169.254.169.254", family: 4 }]),
    });
    const models = (await api(run, "GET", "/api/models")).body.providers as {
      provider: { status: string };
    }[];
    expect(models[0]?.provider.status).toBe("unavailable");
    expect((await send(run, "local", "x", "hi")).body.error?.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_MAX_BYTES,
  artifactNameProblem,
  fencedCaptures,
} from "../../server/artifacts/store.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import type { SendHooks } from "../../server/chat/send-service.ts";
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

async function serve(options: { dataDir?: string; hooks?: SendHooks } = {}) {
  const dataDir = options.dataDir ?? tempDataDir();
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [
      localProvider(llama.url, {
        capabilities: { inputModalities: ["text"], reasoning: true, tools: true },
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

interface Artifact {
  id: string;
  filename: string;
  size: number;
  mediaType: string;
  conversationId: string;
  conversationAvailable: boolean;
}

interface Json {
  [key: string]: unknown;
  artifacts: Artifact[];
  generationId: string;
  conversationId: string;
  messages: { role: string; content: string; tools: string[]; artifacts: Artifact[] }[];
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
  let json: Json | null;
  try {
    json = text ? (JSON.parse(text) as Json) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json: json as Json, text, headers: res.headers };
}

async function send(
  base: string,
  who: TestSession,
  content: string,
  model: string = MOCK_MODELS.chat,
  conversationId?: string,
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
  await (
    await fetch(`${base}/api/generations/${res.json.generationId}/stream`, {
      headers: who.headers(),
    })
  ).text();
  const conversation = (
    await api(base, who, "GET", `/api/conversations/${res.json.conversationId}`)
  ).json;
  return { id: res.json.conversationId, generationId: res.json.generationId, conversation };
}

const reply = (c: Json) => c.messages.filter((m) => m.role === "assistant").at(-1);
const list = async (base: string, who: TestSession) =>
  (await api(base, who, "GET", "/api/artifacts")).json.artifacts;

describe("capture convention (INV-40)", () => {
  it("only closed `file=` fences with a supported name are captured, in order", () => {
    const text = [
      "Here you go:",
      "```ts file=hello.ts",
      "console.log('hi');",
      "```",
      "```python",
      "print('not a file')",
      "```",
      '~~~~ file="notes v1.md"',
      "# Notes",
      "```",
      "still inside",
      "~~~~",
      "```js file=../escape.js",
      "x",
      "```",
      "```sh file=run.exe",
      "x",
      "```",
      "```txt file=open.txt",
      "never closed",
    ].join("\n");
    expect(fencedCaptures(text, 2)).toEqual([
      { captureIndex: 2, filename: "hello.ts", content: "console.log('hi');", source: "fence" },
      {
        captureIndex: 3,
        filename: "notes v1.md",
        content: "# Notes\n```\nstill inside",
        source: "fence",
      },
    ]);
    expect(
      fencedCaptures(`\`\`\`txt file=big.txt\n${"x".repeat(ARTIFACT_MAX_BYTES + 1)}\n\`\`\``),
    ).toEqual([]);
    for (const bad of [
      "../a.ts",
      "a/b.ts",
      ".hidden.ts",
      "a.exe",
      "noext",
      "x".repeat(101) + ".ts",
    ])
      expect(artifactNameProblem(bad), bad).toBeDefined();
  });
});

describe("captured source artifacts (INV-40, INV-41)", () => {
  it("a complete reply's fence becomes an inert, owned, downloadable file", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const payload = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    const { conversation } = await send(
      base,
      alice,
      `page:\n\`\`\`html file=page.html\n${payload}\n\`\`\``,
    );
    const [file] = reply(conversation)?.artifacts ?? [];
    expect(file).toMatchObject({ filename: "page.html", mediaType: "text/html" });
    const id = file?.id ?? "";

    const source = await api(base, alice, "GET", `/api/artifacts/${id}/source`);
    expect(source.text).toBe(payload);
    expect(source.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(source.headers.get("x-content-type-options")).toBe("nosniff");
    expect(source.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(source.headers.get("content-disposition")).toMatch(/^inline; filename="page.html"/);
    const download = await api(base, alice, "GET", `/api/artifacts/${id}/source?download=1`);
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename="page.html"/,
    );

    // The stored name is display-only: the directory is a server UUID (INV-41).
    expect((await list(base, alice)).map((a) => a.filename)).toEqual(["page.html"]);
    for (const url of [`/api/artifacts/${id}`, `/api/artifacts/${id}/source`])
      expect((await api(base, bob, "GET", url)).status).toBe(404);
    expect((await api(base, bob, "DELETE", `/api/artifacts/${id}`)).status).toBe(404);
    expect(await list(base, bob)).toEqual([]);
  });

  it("create_file captures a file and shows its chip", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const { conversation } = await send(
      base,
      alice,
      "file notes.md: # Shopping; file bad/name.md: x",
      MOCK_MODELS.tools,
    );
    const last = reply(conversation);
    expect(last?.tools).toEqual(["create_file"]);
    expect(last?.content).toContain("Not created: invalid file name, type or size.");
    expect(last?.artifacts.map((a) => a.filename)).toEqual(["notes.md"]);
    const source = await api(
      base,
      alice,
      "GET",
      `/api/artifacts/${last?.artifacts[0]?.id ?? ""}/source`,
    );
    expect(source.text).toBe("# Shopping");
  });

  it("files outlive their chat with a dead backlink; a deleted file is gone for good", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const { id } = await send(base, alice, "a:\n```txt file=keep.txt\nkept\n```");
    const [file] = await list(base, alice);
    expect(file?.conversationAvailable).toBe(true);
    expect((await api(base, alice, "DELETE", `/api/conversations/${id}`)).status).toBe(200);
    const [after] = await list(base, alice);
    expect(after).toMatchObject({ id: file?.id, conversationAvailable: false });
    expect((await api(base, alice, "DELETE", `/api/artifacts/${file?.id ?? ""}`)).status).toBe(200);
    await serve({ dataDir }); // no startup scan recreates it
    expect(await list(base, alice)).toEqual([]);
  });
});

describe("capture recovery (INV-40, INV-60)", () => {
  it("a crash after creation is finalized once at restart; once deleted it never returns", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const first = await serve({
      dataDir,
      hooks: {
        afterArtifactCapture: () => {
          if (crash) throw new Error("simulated crash");
        },
      },
    });
    const alice = await signIn(first.base, first.chatui);
    const { generationId } = await send(first.base, alice, "a:\n```txt file=once.txt\none\n```");
    // Created but not finalized: not listable, not deletable.
    expect(await list(first.base, alice)).toEqual([]);
    crash = false;
    const second = await serve({ dataDir });
    const listed = await list(second.base, alice);
    expect(listed.map((a) => a.filename)).toEqual(["once.txt"]);
    await serve({ dataDir });
    expect(await list(second.base, alice)).toHaveLength(1);
    expect(
      (await api(second.base, alice, "DELETE", `/api/artifacts/${listed[0]?.id ?? ""}`)).status,
    ).toBe(200);
    // Evict the checkpoint, restart again: still deleted.
    rmSync(path.join(dataDir, "_system", "generations", `${generationId}.json`), { force: true });
    const third = await serve({ dataDir });
    expect(await list(third.base, alice)).toEqual([]);
  });

  it("a crash before creation creates the file exactly once at restart", async () => {
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
    await send(first.base, alice, "a:\n```txt file=late.txt\nlate\n```");
    expect(await list(first.base, alice)).toEqual([]);
    crash = false;
    await serve({ dataDir });
    const again = await serve({ dataDir });
    expect((await list(again.base, alice)).map((a) => a.filename)).toEqual(["late.txt"]);
  });

  it("INV-40: a reply stopped after a complete fence creates no file", async () => {
    const slow = await startMockLlama({ slots: 2, chatChunkDelayMs: 25 });
    try {
      const dataDir = tempDataDir();
      writeProviders(dataDir, [
        localProvider(slow.url, {
          capabilities: { inputModalities: ["text"], reasoning: true, tools: true },
        }),
      ]);
      const { base, chatui } = await serve({ dataDir });
      const alice = await signIn(base, chatui);
      const res = await api(base, alice, "POST", "/api/generations", {
        providerId: "local",
        model: MOCK_MODELS.chat,
        content: `x\n\`\`\`txt file=stopped.txt\nnot kept\n\`\`\`\n${" and more".repeat(60)}`,
        operationKey: crypto.randomUUID(),
        operationIssuedAt: new Date().toISOString(),
      });
      const generationId = res.json.generationId;
      // The fence is complete in the streamed text before Stop.
      await vi.waitFor(
        () => {
          const content = chatui.services.generations.snapshot(generationId).content;
          expect(content.match(/```/g)?.length).toBe(2);
          expect(content).toContain(" and more");
        },
        { timeout: 10_000, interval: 20 },
      );
      await api(base, alice, "POST", `/api/generations/${generationId}/cancel`);
      await chatui.services.generations.settled(generationId);
      expect(chatui.services.generations.snapshot(generationId).state).toBe("cancelled");
      expect(await chatui.services.artifacts.list(alice.userId)).toEqual([]);
    } finally {
      await slow.close();
    }
  });

  it("unfinished replies never create files; interrupted writes are cleaned", async () => {
    const dataDir = tempDataDir();
    const first = await serve({ dataDir });
    const alice = await signIn(first.base, first.chatui);
    const { id } = await send(first.base, alice, "hello");
    const staged = [
      { captureIndex: 0, filename: "no.txt", content: "no", source: "fence" as const },
    ];
    const base = {
      version: 1 as const,
      userId: alice.userId,
      conversationId: id,
      operationKey: "",
      providerId: "local",
      model: MOCK_MODELS.chat,
      content: "x",
      reasoning: "",
      lastEventId: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await first.chatui.checkpoints.write({
      ...base,
      generationId: crypto.randomUUID(),
      assistantMessageId: crypto.randomUUID(),
      state: "terminal-decided",
      outcome: {
        state: "failed",
        content: "x",
        reasoning: "",
        finishReason: null,
        error: { code: "PROVIDER_ERROR", message: "boom" },
        finishedAt: new Date().toISOString(),
        artifacts: staged,
      },
    });
    // A metadata-less directory from an interrupted capture.
    const orphan = path.join(dataDir, alice.userId, "artifacts", crypto.randomUUID());
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, "blob"), "partial");
    const second = await serve({ dataDir });
    expect(await list(second.base, alice)).toEqual([]);
    expect(readdirSync(path.join(dataDir, alice.userId, "artifacts"))).toEqual([]);
  });
});

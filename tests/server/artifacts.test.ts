import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactList } from "../../shared/artifacts.ts";
import type { ConversationDto } from "../../shared/conversations.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { artifactNameProblem, captureSources } from "../../server/artifacts/capture.ts";
import type { GenerationCheckpoint } from "../../server/storage/checkpoints.ts";
import { serializeConversation } from "../../server/storage/markdown.ts";
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

/** Phase 13c: deterministic capture, inert storage and serving, recovery (INV-40, INV-41). */

const LIMITS = { maxBytes: 1_024, maxPerReply: 3 };

describe("capture convention (deterministic fixtures)", () => {
  const names = (text: string) => captureSources(text, LIMITS).captures.map((c) => c.name);

  it("captures only closed top-level fences labelled file=", () => {
    const text = [
      "Intro",
      "```python file=hello.py",
      "print('hi')",
      "```",
      "```js",
      "no label",
      "```",
      "~~~~ file=notes.md",
      "```not a close",
      "~~~~",
      "    ```py file=indented.py",
      "    x",
      "    ```",
      "> ```py file=quoted.py",
      "> x",
      "> ```",
      '```sh file="run me.sh" extra=1',
      "echo 1",
      "```",
    ].join("\n");
    const { captures } = captureSources(text, { maxBytes: 1_024, maxPerReply: 10 });
    expect(captures).toEqual([
      { captureIndex: 0, name: "hello.py", language: "python", content: "print('hi')\n" },
      { captureIndex: 1, name: "notes.md", language: null, content: "```not a close\n" },
      { captureIndex: 2, name: "run me.sh", language: "sh", content: "echo 1\n" },
    ]);
  });

  it("an unclosed fence and everything after it is never captured", () => {
    expect(names("```py file=a.py\nx\n```py file=b.py\ny")).toEqual([]);
    expect(names("```py file=a.py\nx\n```\n```py file=b.py\ny")).toEqual(["a.py"]);
  });

  it("is deterministic across line endings and repeated runs", () => {
    const lf = "```ts file=a.ts\nconst a = 1;\n```\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(captureSources(crlf, LIMITS)).toEqual(captureSources(lf, LIMITS));
    expect(captureSources(lf, LIMITS)).toEqual(captureSources(lf, LIMITS));
  });

  it("rejects paths, hidden files, unknown types and bad names; never normalizes them", () => {
    for (const bad of [
      "../evil.py",
      "a/b.py",
      "a\\b.py",
      "C:evil.py",
      ".env",
      "run.exe",
      "archive.zip",
      "noext",
      "trailing.py.",
      "tab\there.py",
      "x".repeat(126) + ".py",
      ".",
      "..",
    ])
      expect(artifactNameProblem(bad), bad).toBeDefined();
    for (const good of ["main.py", "Dockerfile", "index.HTML", "my notes.md", "résumé.txt"])
      expect(artifactNameProblem(good), good).toBeUndefined();
    const { captures, rejected } = captureSources(
      "```py file=../evil.py\nx\n```\n```bin file=run.exe\nx\n```",
      LIMITS,
    );
    expect(captures).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["name: path", "name: extension"]);
  });

  it("enforces the size and per-reply limits and skips empty bodies", () => {
    const big = `\`\`\`txt file=big.txt\n${"x".repeat(2_000)}\n\`\`\``;
    const empty = "```txt file=empty.txt\n\n```";
    const many = Array.from({ length: 5 }, (_, i) => `\`\`\`txt file=f${String(i)}.txt\nx\n\`\`\``);
    const { captures, rejected } = captureSources([big, empty, ...many].join("\n"), LIMITS);
    expect(captures.map((c) => [c.captureIndex, c.name])).toEqual([
      [0, "f0.txt"],
      [1, "f1.txt"],
      [2, "f2.txt"],
    ]);
    expect(rejected.map((r) => r.reason)).toEqual([
      "too large",
      "empty",
      "over the per-reply limit",
      "over the per-reply limit",
    ]);
  });
});

// ---------------------------------------------------------------------------

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 8, chunkDelayMs: 40 });
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

async function serve(options: TestAppOptions & { username?: string } = {}): Promise<Served> {
  const dataDir = options.config?.dataDir ?? tempDataDir();
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [localProvider(llama.url, { maxActiveGenerations: 8 })]);
  const { chatui } = testApp({
    ...options,
    config: { provider: providerConfig({ baseUrl: llama.url }), ...options.config, dataDir },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    base,
    chatui,
    dataDir,
    session: await signIn(base, chatui, options.username ?? "alice"),
  };
}

async function restart(dataDir: string, options: TestAppOptions = {}) {
  await stopAll();
  return serve({ ...options, config: { ...options.config, dataDir } });
}

async function api(s: Served, method: string, url: string, session = s.session) {
  const res = await fetch(`${s.base}${url}`, {
    method,
    headers: session.headers(method !== "GET"),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let keySeq = 0;
const key = () => `00000000-0000-4000-9100-${String(++keySeq).padStart(12, "0")}`;

async function send(s: Served, content: string, model: string = MOCK_MODELS.chat, extra = {}) {
  const res = await fetch(`${s.base}/api/generations`, {
    method: "POST",
    headers: { ...s.session.headers(true), "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "local",
      model,
      content,
      operationKey: key(),
      operationIssuedAt: new Date().toISOString(),
      ...extra,
    }),
  });
  const body = (await res.json()) as { conversationId: string; generationId: string };
  return { status: res.status, body };
}

async function settled(s: Served, generationId: string) {
  await s.chatui.services.generations.settled(generationId);
}

const artifactsOf = async (s: Served, session = s.session) =>
  (await api(s, "GET", "/api/artifacts", session)).body as unknown as ArtifactList;

const FILE = "Here it is\n```python file=hello.py\nprint('hi')\n```";

function dirs(s: Served, userId = s.session.userId): string[] {
  const dir = path.join(s.dataDir, userId, "artifacts");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("capture from complete replies only (INV-40)", () => {
  it("a complete reply's labelled block becomes a listed artifact with a transcript card", async () => {
    const s = await serve();
    const { body } = await send(s, FILE);
    await settled(s, body.generationId);
    const list = await artifactsOf(s);
    expect(list.artifacts).toEqual([
      expect.objectContaining({
        name: "hello.py",
        language: "python",
        size: Buffer.byteLength("print('hi')\n"),
        conversationId: body.conversationId,
        captureIndex: 0,
        backlinkAvailable: true,
      }),
    ]);
    const conv = (await api(s, "GET", `/api/conversations/${body.conversationId}`))
      .body as unknown as ConversationDto;
    const reply = conv.messages.at(-1);
    expect(conv.artifacts).toEqual([
      expect.objectContaining({ name: "hello.py", assistantMessageId: reply?.id, captureIndex: 0 }),
    ]);
    // The stored directory is named by id; the display name is only in meta.json.
    expect(dirs(s)).toEqual([list.artifacts[0]?.id]);
  });

  it("failed and cancelled replies create nothing", async () => {
    const s = await serve();
    const failed = await send(s, FILE, MOCK_MODELS.earlyEnd);
    await settled(s, failed.body.generationId);
    const slow = await send(s, FILE, MOCK_MODELS.slow);
    await new Promise((r) => setTimeout(r, 100));
    await api(s, "POST", `/api/generations/${slow.body.generationId}/cancel`);
    await settled(s, slow.body.generationId);
    const conv = (await api(s, "GET", `/api/conversations/${slow.body.conversationId}`))
      .body as unknown as ConversationDto;
    expect(conv.messages.at(-1)).toMatchObject({ status: "cancelled" });
    expect(conv.messages.at(-1)?.content).toContain("file=hello.py");
    expect((await artifactsOf(s)).artifacts).toEqual([]);
    expect(dirs(s)).toEqual([]);
  });

  it("rejected names, types and sizes are not captured", async () => {
    const s = await serve({ config: { artifacts: { maxBytes: 1_024 } } });
    const text = [
      "```py file=../evil.py\nx\n```",
      "```bin file=run.exe\nx\n```",
      `\`\`\`txt file=big.txt\n${"y".repeat(2_000)}\n\`\`\``,
    ].join("\n");
    const { body } = await send(s, `x\n${text}`);
    await settled(s, body.generationId);
    expect((await artifactsOf(s)).artifacts).toEqual([]);
  });

  it("stops capturing at the user's quota", async () => {
    const s = await serve({ config: { artifacts: { quotaBytes: 1_100 } } });
    const block = (n: number) => `\`\`\`txt file=f${String(n)}.txt\n${"q".repeat(600)}\n\`\`\``;
    const { body } = await send(s, `x\n${block(1)}\n${block(2)}`);
    await settled(s, body.generationId);
    expect((await artifactsOf(s)).artifacts.map((a) => a.name)).toEqual(["f1.txt"]);
  });

  it("never scans historical assistant content", async () => {
    const dataDir = tempDataDir();
    const s = await serve({ config: { dataDir } });
    const id = randomUUID();
    const chats = path.join(dataDir, s.session.userId, "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(
      path.join(chats, `${id}.md`),
      serializeConversation({
        title: "Old",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        blocks: [
          { type: "user", id: randomUUID(), body: "hi" },
          { type: "assistant", id: randomUUID(), status: "complete", body: FILE },
        ],
      }),
    );
    const again = await restart(dataDir);
    expect((await artifactsOf(again)).artifacts).toEqual([]);
  });
});

describe("inert source (INV-41)", () => {
  it("HTML, SVG and script payloads are served as nosniff text/plain with a sandbox CSP", async () => {
    const s = await serve();
    const payload = "<script>alert(document.cookie)</script><img src=x onerror=alert(1)>";
    const text = [
      `\`\`\`html file=page.html\n${payload}\n\`\`\``,
      '```svg file=ev"il.svg\n<svg onload="alert(1)"/>\n```',
    ].join("\n");
    const { body } = await send(s, `x\n${text}`);
    await settled(s, body.generationId);
    const list = await artifactsOf(s);
    expect(list.artifacts.map((a) => a.name)).toEqual(["page.html", 'ev"il.svg']);
    for (const artifact of list.artifacts) {
      const res = await fetch(`${s.base}/api/artifacts/${artifact.id}/source`, {
        headers: s.session.headers(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      expect(res.headers.get("content-disposition")).toMatch(
        /^inline; filename="[^"]*"; filename\*=UTF-8''/,
      );
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      await res.text();
    }
    const html = list.artifacts[0];
    const source = await fetch(`${s.base}/api/artifacts/${html?.id ?? ""}/source`, {
      headers: s.session.headers(),
    });
    expect(await source.text()).toBe(`${payload}\n`);
    const download = await fetch(
      `${s.base}/api/artifacts/${list.artifacts[1]?.id ?? ""}/source?download=1`,
      {
        headers: s.session.headers(),
      },
    );
    // The quote is never passed through into the header value.
    expect(download.headers.get("content-disposition")).toBe(
      "attachment; filename=\"ev_il.svg\"; filename*=UTF-8''ev%22il.svg",
    );
    await download.text();
  });
});

describe("ownership and lifecycle (INV-39, INV-40)", () => {
  it("another account gets 404 for list, metadata, source and delete", async () => {
    const s = await serve();
    const { body } = await send(s, FILE);
    await settled(s, body.generationId);
    const [artifact] = (await artifactsOf(s)).artifacts;
    const bob = await signIn(s.base, s.chatui, "bob");
    expect((await artifactsOf(s, bob)).artifacts).toEqual([]);
    for (const [method, url] of [
      ["GET", `/api/artifacts/${artifact?.id ?? ""}`],
      ["DELETE", `/api/artifacts/${artifact?.id ?? ""}`],
    ] as const)
      expect((await api(s, method, url, bob)).status).toBe(404);
    const source = await fetch(`${s.base}/api/artifacts/${artifact?.id ?? ""}/source`, {
      headers: bob.headers(),
    });
    expect(source.status).toBe(404);
    expect(source.headers.get("content-type")).toMatch(/^application\/json/);
    await source.text();
    expect((await artifactsOf(s)).artifacts).toHaveLength(1);
  });

  it("survives conversation deletion and clear history with a dead backlink; deletes independently", async () => {
    const s = await serve();
    const { body } = await send(s, FILE);
    await settled(s, body.generationId);
    expect((await api(s, "DELETE", `/api/conversations/${body.conversationId}`)).status).toBe(200);
    let [artifact] = (await artifactsOf(s)).artifacts;
    expect(artifact).toMatchObject({ name: "hello.py", backlinkAvailable: false });
    const second = await send(s, FILE);
    await settled(s, second.body.generationId);
    await api(s, "DELETE", "/api/conversations");
    expect((await artifactsOf(s)).artifacts).toHaveLength(2);
    [artifact] = (await artifactsOf(s)).artifacts;
    expect((await api(s, "DELETE", `/api/artifacts/${artifact?.id ?? ""}`)).status).toBe(200);
    expect((await artifactsOf(s)).artifacts).toHaveLength(1);
    expect((await api(s, "GET", `/api/artifacts/${artifact?.id ?? ""}`)).status).toBe(404);
  });
});

describe("recovery and non-resurrection (INV-40, INV-60)", () => {
  it("crash after creation, before finalization: finalized once; deleted stays deleted after eviction", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const s = await serve({
      config: { dataDir },
      artifactHooks: {
        afterCreate: () => {
          if (crash) throw new Error("crash after artifact creation");
        },
      },
    });
    const { body } = await send(s, FILE);
    await settled(s, body.generationId);
    crash = false;
    // Created but unfinalized: not listed, not viewable, not deletable.
    expect(dirs(s)).toHaveLength(1);
    expect((await artifactsOf(s)).artifacts).toEqual([]);
    const [unfinalized] = dirs(s);
    expect((await api(s, "DELETE", `/api/artifacts/${unfinalized ?? ""}`)).status).toBe(404);
    const checkpoint = (await s.chatui.checkpoints.read(body.generationId)) as GenerationCheckpoint;
    expect(checkpoint.state).toBe("terminal-decided");
    expect(checkpoint.outcome?.captures).toHaveLength(1);

    const again = await restart(dataDir);
    const [finalized] = (await artifactsOf(again)).artifacts;
    expect(finalized?.id).toBe(unfinalized);
    expect(dirs(again)).toHaveLength(1);
    expect((await api(again, "DELETE", `/api/artifacts/${finalized?.id ?? ""}`)).status).toBe(200);
    // Evict the finalized checkpoint (retention), restart: still deleted.
    rmSync(path.join(dataDir, "_system", "generations", `${body.generationId}.json`));
    const third = await restart(dataDir);
    expect((await artifactsOf(third)).artifacts).toEqual([]);
    expect(dirs(third)).toEqual([]);
  });

  it("deleting an artifact finalizes a still-open checkpoint, so no restart recreates it", async () => {
    const dataDir = tempDataDir();
    const s = await serve({ config: { dataDir } });
    const { body } = await send(s, FILE);
    await settled(s, body.generationId);
    // Simulate a failed `terminal` checkpoint write after a finished capture.
    const file = path.join(dataDir, "_system", "generations", `${body.generationId}.json`);
    const checkpoint = JSON.parse(readFileSync(file, "utf8")) as GenerationCheckpoint;
    writeFileSync(file, JSON.stringify({ ...checkpoint, state: "terminal-decided" }));
    const [artifact] = (await artifactsOf(s)).artifacts;
    await api(s, "DELETE", `/api/artifacts/${artifact?.id ?? ""}`);
    expect((JSON.parse(readFileSync(file, "utf8")) as GenerationCheckpoint).state).toBe("terminal");
    const again = await restart(dataDir);
    expect((await artifactsOf(again)).artifacts).toEqual([]);
  });

  it("a crash before creation creates the artifact exactly once", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const s = await serve({
      config: { dataDir },
      send: {
        hooks: {
          afterAssistantWrite: () => {
            if (crash) throw new Error("crash before capture");
          },
        },
      },
    });
    const { body } = await send(s, FILE);
    await settled(s, body.generationId);
    crash = false;
    expect(dirs(s)).toEqual([]);
    const again = await restart(dataDir);
    expect((await artifactsOf(again)).artifacts.map((a) => a.name)).toEqual(["hello.py"]);
    const twice = await restart(dataDir);
    expect((await artifactsOf(twice)).artifacts).toHaveLength(1);
    expect(dirs(twice)).toHaveLength(1);
  });

  it("a deleted originating conversation is never recaptured", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const s = await serve({
      config: { dataDir },
      send: {
        hooks: {
          afterAssistantWrite: () => {
            if (crash) throw new Error("crash before capture");
          },
        },
      },
    });
    const { body } = await send(s, FILE);
    await settled(s, body.generationId);
    crash = false;
    rmSync(path.join(dataDir, s.session.userId, "chats", `${body.conversationId}.md`));
    const again = await restart(dataDir);
    expect((await artifactsOf(again)).artifacts).toEqual([]);
    expect(dirs(again)).toEqual([]);
  });

  it("interrupted writes are cleaned at startup; interrupted replies capture nothing", async () => {
    const dataDir = tempDataDir();
    const s = await serve({ config: { dataDir } });
    const root = path.join(dataDir, s.session.userId, "artifacts");
    // A blob without metadata (crash between the two writes).
    const noMeta = randomUUID();
    mkdirSync(path.join(root, noMeta), { recursive: true });
    writeFileSync(path.join(root, noMeta, "blob"), "partial");
    // Unfinalized metadata whose generation has no open checkpoint.
    const orphan = randomUUID();
    mkdirSync(path.join(root, orphan), { recursive: true });
    writeFileSync(path.join(root, orphan, "blob"), "x\n");
    writeFileSync(
      path.join(root, orphan, "meta.json"),
      JSON.stringify({
        version: 1,
        id: orphan,
        name: "o.txt",
        language: null,
        mediaType: "text/plain",
        size: 2,
        sha256: "0".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "generated",
        conversationId: null,
        assistantMessageId: null,
        generationId: randomUUID(),
        captureIndex: 0,
        finalized: false,
      }),
    );
    // A reply still streaming at "crash" time (shutdown leaves it running).
    await send(s, FILE, MOCK_MODELS.slow);
    await new Promise((r) => setTimeout(r, 150));
    const again = await restart(dataDir);
    const report = await again.chatui.ready;
    expect(report.artifacts).toEqual({ incompleteRemoved: 1, unfinalizedRemoved: 1 });
    expect(dirs(again)).toEqual([]);
    expect((await artifactsOf(again)).artifacts).toEqual([]);
  });
});

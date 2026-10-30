import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import { makePng } from "../support/media.ts";
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

async function serve(dataDir = tempDataDir()) {
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [
      localProvider(llama.url, {
        capabilities: { inputModalities: ["text", "image"], reasoning: true, tools: true },
      }),
    ]);
  const { chatui } = testApp({
    config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
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
  id: string;
  conversationId: string;
  generationId: string;
  temporary: boolean;
  conversations: { id: string }[];
  chats: { conversationId: string }[];
  files: { id: string }[];
  attachments: { id: string }[];
  artifacts: unknown[];
  messages: { role: string; content: string; artifacts: unknown[]; tools: string[] }[];
  proposals: unknown[];
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
  const buffer = Buffer.from(await res.arrayBuffer());
  const json = (
    res.headers.get("content-type")?.startsWith("application/json")
      ? JSON.parse(buffer.toString())
      : null
  ) as Json;
  return { status: res.status, json, buffer };
}

async function send(
  base: string,
  who: TestSession,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const res = await api(base, who, "POST", "/api/generations", {
    providerId: "local",
    model: MOCK_MODELS.chat,
    content,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
    ...extra,
  });
  if (res.status !== 202) return res;
  await (
    await fetch(`${base}/api/generations/${res.json.generationId}/stream`, {
      headers: who.headers(),
    })
  ).text();
  return res;
}

const chatRequests = (from: number) =>
  llama.requests
    .slice(from)
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => r.body as { tools?: { function: { name: string } }[]; messages: unknown[] });

describe("temporary chats (Phase 13f)", () => {
  it("are kept out of the sidebar, search, the Library, exports and memory", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    await api(base, alice, "POST", "/api/memories", {
      name: "Secret",
      body: "never in temporary prompts",
    });
    const upload = new FormData();
    upload.append("file", new Blob([new Uint8Array(makePng(4, 4))]), "temp.png");
    const image = (await (
      await fetch(`${base}/api/attachments`, {
        method: "POST",
        headers: alice.headers(true),
        body: upload,
      })
    ).json()) as { id: string };
    const from = llama.requests.length;
    const sent = await send(base, alice, "ghostword here", {
      temporary: true,
      model: MOCK_MODELS.vision,
      attachmentIds: [image.id],
    });
    expect(sent.status).toBe(202);
    const id = sent.json.conversationId;
    // Memories are neither in the prompt nor suggested.
    expect(JSON.stringify(chatRequests(from)[0]?.messages)).not.toContain(
      "never in temporary prompts",
    );
    const second = llama.requests.length;
    await send(base, alice, "x\n```txt file=gone.txt\nno capture\n```", {
      conversationId: id,
      model: MOCK_MODELS.tools,
    });
    const offered = (chatRequests(second)[0]?.tools ?? []).map((t) => t.function.name);
    expect(offered).toContain("search_chats");
    expect(offered).not.toContain("remember");
    expect(offered).not.toContain("create_file");

    const dto = (await api(base, alice, "GET", `/api/conversations/${id}`)).json;
    expect(dto.temporary).toBe(true);
    expect(dto.messages.at(-1)?.artifacts).toEqual([]);
    expect((await api(base, alice, "GET", "/api/artifacts")).json.artifacts).toEqual([]);
    expect((await api(base, alice, "GET", "/api/conversations")).json.conversations).toEqual([]);
    const search = (await api(base, alice, "GET", "/api/search?q=ghostword")).json;
    expect(search.chats).toEqual([]);
    expect((await api(base, alice, "GET", "/api/search?q=temp.png")).json.files).toEqual([]);
    expect((await api(base, alice, "GET", "/api/attachments")).json.attachments).toEqual([]);
    const archive = await api(base, alice, "GET", "/api/export");
    expect(archive.buffer.includes(Buffer.from(id))).toBe(false);
    // A normal chat is still listed.
    await send(base, alice, "kept");
    expect((await api(base, alice, "GET", "/api/conversations")).json.conversations).toHaveLength(
      1,
    );
    // Leaving deletes it, with its files and its registry entry.
    expect((await api(base, alice, "DELETE", `/api/conversations/${id}`)).status).toBe(200);
    expect(existsSync(path.join(dataDir, alice.userId, "chats", `${id}.md`))).toBe(false);
    expect(existsSync(path.join(dataDir, alice.userId, "attachments", image.id))).toBe(false);
    expect(readFileSync(path.join(dataDir, alice.userId, "temporary.json"), "utf8")).not.toContain(
      id,
    );
  });

  it("only a new chat can be temporary", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const first = await send(base, alice, "normal");
    const res = await send(base, alice, "now temporary?", {
      conversationId: first.json.conversationId,
      temporary: true,
    });
    expect(res.status).toBe(400);
  });

  it("a temporary chat left open is removed after a day, at startup", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const { json } = await send(base, alice, "left open", { temporary: true });
    const registry = path.join(dataDir, alice.userId, "temporary.json");
    const old = JSON.parse(readFileSync(registry, "utf8")) as { chats: Record<string, number> };
    old.chats[json.conversationId] = Date.now() - 25 * 3_600_000;
    writeFileSync(registry, JSON.stringify(old));
    const again = await serve(dataDir);
    expect(
      (await api(again.base, alice, "GET", `/api/conversations/${json.conversationId}`)).status,
    ).toBe(404);
    expect(existsSync(path.join(dataDir, alice.userId, "chats", `${json.conversationId}.md`))).toBe(
      false,
    );
  });
});

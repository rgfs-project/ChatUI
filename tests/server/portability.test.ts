import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppOptions, ChatUiApp } from "../../server/create-app.ts";
import { ZipReader, ZipWriter } from "../../server/portability/zip.ts";
import { parseConversation } from "../../server/storage/markdown.ts";
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
  llama = await startMockLlama({ slots: 4, chunkDelayMs: 40, slowChunks: 100 });
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

type Extra = Pick<AppOptions, "imports" | "exportHooks">;

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

function last<T>(items: readonly T[]): T {
  const item = items.at(-1);
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

async function serve(options: { dataDir?: string } & Extra = {}) {
  const dataDir = options.dataDir ?? tempDataDir();
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [
      localProvider(llama.url, {
        apiKey: "PROVIDER-SECRET-KEY-123",
        capabilities: { inputModalities: ["text", "image"], reasoning: true, tools: true },
      }),
    ]);
  const { chatui } = testApp({
    config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
    ...(options.imports ? { imports: options.imports } : {}),
    ...(options.exportHooks ? { exportHooks: options.exportHooks } : {}),
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
  importId: string;
  idempotencyKey: string;
  alreadyImported: boolean;
  conversationId: string;
  generationId: string;
  error: { message: string };
  chats: Record<string, number>;
  counts: Record<string, number>;
  conflicts: { kind: string; id: string }[];
  skipped: { kind: string; reason: string }[];
  memories: { id: string; body: string; revision: string; status: string }[];
  conversations: { id: string; title: string }[];
  proposals: { id: string; status: string }[];
  messages: { attachments: { id: string; missing: boolean }[]; artifacts: { id: string }[] }[];
  artifacts: { id: string; conversationId: string; conversationAvailable: boolean }[];
  attachments: unknown[];
  pins: string[];
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
      ? JSON.parse(buffer.toString("utf8"))
      : null
  ) as Json;
  return { status: res.status, json, buffer, headers: res.headers };
}

async function send(
  base: string,
  who: TestSession,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const { noWait, ...fields } = extra;
  const res = await api(base, who, "POST", "/api/generations", {
    providerId: "local",
    model: MOCK_MODELS.chat,
    content,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
    ...fields,
  });
  expect(res.status).toBe(202);
  if (!noWait)
    await (
      await fetch(`${base}/api/generations/${res.json.generationId}/stream`, {
        headers: who.headers(),
      })
    ).text();
  return res.json;
}

async function upload(base: string, who: TestSession, url: string, name: string, bytes: Buffer) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), name);
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: who.headers(true),
    body: form,
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

const exportZip = async (base: string, who: TestSession) => {
  const res = await api(base, who, "GET", "/api/export");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  return res.buffer;
};

async function entries(zip: Buffer, dir: string) {
  const file = path.join(dir, `inspect-${crypto.randomUUID()}.zip`);
  writeFileSync(file, zip);
  const reader = await ZipReader.open(file, {
    maxEntries: 10_000,
    maxEntryBytes: 1e9,
    maxTotalBytes: 1e10,
    maxRatio: 1e6,
    maxDepth: 5,
  });
  const out = new Map<string, Buffer>();
  for (const e of reader.entries()) out.set(e.name, await reader.get(e.name));
  await reader.close();
  rmSync(file);
  return out;
}

const preview = (base: string, who: TestSession, zip: Buffer) =>
  upload(base, who, "/api/import", "archive.zip", zip);

const commit = (
  base: string,
  who: TestSession,
  importId: string,
  choices: Record<string, unknown> = { conflicts: "skip", memories: [], preferences: false },
) => api(base, who, "POST", `/api/import/${importId}/commit`, choices);

const chats = async (base: string, who: TestSession) =>
  (await api(base, who, "GET", "/api/conversations")).json.conversations as {
    id: string;
    title: string;
  }[];

/** Alice with a chat holding an image, a Library file, a captured file, a memory and suggestions. */
async function richUser(base: string, chatui: ChatUiApp) {
  const alice = await signIn(base, chatui, "alice");
  const image = await upload(base, alice, "/api/attachments", "photo.png", makePng(8, 8));
  const saved = await upload(
    base,
    alice,
    "/api/attachments?to=library",
    "notes.txt",
    Buffer.from("library notes"),
  );
  await upload(base, alice, "/api/attachments", "pending.txt", Buffer.from("never sent"));
  const sent = await send(base, alice, "look", {
    model: MOCK_MODELS.vision,
    attachmentIds: [image.json.id],
  });
  await send(base, alice, "and a file\n```txt file=out.txt\ncaptured\n```", {
    conversationId: sent.conversationId,
  });
  const memory = await api(base, alice, "POST", "/api/memories", { name: "Pet", body: "A cat" });
  const tools = await send(base, alice, "remember Car: red; update Pet: Two cats", {
    model: MOCK_MODELS.tools,
  });
  const proposals = (await api(base, alice, "GET", `/api/conversations/${tools.conversationId}`))
    .json.proposals;
  await api(
    base,
    alice,
    "POST",
    `/api/conversations/${tools.conversationId}/proposals/${first(proposals).id}/reject`,
  );
  await api(base, alice, "PATCH", "/api/preferences", {
    pins: [sent.conversationId],
    defaultModel: "mock-chat",
    defaultProvider: "local",
  });
  return {
    alice,
    chatId: sent.conversationId,
    toolsChatId: tools.conversationId,
    imageId: image.json.id,
    savedId: saved.json.id,
    memoryId: memory.json.id,
  };
}

describe("single-chat export (contracts §12)", () => {
  it("returns the exact canonical bytes, malformed files included, owner only", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const { conversationId } = await send(base, alice, "Hello export");
    const file = path.join(dataDir, alice.userId, "chats", `${conversationId}.md`);
    const res = await api(base, alice, "GET", `/api/conversations/${conversationId}/export`);
    expect(res.buffer.equals(readFileSync(file))).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="Hello export\.md"/,
    );
    writeFileSync(file, "not canonical at all\r\n");
    const raw = await api(base, alice, "GET", `/api/conversations/${conversationId}/export`);
    expect(raw.buffer.toString()).toBe("not canonical at all\r\n");
    expect(
      (await api(base, bob, "GET", `/api/conversations/${conversationId}/export`)).status,
    ).toBe(404);
  });
});

describe("portable archive (INV-43)", () => {
  it("holds every canonical store with checksums and nothing else; it round-trips into another account", async () => {
    const { base, chatui, dataDir } = await serve();
    const rich = await richUser(base, chatui);
    const zip = await exportZip(base, rich.alice);
    const files = await entries(zip, dataDir);
    const manifest = JSON.parse(files.get("manifest.json")?.toString() ?? "{}") as {
      format: string;
      entries: { path: string; size: number }[];
      conversations: unknown[];
    };
    expect(manifest).toMatchObject({ format: "chatui-archive", version: 1 });
    for (const entry of manifest.entries) {
      const bytes = files.get(entry.path);
      expect(bytes?.length, entry.path).toBe(entry.size);
    }
    const names = [...files.keys()];
    expect(names).toContain(`chats/${rich.chatId}.md`);
    expect(names).toContain(`attachments/${rich.imageId}/blob`);
    expect(names).toContain(`attachments/${rich.savedId}/meta.json`);
    expect(names.filter((n) => n.startsWith("artifacts/"))).toHaveLength(2);
    expect(names).toContain(`memories/${rich.memoryId}.md`);
    expect(names).toContain(`proposals/${rich.toolsChatId}.json`);
    expect(names).toContain("preferences.json");
    // Pending uploads, recovery state, accounts, sessions and secrets stay out.
    expect(
      names.some((n) => /operations|generations|sessions|user\.json|import-staging|index/.test(n)),
    ).toBe(false);
    expect(names.filter((n) => n.startsWith("attachments/"))).toHaveLength(4);
    const everything = [...files.values()].map((b) => b.toString("latin1")).join("\n");
    expect(everything).not.toContain("PROVIDER-SECRET-KEY-123");
    expect(readdirSync(path.join(dataDir, rich.alice.userId, "import-staging"))).toEqual([]);

    // Round trip into a fresh account.
    const carol = await signIn(base, chatui, "carol");
    const p = await preview(base, carol, zip);
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({
      chats: { new: 2, present: 0, conflict: 0 },
      files: 2,
      filesFromReplies: 1,
    });
    const report = await commit(base, carol, p.json.importId, {
      conflicts: "skip",
      memories: [rich.memoryId],
      preferences: true,
    });
    expect(report.status).toBe(200);
    expect(report.json.counts).toMatchObject({
      conversations: 2,
      files: 2,
      filesFromReplies: 1,
      memories: 1,
    });
    for (const id of [rich.chatId, rich.toolsChatId])
      expect(
        readFileSync(path.join(dataDir, carol.userId, "chats", `${id}.md`)).equals(
          readFileSync(path.join(dataDir, rich.alice.userId, "chats", `${id}.md`)),
        ),
      ).toBe(true);
    const image = await api(base, carol, "GET", `/api/attachments/${rich.imageId}/content`);
    expect(image.buffer.equals(makePng(8, 8))).toBe(true);
    const carolChat = (await api(base, carol, "GET", `/api/conversations/${rich.chatId}`)).json;
    const reply = last(carolChat.messages);
    const artifact = await api(
      base,
      carol,
      "GET",
      `/api/artifacts/${first(reply.artifacts).id}/source`,
    );
    expect(artifact.buffer.toString()).toBe("captured");
    expect(
      (await api(base, carol, "GET", "/api/memories")).json.memories.map((m) => m.body),
    ).toEqual(["A cat"]);
    // Suggestions: resolved statuses kept, unresolved ones invalid (never actionable).
    const statuses = (
      await api(base, carol, "GET", `/api/conversations/${rich.toolsChatId}`)
    ).json.proposals.map((p) => p.status);
    expect(statuses).toEqual(["rejected", "invalid"]);
    const prefs = (await api(base, carol, "GET", "/api/preferences")).json;
    expect(prefs).toMatchObject({ pins: [rich.chatId], defaultModel: "mock-chat" });
    // Alice is untouched; carol's data is hers.
    expect((await chats(base, rich.alice)).length).toBe(2);
  });

  it("holds the barrier exclusively only for the small files; a blob deleted afterwards is a retryable failure", async () => {
    const events: string[] = [];
    let deleteBlob: (() => void) | null = null;
    const { base, chatui, dataDir } = await serve({
      exportHooks: {
        inSnapshot: async () => {
          events.push("snapshot");
          await new Promise((r) => setTimeout(r, 150));
          events.push("snapshot done");
        },
        afterSnapshot: async () => {
          deleteBlob?.();
          // Mutations proceed while blobs are copied.
          await new Promise((r) => setTimeout(r, 150));
        },
      },
    });
    const rich = await richUser(base, chatui);
    const exporting = api(base, rich.alice, "GET", "/api/export");
    await new Promise((r) => setTimeout(r, 50));
    const renamed = api(base, rich.alice, "PATCH", `/api/conversations/${rich.chatId}`, {
      title: "During export",
    }).then((r) => {
      events.push("rename");
      return r;
    });
    expect((await renamed).status).toBe(200);
    expect((await exporting).status).toBe(200);
    expect(events.indexOf("rename")).toBeGreaterThan(events.indexOf("snapshot done"));

    deleteBlob = () => {
      rmSync(path.join(dataDir, rich.alice.userId, "attachments", rich.savedId, "blob"));
    };
    const failed = await api(base, rich.alice, "GET", "/api/export");
    expect(failed.status).toBe(409);
    expect(failed.json.error.message).toMatch(/try again/);
    expect(readdirSync(path.join(dataDir, rich.alice.userId, "import-staging"))).toEqual([]);
  });

  it("a chat with a running reply is exported in its accepted state and marked", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const { conversationId } = await send(base, alice, "slow please", {
      model: MOCK_MODELS.slow,
      noWait: true,
    });
    const files = await entries(await exportZip(base, alice), dataDir);
    const manifest = JSON.parse(files.get("manifest.json")?.toString() ?? "{}") as {
      format: string;
      entries: { path: string; size: number }[];
      conversations: unknown[];
    };
    expect(manifest.conversations).toEqual([
      { id: conversationId, malformed: false, activeGeneration: true },
    ]);
    const parsed = parseConversation(files.get(`chats/${conversationId}.md`)?.toString() ?? "");
    expect(parsed.ok && parsed.conversation.blocks.map((b) => b.type)).toEqual(["user"]);
  });
});

describe("portable import (INV-42)", () => {
  it("identical items are skipped as present; the same archive twice is flagged and changes nothing", async () => {
    const { base, chatui, dataDir } = await serve();
    const rich = await richUser(base, chatui);
    const zip = await exportZip(base, rich.alice);
    const before = readFileSync(
      path.join(dataDir, rich.alice.userId, "chats", `${rich.chatId}.md`),
    );
    const first = await preview(base, rich.alice, zip);
    expect(first.json).toMatchObject({
      chats: { new: 0, present: 2, conflict: 0 },
      alreadyImported: false,
      conflicts: [],
    });
    const report = await commit(base, rich.alice, first.json.importId);
    expect(report.json.counts).toMatchObject({ conversations: 0, files: 0, present: 2 });
    const second = await preview(base, rich.alice, zip);
    expect(second.json.alreadyImported).toBe(true);
    expect(second.json.idempotencyKey).toBe(first.json.idempotencyKey);
    await api(base, rich.alice, "DELETE", `/api/import/${second.json.importId}`);
    expect(
      readFileSync(path.join(dataDir, rich.alice.userId, "chats", `${rich.chatId}.md`)).equals(
        before,
      ),
    ).toBe(true);
    expect(readdirSync(path.join(dataDir, rich.alice.userId, "import-staging"))).toEqual([
      "imported.json",
    ]);
  });

  it("deleted chats are restored from one's own archive while the rest stay", async () => {
    const { base, chatui } = await serve();
    const rich = await richUser(base, chatui);
    const zip = await exportZip(base, rich.alice);
    await api(base, rich.alice, "DELETE", `/api/conversations/${rich.chatId}`);
    const p = await preview(base, rich.alice, zip);
    expect(p.json.chats).toMatchObject({ new: 1, present: 1 });
    await commit(base, rich.alice, p.json.importId);
    const restored = (await api(base, rich.alice, "GET", `/api/conversations/${rich.chatId}`)).json;
    expect(first(first(restored.messages).attachments)).toMatchObject({
      id: rich.imageId,
      missing: false,
    });
    expect((await chats(base, rich.alice)).map((c) => c.id)).toContain(rich.chatId);
  });

  it("conflicts are skipped by default with their dependants; as copies every reference is remapped", async () => {
    const { base, chatui, dataDir } = await serve();
    const rich = await richUser(base, chatui);
    const zip = await exportZip(base, rich.alice);
    // Change both chats and the memory, and delete the captured file.
    for (const id of [rich.chatId, rich.toolsChatId])
      await api(base, rich.alice, "PATCH", `/api/conversations/${id}`, {
        title: `Changed ${id.slice(0, 4)}`,
      });
    const mem = first((await api(base, rich.alice, "GET", "/api/memories")).json.memories);
    await api(base, rich.alice, "PATCH", `/api/memories/${mem.id}`, {
      body: "A dog",
      expectedRevision: mem.revision,
    });
    const artifact = first((await api(base, rich.alice, "GET", "/api/artifacts")).json.artifacts);
    await api(base, rich.alice, "DELETE", `/api/artifacts/${artifact.id}`);

    const skip = await preview(base, rich.alice, zip);
    expect(skip.json.chats).toMatchObject({ conflict: 2 });
    expect(skip.json.conflicts.map((c) => c.kind).sort()).toEqual(["chat", "chat", "memory"]);
    const skipped = await commit(base, rich.alice, skip.json.importId, {
      conflicts: "skip",
      memories: [rich.memoryId],
      preferences: false,
    });
    expect(skipped.json.counts).toMatchObject({
      conversations: 0,
      files: 0,
      memories: 0,
      filesFromReplies: 1,
    });
    const kinds = skipped.json.skipped.map((s) => `${s.kind}: ${s.reason}`);
    expect(kinds).toContain("suggestions: their chat was not imported");
    // The captured file comes back with a dead backlink: its chat was skipped.
    const dead = first((await api(base, rich.alice, "GET", "/api/artifacts")).json.artifacts);
    expect(dead.conversationAvailable).toBe(false);
    await api(base, rich.alice, "DELETE", `/api/artifacts/${dead.id}`);

    const copy = await preview(base, rich.alice, zip);
    const copied = await commit(base, rich.alice, copy.json.importId, {
      conflicts: "copy",
      memories: [rich.memoryId],
      preferences: false,
    });
    expect(copied.json.counts).toMatchObject({
      conversations: 2,
      files: 1,
      filesFromReplies: 1,
      rewritten: 1,
    });
    // A memory with the same name exists: never a second "Pet".
    expect(copied.json.skipped.map((s) => s.reason)).toContain("a memory with this name exists");
    const all = await chats(base, rich.alice);
    expect(all).toHaveLength(4);
    const copyOfChat = all.find((c) => c.id !== rich.chatId && c.title.startsWith("look"));
    expect(copyOfChat).toBeDefined();
    const dto = (await api(base, rich.alice, "GET", `/api/conversations/${copyOfChat?.id ?? ""}`))
      .json;
    const newImage = first(first(dto.messages).attachments);
    expect(newImage.id).not.toBe(rich.imageId);
    expect(newImage.missing).toBe(false);
    expect(
      (await api(base, rich.alice, "GET", `/api/attachments/${newImage.id}`)).json.conversationId,
    ).toBe(copyOfChat?.id);
    const linked = first((await api(base, rich.alice, "GET", "/api/artifacts")).json.artifacts);
    expect(linked).toMatchObject({ conversationId: copyOfChat?.id, conversationAvailable: true });
    expect(first(last(dto.messages).artifacts).id).toBe(linked.id);
    const prefs = (await api(base, rich.alice, "GET", "/api/preferences")).json;
    expect(prefs.pins).toContain(rich.chatId);
    expect(
      readFileSync(
        path.join(dataDir, rich.alice.userId, "chats", `${copyOfChat?.id ?? ""}.md`),
        "utf8",
      ),
    ).toContain(newImage.id);
  });

  it("malformed chats import raw, unless they would need new ids; memory names collide case-insensitively", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const { conversationId } = await send(base, alice, "will break");
    writeFileSync(
      path.join(dataDir, alice.userId, "chats", `${conversationId}.md`),
      "broken bytes\n",
    );
    await api(base, alice, "POST", "/api/memories", { name: "Café", body: "x" });
    const zip = await exportZip(base, alice);
    const bob = await signIn(base, chatui, "bob");
    await api(base, bob, "POST", "/api/memories", { name: "CAFÉ", body: "bob's" });
    const p = await preview(base, bob, zip);
    expect(p.json.chats.malformed).toBe(1);
    expect(first(p.json.memories).status).toBe("name_taken");
    const r = await commit(base, bob, p.json.importId, {
      conflicts: "copy",
      memories: [first(p.json.memories).id],
      preferences: false,
    });
    expect(r.json.counts.conversations).toBe(1);
    expect(
      readFileSync(path.join(dataDir, bob.userId, "chats", `${conversationId}.md`), "utf8"),
    ).toBe("broken bytes\n");
    expect((await api(base, bob, "GET", "/api/memories")).json.memories.map((m) => m.body)).toEqual(
      ["bob's"],
    );
    // As a conflicting copy it would need a new id: skipped and reported.
    writeFileSync(path.join(dataDir, bob.userId, "chats", `${conversationId}.md`), "other bytes\n");
    const again = await preview(base, bob, zip);
    const copy = await commit(base, bob, again.json.importId, {
      conflicts: "copy",
      memories: [],
      preferences: false,
    });
    expect(copy.json.skipped.map((s) => s.reason)).toContain(
      "it is malformed and would need new ids",
    );
  });

  it("an import belongs to its uploader; staged archives of others are 404", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    await send(base, alice, "mine");
    const p = await preview(base, alice, await exportZip(base, alice));
    expect((await commit(base, bob, p.json.importId)).status).toBe(404);
    expect(await chats(base, bob)).toEqual([]);
  });
});

describe("hostile archives (INV-42)", () => {
  async function zipOf(
    dir: string,
    files: Record<string, Buffer>,
    patch?: (bytes: Buffer) => void,
  ) {
    const file = path.join(dir, `bad-${crypto.randomUUID()}.zip`);
    const zip = await ZipWriter.create(file);
    for (const [name, bytes] of Object.entries(files)) await zip.add(name, bytes);
    await zip.close();
    const bytes = readFileSync(file);
    patch?.(bytes);
    rmSync(file);
    return bytes;
  }
  const manifest = (files: Record<string, Buffer>) =>
    Buffer.from(
      JSON.stringify({
        format: "chatui-archive",
        version: 1,
        exportedAt: new Date().toISOString(),
        conversations: [],
        entries: Object.entries(files).map(([p, b]) => ({
          path: p,
          size: b.length,
          sha256: createHash("sha256").update(b).digest("hex"),
        })),
      }),
    );

  it("rejects traversal, absolute paths, links, bombs, bad checksums and unknown files without staging anything", async () => {
    const { base, chatui, dataDir } = await serve({
      imports: {
        limits: {
          maxArchiveBytes: 5 * 1024 * 1024,
          zip: {
            maxEntries: 20,
            maxEntryBytes: 20 * 1024 * 1024,
            maxTotalBytes: 30 * 1024 * 1024,
            maxRatio: 50,
            maxDepth: 3,
          },
          maxMs: 60_000,
          stagingTtlMs: 60_000,
        },
      },
    });
    const alice = await signIn(base, chatui);
    const chat = { "chats/00000000-0000-4000-8000-000000000001.md": Buffer.from("x") };
    const cases: [string, Buffer][] = [
      [
        "traversal",
        await zipOf(dataDir, { "../evil.md": Buffer.from("x"), "manifest.json": manifest({}) }),
      ],
      [
        "absolute",
        await zipOf(dataDir, { "/etc/passwd": Buffer.from("x"), "manifest.json": manifest({}) }),
      ],
      [
        "backslash",
        await zipOf(dataDir, { "chats\\a.md": Buffer.from("x"), "manifest.json": manifest({}) }),
      ],
      [
        "symlink",
        await zipOf(dataDir, { ...chat, "manifest.json": manifest(chat) }, (bytes) => {
          const at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
          bytes.writeUInt32LE((0o120777 << 16) >>> 0, at + 38);
        }),
      ],
      [
        "bomb",
        await zipOf(dataDir, {
          "chats/00000000-0000-4000-8000-000000000002.md": Buffer.alloc(10 * 1024 * 1024),
          "manifest.json": manifest({}),
        }),
      ],
      [
        "too many",
        await zipOf(
          dataDir,
          Object.fromEntries(
            Array.from({ length: 25 }, (_, i) => [`memories/${String(i)}.md`, Buffer.from("x")]),
          ),
        ),
      ],
      [
        "checksum",
        await zipOf(dataDir, {
          ...chat,
          "manifest.json": manifest({
            "chats/00000000-0000-4000-8000-000000000001.md": Buffer.from("y"),
          }),
        }),
      ],
      [
        "unknown file",
        await zipOf(dataDir, {
          "notes/x.txt": Buffer.from("x"),
          "manifest.json": manifest({ "notes/x.txt": Buffer.from("x") }),
        }),
      ],
      ["not a zip", Buffer.from("plain text")],
      ["too large", Buffer.alloc(6 * 1024 * 1024)],
    ];
    for (const [label, bytes] of cases) {
      const res = await preview(base, alice, bytes);
      expect(res.status, label).toBe(400);
      expect(res.json.error.message, label).toMatch(/can't be imported/);
    }
    expect(readdirSync(path.join(dataDir, alice.userId, "import-staging"))).toEqual([]);
    expect(existsSync(path.join(dataDir, "evil.md"))).toBe(false);
  });

  it("an archive that takes longer than the time limit is refused", async () => {
    const { base, chatui, dataDir } = await serve({
      imports: {
        limits: {
          maxArchiveBytes: 1e9,
          zip: {
            maxEntries: 100,
            maxEntryBytes: 1e8,
            maxTotalBytes: 1e9,
            maxRatio: 100,
            maxDepth: 3,
          },
          maxMs: -1,
          stagingTtlMs: 60_000,
        },
      },
    });
    const alice = await signIn(base, chatui);
    await send(base, alice, "timed");
    const res = await preview(base, alice, await exportZip(base, alice));
    expect(res.status).toBe(400);
    expect(res.json.error.message).toMatch(/took too long/);
    expect(readdirSync(path.join(dataDir, alice.userId, "import-staging"))).toEqual([]);
  });

  it("an interrupted commit is rolled back at restart, preferences included", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const first = await serve({
      dataDir,
      imports: {
        hooks: {
          midCommit: () =>
            crash ? Promise.reject(new Error("simulated crash")) : Promise.resolve(),
        },
      },
    });
    const rich = await richUser(first.base, first.chatui);
    const zip = await exportZip(first.base, rich.alice);
    const carol = await signIn(first.base, first.chatui, "carol");
    const p = await preview(first.base, carol, zip);
    const res = await commit(first.base, carol, p.json.importId, {
      conflicts: "skip",
      memories: [rich.memoryId],
      preferences: true,
    });
    expect(res.status).toBe(500);
    crash = false;
    const second = await serve({ dataDir });
    expect(await chats(second.base, carol)).toEqual([]);
    expect((await api(second.base, carol, "GET", "/api/memories")).json.memories).toEqual([]);
    expect((await api(second.base, carol, "GET", "/api/attachments")).json.attachments).toEqual([]);
    expect((await api(second.base, carol, "GET", "/api/preferences")).json.pins).toEqual([]);
    expect(readdirSync(path.join(dataDir, carol.userId, "import-staging"))).toEqual([]);
  });
});

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExportResult, ImportPreview } from "../../shared/portability.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { parseConversation } from "../../server/storage/markdown.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { buildZip, manifestFor, readZip, sha256, type ZipEntry } from "../support/zip.ts";
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

/** Phase 13d: exact chat export, the portable archive and its importer (INV-42, INV-43). */

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

type Body = Record<string, unknown> & {
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

async function api(s: Served, method: string, url: string, body?: unknown, session = s.session) {
  const res = await fetch(`${s.base}${url}`, {
    method,
    headers: {
      ...session.headers(method !== "GET"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

let keySeq = 0;
const key = () => `00000000-0000-4000-9200-${String(++keySeq).padStart(12, "0")}`;

async function send(
  s: Served,
  content: string,
  extra: Record<string, unknown> = {},
  model: string = MOCK_MODELS.chat,
  session = s.session,
) {
  const res = await fetch(`${s.base}/api/generations`, {
    method: "POST",
    headers: { ...session.headers(true), "Content-Type": "application/json" },
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
  if (model !== MOCK_MODELS.slow) await s.chatui.services.generations.settled(body.generationId);
  return body;
}

/** A text attachment (every model can read text; images need a vision model). */
async function upload(s: Served, name = "notes.txt", session = s.session): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([`notes for ${name}\n`]), name);
  const res = await fetch(`${s.base}/api/attachments`, {
    method: "POST",
    headers: session.headers(true),
    body: form,
  });
  return ((await res.json()) as { id: string }).id;
}

async function exportAll(s: Served, session = s.session): Promise<Buffer> {
  const created = await api(s, "POST", "/api/exports", {}, session);
  expect(created.status).toBe(201);
  const { exportId } = created.body as unknown as ExportResult;
  const res = await fetch(`${s.base}/api/exports/${exportId}/download`, {
    headers: session.headers(),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  return Buffer.from(await res.arrayBuffer());
}

async function importZip(s: Served, zip: Buffer, session = s.session) {
  const res = await fetch(`${s.base}/api/imports`, {
    method: "POST",
    headers: { ...session.headers(true), "Content-Type": "application/zip" },
    body: new Uint8Array(zip),
  });
  return { status: res.status, body: (await res.json()) as ImportPreview & Body };
}

async function commit(
  s: Served,
  importId: string,
  options: Record<string, unknown> = {},
  session = s.session,
) {
  const res = await api(s, "POST", `/api/imports/${importId}/commit`, options, session);
  if (res.status === 202) await s.chatui.services.imports.settled(importId);
  const after = await api(s, "GET", `/api/imports/${importId}`, undefined, session);
  return {
    status: res.status,
    commitBody: res.body,
    preview: after.body as unknown as ImportPreview,
  };
}

const userDir = (s: Served, session = s.session) => path.join(s.dataDir, session.userId);
const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const read = (file: string) => readFileSync(file);

/** A user with every kind of content. */
async function richUser(s: Served) {
  const attachmentId = await upload(s);
  const chat = await send(s, "with a photo", { attachmentIds: [attachmentId] });
  const coded = await send(s, "file\n```py file=main.py\nprint(1)\n```");
  const memory = (await api(s, "POST", "/api/memories", { name: "Coffee", content: "Flat white" }))
    .body as { id: string };
  await api(s, "POST", "/api/skills", {
    name: "tidy",
    description: "d",
    instructions: "Be tidy",
    enabled: true,
  });
  await api(s, "PUT", `/api/conversations/${chat.conversationId}/pin`);
  // A proposal sidecar with an accepted and a pending record (as 13b writes them).
  const proposals = path.join(userDir(s), "proposals");
  mkdirSync(proposals, { recursive: true });
  const conv = parseConversation(
    read(path.join(userDir(s), "chats", `${chat.conversationId}.md`)).toString("utf8"),
  );
  if (!conv.ok) throw new Error("bad fixture");
  const userMsg = conv.conversation.blocks.find((b) => b.type === "user")?.id ?? "";
  const reply = conv.conversation.blocks.find((b) => b.type === "assistant")?.id ?? "";
  const record = (n: number, status: string, target: string | null) => ({
    id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
    generationId: chat.generationId,
    callIndex: n,
    userMessageId: userMsg,
    assistantMessageId: reply,
    providerId: "local",
    model: "m",
    tool: target ? "update" : "create",
    name: "Coffee",
    content: "Espresso",
    targetMemoryId: target,
    baselineRevision: null,
    nameKey: "coffee",
    contentHash: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: status === "pending" ? null : "2026-01-01T00:00:00.000Z",
    resultMemoryId: null,
    intent: null,
  });
  writeFileSync(
    path.join(proposals, `${chat.conversationId}.json`),
    JSON.stringify({
      version: 1,
      proposals: [record(0, "accepted", null), record(1, "pending", memory.id)],
    }),
  );
  return { attachmentId, chat, coded, memoryId: memory.id };
}

// ---------------------------------------------------------------------------

describe("single-chat export (INV-43)", () => {
  it("returns the exact canonical bytes, malformed files too, as a download", async () => {
    const s = await serve();
    const chat = await send(s, "hello");
    const file = path.join(userDir(s), "chats", `${chat.conversationId}.md`);
    const res = await fetch(`${s.base}/api/conversations/${chat.conversationId}/export`, {
      headers: s.session.headers(),
    });
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="hello\.md"/);
    expect(Buffer.from(await res.arrayBuffer()).equals(read(file))).toBe(true);
    const broken = Buffer.from("---\nnot: [valid\n---\n<!-- cc:user id=bad -->\nraw\r\n");
    writeFileSync(file, broken);
    const raw = await fetch(`${s.base}/api/conversations/${chat.conversationId}/export`, {
      headers: s.session.headers(),
    });
    expect(Buffer.from(await raw.arrayBuffer()).equals(broken)).toBe(true);
    const bob = await signIn(s.base, s.chatui, "bob");
    const other = await fetch(`${s.base}/api/conversations/${chat.conversationId}/export`, {
      headers: bob.headers(),
    });
    expect(other.status).toBe(404);
    await other.text();
  });
});

describe("portable export (INV-43)", () => {
  it("has a manifest with exact lengths and checksums, and only user content", async () => {
    const s = await serve();
    const rich = await richUser(s);
    await upload(s, "draft.txt"); // pending: an unsent draft, not exported
    const files = await readZip(await exportAll(s));
    const manifest = JSON.parse(files.get("manifest.json")?.toString("utf8") ?? "{}") as {
      format: string;
      entries: { path: string; length: number; sha256: string }[];
    };
    expect(manifest.format).toBe("chatui-user-archive");
    const names = [...files.keys()].filter((n) => n !== "manifest.json").sort();
    expect(manifest.entries.map((e) => e.path).sort()).toEqual(names);
    for (const entry of manifest.entries) {
      const data = files.get(entry.path) as Buffer;
      expect(data.length, entry.path).toBe(entry.length);
      expect(sha256(data), entry.path).toBe(entry.sha256);
    }
    expect(names).toEqual(
      expect.arrayContaining([
        `conversations/${rich.chat.conversationId}.md`,
        `attachments/${rich.attachmentId}/meta.json`,
        `attachments/${rich.attachmentId}/blob`,
        `memories/${rich.memoryId}.md`,
        `proposals/${rich.chat.conversationId}.json`,
        "skills.json",
        "preferences.json",
      ]),
    );
    expect(names.some((n) => n.startsWith("artifacts/") && n.endsWith("/blob"))).toBe(true);
    // Canonical bytes, exactly.
    expect(
      files
        .get(`conversations/${rich.chat.conversationId}.md`)
        ?.equals(read(path.join(userDir(s), "chats", `${rich.chat.conversationId}.md`))),
    ).toBe(true);
    // Never: the account, sessions, recovery state, derived indexes, drafts.
    expect(
      names.filter(
        (n) =>
          !/^(conversations|attachments|artifacts|memories|proposals)\/|^(skills|preferences)\.json$/.test(
            n,
          ),
      ),
    ).toEqual([]);
    expect(names.filter((n) => n.startsWith("attachments/"))).toHaveLength(2);
    // The export staging area is gone after the download is prepared, except the archive.
    const exportsDir = path.join(userDir(s), "import-staging", "exports");
    for (const id of list(exportsDir))
      expect(list(path.join(exportsDir, id))).toEqual(["archive.zip"]);
  });

  it("holds the barrier exclusively only while copying small files", async () => {
    let order: string[] = [];
    const s: Served = await serve({
      exportHooks: {
        duringSnapshot: async () => {
          order.push("snapshot");
          // A write started now waits for the snapshot to end.
          void api(s, "POST", "/api/memories", {
            name: `Waiting ${String(Date.now())}`,
            content: "x",
          }).then(() => order.push("write-during"));
          await new Promise((r) => setTimeout(r, 150));
          order.push("snapshot-end");
        },
        beforeBlobs: async () => {
          // While blobs are copied, writes go through at once.
          await api(s, "POST", "/api/memories", { name: "During blobs", content: "y" });
          order.push("write-while-blobs");
        },
      },
    });
    await richUser(s);
    order = [];
    await exportAll(s);
    expect(order.indexOf("write-during")).toBeGreaterThan(order.indexOf("snapshot-end"));
    expect(order).toContain("write-while-blobs");
  });

  it("a blob deleted after the snapshot fails with a retryable error; a retry succeeds", async () => {
    let remove: (() => void) | undefined;
    const s = await serve({
      exportHooks: {
        beforeBlobs: () => {
          remove?.();
        },
      },
    });
    const rich = await richUser(s);
    remove = () => {
      remove = undefined;
      rmSync(path.join(userDir(s), "attachments", rich.attachmentId), {
        recursive: true,
        force: true,
      });
    };
    const failed = await api(s, "POST", "/api/exports", {});
    expect(failed.status).toBe(409);
    expect(failed.body.error?.details?.retryable).toBe(true);
    const files = await readZip(await exportAll(s));
    expect([...files.keys()].some((n) => n.includes(rich.attachmentId))).toBe(false);
  });

  it("a conversation with a running reply is exported in its accepted state and marked", async () => {
    const s = await serve();
    const running = await send(s, "slowly", {}, MOCK_MODELS.slow);
    await new Promise((r) => setTimeout(r, 100));
    const files = await readZip(await exportAll(s));
    const manifest = JSON.parse(files.get("manifest.json")?.toString("utf8") ?? "{}") as {
      activeGenerations: string[];
    };
    expect(manifest.activeGenerations).toEqual([running.conversationId]);
    const md = files.get(`conversations/${running.conversationId}.md`)?.toString("utf8") ?? "";
    const parsed = parseConversation(md);
    expect(parsed.ok && parsed.conversation.blocks.at(-1)?.type).toBe("user");
    await api(s, "POST", `/api/generations/${running.generationId}/cancel`);
  });
});

describe("import (INV-42)", () => {
  it("round-trips every store into another account; memories only when selected; suggestions never actionable", async () => {
    const s = await serve();
    const rich = await richUser(s);
    const zip = await exportAll(s);
    const bob = await signIn(s.base, s.chatui, "bob");
    const preview = await importZip(s, zip, bob);
    expect(preview.status).toBe(201);
    expect(preview.body.memories).toEqual([
      expect.objectContaining({ id: rich.memoryId, name: "Coffee", action: "new" }),
    ]);
    // Nothing is written by a preview.
    expect(list(path.join(s.dataDir, bob.userId, "chats"))).toEqual([]);
    const done = await commit(s, preview.body.importId, { memoryIds: [rich.memoryId] }, bob);
    expect(done.status).toBe(202);
    expect(done.preview.state).toBe("committed");
    const a = userDir(s);
    const b = path.join(s.dataDir, bob.userId);
    // Conversations: identical bytes.
    for (const name of list(path.join(a, "chats")))
      expect(
        read(path.join(b, "chats", name)).equals(read(path.join(a, "chats", name))),
        name,
      ).toBe(true);
    // Attachments: same blob, metadata owned by the destination.
    const aMeta = JSON.parse(
      read(path.join(a, "attachments", rich.attachmentId, "meta.json")).toString("utf8"),
    ) as Record<string, unknown>;
    const bMeta = JSON.parse(
      read(path.join(b, "attachments", rich.attachmentId, "meta.json")).toString("utf8"),
    ) as Record<string, unknown>;
    expect(bMeta).toEqual({ ...aMeta, ownerId: bob.userId });
    expect(
      read(path.join(b, "attachments", rich.attachmentId, "blob")).equals(
        read(path.join(a, "attachments", rich.attachmentId, "blob")),
      ),
    ).toBe(true);
    // Artifacts, memories, skills: identical.
    for (const id of list(path.join(a, "artifacts")))
      for (const f of ["meta.json", "blob"])
        expect(
          read(path.join(b, "artifacts", id, f)).equals(read(path.join(a, "artifacts", id, f))),
        ).toBe(true);
    expect(
      read(path.join(b, "memories", `${rich.memoryId}.md`)).equals(
        read(path.join(a, "memories", `${rich.memoryId}.md`)),
      ),
    ).toBe(true);
    expect(JSON.parse(read(path.join(b, "skills.json")).toString("utf8"))).toEqual(
      JSON.parse(read(path.join(a, "skills.json")).toString("utf8")),
    );
    // Pins carried over.
    expect(
      ((await api(s, "GET", "/api/preferences", undefined, bob)).body as { pins: string[] }).pins,
    ).toEqual([rich.chat.conversationId]);
    // Proposals: accepted history kept, the pending one invalid.
    const sidecar = JSON.parse(
      read(path.join(b, "proposals", `${rich.chat.conversationId}.json`)).toString("utf8"),
    ) as { proposals: { status: string; intent: unknown }[] };
    expect(sidecar.proposals.map((p) => p.status)).toEqual(["accepted", "invalid"]);
    // The imported chats are listed (the derived index was rebuilt).
    expect(
      (
        (await api(s, "GET", "/api/conversations", undefined, bob)).body as {
          conversations: unknown[];
        }
      ).conversations,
    ).toHaveLength(2);
    // Alice is untouched (two-user isolation).
    expect(list(path.join(a, "chats"))).toHaveLength(2);
  });

  it("restores deleted items from your own archive, skipping identical ones; a repeat needs confirmation", async () => {
    const s = await serve();
    const rich = await richUser(s);
    const zip = await exportAll(s);
    await api(s, "DELETE", `/api/conversations/${rich.coded.conversationId}`);
    const preview = await importZip(s, zip);
    const conv = preview.body.items.filter((i) => i.kind === "conversation");
    expect(conv.map((i) => [i.id, i.action]).sort()).toEqual(
      [
        [rich.chat.conversationId, "identical"],
        [rich.coded.conversationId, "new"],
      ].sort(),
    );
    const done = await commit(s, preview.body.importId);
    expect(done.preview.state).toBe("committed");
    expect(existsSync(path.join(userDir(s), "chats", `${rich.coded.conversationId}.md`))).toBe(
      true,
    );
    const again = await importZip(s, zip);
    expect(again.body.previousImport?.importId).toBe(preview.body.importId);
    const refused = await commit(s, again.body.importId);
    expect(refused.status).toBe(409);
    expect(refused.commitBody.error?.details?.reason).toBe("duplicate");
    const repeat = await commit(s, again.body.importId, { allowRepeat: true });
    expect(repeat.preview.state).toBe("committed");
    // Everything was already present: nothing new.
    expect(
      repeat.preview.report?.items.filter((i) => i.action === "new" || i.action === "copy"),
    ).toEqual([]);
  });

  it("conflicts are skipped by default; copies remap every reference consistently", async () => {
    const s = await serve();
    const rich = await richUser(s);
    const zip = await exportAll(s);
    // Change the conversation locally: the archive's version now conflicts.
    await api(s, "PATCH", `/api/conversations/${rich.chat.conversationId}`, {
      title: "Renamed here",
    });
    const preview = await importZip(s, zip);
    const conflict = preview.body.items.find((i) => i.id === rich.chat.conversationId);
    expect(conflict?.action).toBe("conflict");
    const skipped = await commit(s, preview.body.importId);
    expect(
      skipped.preview.report?.items.find((i) => i.id === rich.chat.conversationId)?.action,
    ).toBe("conflict");
    expect(list(path.join(userDir(s), "chats"))).toHaveLength(2);
    // Now as copies.
    const second = await importZip(s, zip);
    const copied = await commit(s, second.body.importId, { conflicts: "copy", allowRepeat: true });
    const conv = copied.preview.report?.items.find(
      (i) => i.kind === "conversation" && i.id === rich.chat.conversationId,
    );
    expect(conv?.action).toBe("copy");
    const copyId = conv?.newId ?? "";
    expect(copyId).not.toBe(rich.chat.conversationId);
    const att = copied.preview.report?.items.find(
      (i) => i.kind === "attachment" && i.id === rich.attachmentId,
    );
    // The attachment id is taken by the original: remapped, and the Markdown rewritten.
    expect(att?.action).toBe("copy");
    expect(conv?.rewritten).toBe(true);
    const md = parseConversation(
      read(path.join(userDir(s), "chats", `${copyId}.md`)).toString("utf8"),
    );
    const userBlock = md.ok ? md.conversation.blocks.find((b) => b.type === "user") : undefined;
    expect(userBlock?.type === "user" && userBlock.attachments).toEqual([att?.newId]);
    const meta = JSON.parse(
      read(path.join(userDir(s), "attachments", att?.newId ?? "", "meta.json")).toString("utf8"),
    ) as { conversationId: string; messageId: string };
    expect(meta.conversationId).toBe(copyId);
    expect(meta.messageId).toBe(userBlock?.id);
    // The copy's proposals and its pin follow it.
    expect(existsSync(path.join(userDir(s), "proposals", `${copyId}.json`))).toBe(true);
    const pins = ((await api(s, "GET", "/api/preferences")).body as { pins: string[] }).pins;
    expect(pins).toContain(copyId);
    // The copy shows its image (link integrity through the API).
    const dto = (await api(s, "GET", `/api/conversations/${copyId}`)).body as {
      messages: { attachments: { id: string; missing: boolean }[] }[];
    };
    expect(dto.messages[0]?.attachments).toEqual([
      expect.objectContaining({ id: att?.newId, missing: false }),
    ]);
  });

  it("a skipped conversation takes its attachments, proposals and pin with it; its artifacts keep a dead backlink", async () => {
    const s = await serve();
    const rich = await richUser(s);
    const zip = await exportAll(s);
    const [artifact] = (
      (await api(s, "GET", "/api/artifacts")).body as { artifacts: { id: string }[] }
    ).artifacts;
    await api(s, "DELETE", `/api/artifacts/${artifact?.id ?? ""}`);
    await api(s, "PATCH", `/api/conversations/${rich.coded.conversationId}`, { title: "Changed" });
    const preview = await importZip(s, zip);
    const done = await commit(s, preview.body.importId);
    const art = done.preview.report?.items.find((i) => i.kind === "artifact");
    expect(art).toMatchObject({ action: "degraded" });
    const meta = JSON.parse(
      read(path.join(userDir(s), "artifacts", artifact?.id ?? "", "meta.json")).toString("utf8"),
    ) as { conversationId: unknown };
    expect(meta.conversationId).toBeNull();
    // Destination B: skip Alice's photo conversation as a conflict (same id, other bytes).
    const bob = await signIn(s.base, s.chatui, "bob");
    const bobDir = path.join(s.dataDir, bob.userId, "chats");
    mkdirSync(bobDir, { recursive: true });
    writeFileSync(
      path.join(bobDir, `${rich.chat.conversationId}.md`),
      '---\nformatVersion: 1\ntitle: "Mine"\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n---\n',
    );
    const bp = await importZip(s, zip, bob);
    const bd = await commit(s, bp.body.importId, {}, bob);
    const items = bd.preview.report?.items ?? [];
    expect(items.find((i) => i.kind === "attachment")).toMatchObject({
      action: "skipped",
      reason: "its conversation was skipped",
    });
    expect(items.find((i) => i.kind === "proposals")).toMatchObject({ action: "skipped" });
    expect(
      ((await api(s, "GET", "/api/preferences", undefined, bob)).body as { pins: string[] }).pins,
    ).toEqual([]);
    expect(list(path.join(s.dataDir, bob.userId, "attachments"))).toEqual([]);
  });

  it("proposals targeting a memory that wasn't imported become invalid", async () => {
    const s = await serve();
    const rich = await richUser(s);
    // Make the pending record accepted so only the missing target decides.
    const file = path.join(userDir(s), "proposals", `${rich.chat.conversationId}.json`);
    const data = JSON.parse(read(file).toString("utf8")) as { proposals: { status: string }[] };
    data.proposals = data.proposals.map((p) => ({ ...p, status: "rejected" }));
    writeFileSync(file, JSON.stringify(data));
    const zip = await exportAll(s);
    const bob = await signIn(s.base, s.chatui, "bob");
    const preview = await importZip(s, zip, bob);
    const done = await commit(s, preview.body.importId, {}, bob);
    expect(done.preview.report?.items.find((i) => i.kind === "proposals")).toMatchObject({
      action: "degraded",
    });
    const sidecar = JSON.parse(
      read(
        path.join(s.dataDir, bob.userId, "proposals", `${rich.chat.conversationId}.json`),
      ).toString("utf8"),
    ) as { proposals: { status: string; targetMemoryId: string | null }[] };
    expect(sidecar.proposals.map((p) => p.status)).toEqual(["rejected", "invalid"]);
  });

  it("memory names collide case-insensitively and are never replaced", async () => {
    const s = await serve();
    const rich = await richUser(s);
    const zip = await exportAll(s);
    const bob = await signIn(s.base, s.chatui, "bob");
    await api(s, "POST", "/api/memories", { name: "COFFEE", content: "Tea, actually" }, bob);
    const preview = await importZip(s, zip, bob);
    expect(preview.body.memories[0]?.action).toBe("conflict");
    const done = await commit(
      s,
      preview.body.importId,
      { memoryIds: [rich.memoryId], conflicts: "copy" },
      bob,
    );
    expect(done.preview.report?.items.find((i) => i.kind === "memory")).toMatchObject({
      action: "conflict",
    });
    const memories = (await api(s, "GET", "/api/memories", undefined, bob)).body as {
      memories: { content: string }[];
    };
    expect(memories.memories.map((m) => m.content)).toEqual(["Tea, actually"]);
  });

  it("a malformed conversation imports raw unless it would need remapping", async () => {
    const s = await serve();
    const chat = await send(s, "to break");
    const file = path.join(userDir(s), "chats", `${chat.conversationId}.md`);
    const broken = Buffer.from("---\nbroken\n");
    writeFileSync(file, broken);
    const zip = await exportAll(s);
    const bob = await signIn(s.base, s.chatui, "bob");
    const bp = await importZip(s, zip, bob);
    await commit(s, bp.body.importId, {}, bob);
    expect(
      read(path.join(s.dataDir, bob.userId, "chats", `${chat.conversationId}.md`)).equals(broken),
    ).toBe(true);
    // A malformed conversation with an attachment that must be remapped is skipped.
    const attachmentId = await upload(s);
    const withPhoto = await send(s, "photo", { attachmentIds: [attachmentId] });
    const carol = await signIn(s.base, s.chatui, "carol");
    // Carol already owns an attachment with that id (the remap is needed).
    const carolAtt = path.join(s.dataDir, carol.userId, "attachments", attachmentId);
    mkdirSync(carolAtt, { recursive: true });
    writeFileSync(path.join(carolAtt, "meta.json"), "{}");
    writeFileSync(path.join(userDir(s), "chats", `${withPhoto.conversationId}.md`), "not markdown");
    const zip3 = await exportAll(s);
    const cp = await importZip(s, zip3, carol);
    const cd = await commit(s, cp.body.importId, {}, carol);
    expect(cd.preview.report?.items.find((i) => i.id === withPhoto.conversationId)).toMatchObject({
      action: "skipped",
      reason: "malformed, and its attachments would need new ids",
    });
  });
});

describe("archive bounds and hostile archives (INV-42)", () => {
  const conversation = (id: string) => ({
    name: `conversations/${id}.md`,
    data: `---\nformatVersion: 1\ntitle: "T"\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n---\n`,
  });
  const ID = "12345678-1234-4234-8234-123456789012";

  /** Replaces a same-length name in a ZIP (yazl refuses unsafe names). */
  function patchName(zip: Buffer, from: string, to: string): Buffer {
    expect(from.length).toBe(to.length);
    const out = Buffer.from(zip);
    const needle = Buffer.from(from);
    let at = out.indexOf(needle);
    while (at >= 0) {
      Buffer.from(to).copy(out, at);
      at = out.indexOf(needle, at + 1);
    }
    return out;
  }

  async function refused(s: Served, zip: Buffer, message: RegExp) {
    const res = await importZip(s, zip);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error?.message).toMatch(message);
    // Nothing canonical was written; the staging was removed.
    expect(list(path.join(userDir(s), "chats"))).toEqual([]);
    expect(
      list(path.join(userDir(s), "import-staging")).filter((n) => /^[0-9a-f-]{36}$/.test(n)),
    ).toEqual([]);
  }

  it("refuses traversal, absolute and backslash names, symlinks and duplicates", async () => {
    const s = await serve();
    const entries: ZipEntry[] = [conversation(ID)];
    const base = [manifestFor(entries), ...entries];
    await refused(
      s,
      patchName(await buildZip([...base, { name: "aa/evil", data: "x" }]), "aa/evil", "../evil"),
      /outside the archive/,
    );
    await refused(
      s,
      patchName(await buildZip([...base, { name: "xetc/pw", data: "x" }]), "xetc/pw", "/etc/pw"),
      /outside the archive/,
    );
    await refused(
      s,
      patchName(await buildZip([...base, { name: "a_b", data: "x" }]), "a_b", "a\\b"),
      /readable ZIP|outside the archive/,
    );
    await refused(
      s,
      await buildZip([...base, { name: "link", data: "/etc/passwd", mode: 0o120777 }]),
      /symbolic link/,
    );
    await refused(
      s,
      patchName(
        await buildZip([...base, { name: "manifest.jsoX", data: "{}" }]),
        "manifest.jsoX",
        "manifest.json",
      ),
      /appears twice/,
    );
  });

  it("refuses ZIP bombs, too many entries, oversized totals and archives", async () => {
    const s = await serve({
      config: {
        imports: { maxEntries: 5, maxExpandedBytes: 3 * 1024 * 1024, maxArchiveBytes: 200_000 },
      },
    });
    const bomb: ZipEntry = { name: `attachments/${ID}/blob`, data: Buffer.alloc(2 * 1024 * 1024) };
    await refused(s, await buildZip([manifestFor([bomb]), bomb]), /suspiciously well/);
    const many = Array.from({ length: 6 }, (_, i) =>
      conversation(`12345678-1234-4234-8234-12345678901${String(i)}`),
    );
    await refused(s, await buildZip([manifestFor(many), ...many]), /more than 5 entries/);
    const big: ZipEntry[] = Array.from({ length: 2 }, (_, i) => ({
      name: `attachments/12345678-1234-4234-8234-12345678901${String(i)}/blob`,
      data: Buffer.alloc(2 * 1024 * 1024, i + 1),
      compress: false,
    }));
    const tooLarge = await importZip(s, await buildZip([manifestFor(big), ...big]));
    expect(tooLarge.status).toBe(413);
  });

  it("refuses bad checksums, unlisted entries, a missing manifest and other formats; reports unknown entries", async () => {
    const s = await serve();
    const c = conversation(ID);
    const manifest = manifestFor([c]);
    const tampered = { ...c, data: `${c.data}\n<!-- cc:user id=${ID} -->\nhi\n` };
    await refused(s, await buildZip([manifest, tampered]), /length|checksum/);
    await refused(
      s,
      await buildZip([manifest, c, conversation("22222222-1234-4234-8234-123456789012")]),
      /not listed/,
    );
    await refused(s, await buildZip([c]), /no manifest/);
    await refused(
      s,
      await buildZip([{ name: "manifest.json", data: '{"format":"other"}' }, c]),
      /not a supported/,
    );
    const ok = await importZip(
      s,
      await buildZip([manifest, c, { name: "notes/readme.txt", data: "hi" }]),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.warnings).toEqual(["Skipped an unknown entry: notes/readme.txt"]);
  });

  it("stops at the time limit", async () => {
    const s = await serve({ config: { imports: { maxMs: 1 } } });
    const many = Array.from({ length: 50 }, (_, i) =>
      conversation(`12345678-1234-4234-8234-1234567890${String(i).padStart(2, "0")}`),
    );
    const res = await importZip(s, await buildZip([manifestFor(many), ...many]));
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/too long/);
  });
});

describe("staging, cancellation and recovery", () => {
  it("cancel before commit removes the staging and writes nothing", async () => {
    const s = await serve();
    await send(s, "one");
    const zip = await exportAll(s);
    const bob = await signIn(s.base, s.chatui, "bob");
    const preview = await importZip(s, zip, bob);
    expect(
      (await api(s, "DELETE", `/api/imports/${preview.body.importId}`, undefined, bob)).status,
    ).toBe(200);
    expect(
      existsSync(path.join(s.dataDir, bob.userId, "import-staging", preview.body.importId)),
    ).toBe(false);
    expect(list(path.join(s.dataDir, bob.userId, "chats"))).toEqual([]);
    // Another user can't see or act on it.
    const other = await importZip(s, zip, bob);
    expect((await api(s, "GET", `/api/imports/${other.body.importId}`)).status).toBe(404);
  });

  it("a commit interrupted by a crash is rolled back at startup; pre-existing data is untouched", async () => {
    const dataDir = tempDataDir();
    const s = await serve({
      config: { dataDir },
      importHooks: {
        abandonOnError: true,
        afterStep: (n) => {
          if (n === 2) throw new Error("crash in the middle of the commit");
        },
      },
    });
    const rich = await richUser(s);
    const zip = await exportAll(s);
    const bob = await signIn(s.base, s.chatui, "bob");
    await api(s, "POST", "/api/memories", { name: "Mine", content: "keep" }, bob);
    const before = list(path.join(dataDir, bob.userId, "memories"));
    const preview = await importZip(s, zip, bob);
    await commit(s, preview.body.importId, { memoryIds: [rich.memoryId] }, bob);
    const journal = JSON.parse(
      read(
        path.join(dataDir, bob.userId, "import-staging", preview.body.importId, "journal.json"),
      ).toString("utf8"),
    ) as { state: string };
    expect(journal.state).toBe("committing");
    await stopAll();
    const again = await serve({ config: { dataDir }, username: "bob" });
    // (The startup sweep also removes the finished export's staging.)
    expect((await again.chatui.ready).imports?.rolledBack).toBe(1);
    const b = path.join(dataDir, bob.userId);
    expect(list(path.join(b, "chats"))).toEqual([]);
    expect(list(path.join(b, "attachments"))).toEqual([]);
    expect(list(path.join(b, "memories"))).toEqual(before);
    const status = await api(again, "GET", `/api/imports/${preview.body.importId}`);
    expect(status.body.state).toBe("rolled_back");
  });
});

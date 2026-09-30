import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExportResult, ImportPreview } from "../../shared/portability.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { parseConversation, type ConversationModel } from "../../server/storage/markdown.ts";
import { wallTimeToUtc } from "../../server/portability/duckai.ts";
import { startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { buildZip, readZip, type ZipEntry } from "../support/zip.ts";
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

/**
 * Phase 13e: the Claude export and duck.ai chat adapters, through the 13d
 * preview/commit/recovery pipeline (INV-42 for these adapters), against the
 * sanitized real-format fixtures in tests/fixtures.
 */

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const claudeZip = (name: string) => readFileSync(path.join(FIXTURES, "claude-export", name));
const DUCK = readFileSync(path.join(FIXTURES, "duckai", "duck.ai_2026-09-30_06-27-19.txt"));

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4 });
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
    writeProviders(dataDir, [localProvider(llama.url)]);
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

type Body = Record<string, unknown> & { error?: { code: string; message: string } };

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

/** Uploads bytes as the Data settings page does (a non-ZIP as opaque bytes). */
async function importFile(
  s: Served,
  bytes: Buffer | string,
  options: { session?: TestSession; tz?: string; zip?: boolean } = {},
) {
  const session = options.session ?? s.session;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const zip = options.zip ?? buffer.subarray(0, 2).toString("latin1") === "PK";
  const res = await fetch(
    `${s.base}/api/imports${options.tz ? `?tz=${encodeURIComponent(options.tz)}` : ""}`,
    {
      method: "POST",
      headers: {
        ...session.headers(true),
        "Content-Type": zip ? "application/zip" : "application/octet-stream",
      },
      body: new Uint8Array(buffer),
    },
  );
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
  return { status: res.status, preview: after.body as unknown as ImportPreview };
}

async function importAndCommit(
  s: Served,
  bytes: Buffer | string,
  options: Record<string, unknown> = {},
  session = s.session,
) {
  const uploaded = await importFile(s, bytes, { session });
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  const done = await commit(s, uploaded.body.importId, options, session);
  expect(done.preview.state).toBe("committed");
  return { uploaded: uploaded.body, report: done.preview.report };
}

const userDir = (s: Served, session = s.session) => path.join(s.dataDir, session.userId);
const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

function chat(s: Served, id: string, session = s.session): ConversationModel {
  const parsed = parseConversation(
    readFileSync(path.join(userDir(s, session), "chats", `${id}.md`), "utf8"),
  );
  if (!parsed.ok) throw new Error(`malformed: ${parsed.reason}`);
  return parsed.conversation;
}

const count = (p: ImportPreview, kind: string, action: string) => p.counts[kind]?.[action] ?? 0;

async function refused(s: Served, bytes: Buffer | string, message: RegExp) {
  const res = await importFile(s, bytes);
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body.error?.message).toMatch(message);
  expect(list(path.join(userDir(s), "chats"))).toEqual([]);
  expect(
    list(path.join(userDir(s), "import-staging")).filter((n) => /^[0-9a-f-]{36}$/.test(n)),
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Synthetic Claude documents for the variants and edge cases

const ROOT = "00000000-0000-4000-8000-000000000000";
let seq = 0;
const uuid = () => `c1a0de00-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

interface Msg {
  uuid: string;
  sender: string;
  text: string;
  content: Record<string, unknown>[];
  created_at: string;
  updated_at: string;
  attachments: Record<string, unknown>[];
  files: Record<string, unknown>[];
  parent_message_uuid: string;
}

function message(
  sender: "human" | "assistant",
  parent: string,
  content: Record<string, unknown>[],
  extra: Partial<Msg> = {},
): Msg {
  const at = `2026-03-01T10:00:${String(seq % 60).padStart(2, "0")}.123456Z`;
  return {
    uuid: uuid(),
    sender,
    text: "",
    content,
    created_at: at,
    updated_at: at,
    attachments: [],
    files: [],
    parent_message_uuid: parent,
    ...extra,
  };
}

const text = (t: string) => ({ type: "text", text: t, citations: [] });

function claudeConversation(messages: Msg[], extra: Record<string, unknown> = {}) {
  return {
    uuid: uuid(),
    name: "Synthetic",
    summary: "",
    created_at: "2026-03-01T09:59:00.000001Z",
    updated_at: "2026-03-01T10:05:00.000001Z",
    account: { uuid: ROOT },
    chat_messages: messages,
    ...extra,
  };
}

function conversationsZip(conversations: unknown[], more: ZipEntry[] = []): Promise<Buffer> {
  return buildZip([{ name: "conversations.json", data: JSON.stringify(conversations) }, ...more]);
}

// ---------------------------------------------------------------------------

describe("Claude export: the observed fixture", () => {
  it("previews and imports chats, text attachments and create_file files; tool calls are reported", async () => {
    const s = await serve();
    const up = await importFile(s, claudeZip("conversations-000.zip"));
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const p = up.body;
    expect(p.source).toBe("claude");
    expect(count(p, "conversation", "new")).toBe(4);
    expect(count(p, "attachment", "new")).toBe(1);
    expect(count(p, "artifact", "new")).toBe(6);
    expect(p.warnings.join("\n")).toMatch(
      /Skipped 3 tool calls \((visualize:read_me|present_files)[^)]*\): ChatUI keeps no tool transcripts/,
    );
    expect(p.exportCreatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // A preview writes nothing canonical.
    expect(list(path.join(userDir(s), "chats"))).toEqual([]);

    const done = await commit(s, p.importId);
    expect(done.preview.state).toBe("committed");
    const source = JSON.parse(
      (await readZip(claudeZip("conversations-000.zip"))).get("conversations.json")?.toString() ??
        "[]",
    ) as {
      uuid: string;
      name: string;
      created_at: string;
      chat_messages: { uuid: string; sender: string; content: { type: string }[] }[];
    }[];
    const chats = (
      (await api(s, "GET", "/api/conversations")).body as unknown as {
        conversations: { id: string; title: string }[];
      }
    ).conversations;
    expect(chats.map((c) => c.id).sort()).toEqual(source.map((c) => c.uuid).sort());
    // An empty name becomes "Untitled chat"; an empty conversation imports empty.
    const untitled = source.find((c) => c.name === "");
    expect(chats.find((c) => c.id === untitled?.uuid)?.title).toBe("Untitled chat");
    const empty = source.find((c) => c.chat_messages.length === 0);
    expect(chat(s, empty?.uuid ?? "").blocks).toEqual([]);

    for (const conv of source) {
      const model = chat(s, conv.uuid);
      // Times are canonical milliseconds; ids are Claude's own.
      expect(model.createdAt).toBe(new Date(Date.parse(conv.created_at)).toISOString());
      const ids = model.blocks.filter((b) => b.type !== "reasoning").map((b) => b.id);
      expect(ids).toEqual(conv.chat_messages.map((m) => m.uuid));
      for (const m of conv.chat_messages) {
        const hasThinking = m.content.some(
          (b) =>
            b.type === "thinking" && ((b as { thinking?: string }).thinking ?? "").trim() !== "",
        );
        expect(model.blocks.some((b) => b.type === "reasoning" && b.id === m.uuid)).toBe(
          hasThinking,
        );
      }
    }
    // The pasted text attachment is linked and served.
    const withAttachment = source.find((c) =>
      c.chat_messages.some((m) => (m as { attachments?: unknown[] }).attachments?.length),
    );
    const userBlock = chat(s, withAttachment?.uuid ?? "").blocks.find(
      (b) => b.type === "user" && b.attachments,
    );
    const attachmentId = userBlock?.type === "user" ? (userBlock.attachments?.[0] ?? "") : "";
    const served = await fetch(`${s.base}/api/attachments/${attachmentId}/content`, {
      headers: s.session.headers(),
    });
    expect(served.status).toBe(200);
    expect((await served.text()).length).toBeGreaterThan(0);
    // create_file outputs are imported, finalized files linked to their reply.
    const files = (await api(s, "GET", "/api/artifacts")).body as unknown as {
      artifacts: { name: string; source: string; conversationId: string | null }[];
    };
    expect(files.artifacts).toHaveLength(6);
    expect(files.artifacts.every((a) => a.name.endsWith(".html"))).toBe(true);
  });

  it("memory files are candidates, imported only when selected", async () => {
    const s = await serve();
    const first = await importFile(s, claudeZip("memories-000.zip"));
    expect(first.status).toBe(201);
    expect(first.body.memories).toHaveLength(1);
    expect(first.body.memories[0]?.action).toBe("new");
    await commit(s, first.body.importId);
    expect(list(path.join(userDir(s), "memories"))).toEqual([]);
    const again = await importFile(s, claudeZip("memories-000.zip"));
    const memoryId = again.body.memories[0]?.id ?? "";
    await commit(s, again.body.importId, { memoryIds: [memoryId], allowRepeat: true });
    const memories = (await api(s, "GET", "/api/memories")).body as unknown as {
      memories: { id: string; name: string }[];
    };
    expect(memories.memories.map((m) => m.id)).toEqual([memoryId]);
    expect(memories.memories[0]?.name).toBe("file-7");
  });

  it("account, sign-in and reflection files are reported as skipped; nothing is imported", async () => {
    const s = await serve();
    for (const name of ["feedback-000.zip", "light_metadata-000.zip"]) {
      const res = await importFile(s, claudeZip(name));
      expect(res.status).toBe(201);
      expect(res.body.source).toBe("claude");
      expect(res.body.items).toEqual([]);
      expect(res.body.warnings.join("\n")).toMatch(
        name === "feedback-000.zip"
          ? /reflections\/.*usage reflections aren't imported/
          : /users\.json: account data.*\n.*login_history\.json: sign-in history/s,
      );
    }
  });

  it("a bare conversations.json is the same export: identical on re-import, and a duplicate", async () => {
    const s = await serve();
    const { uploaded } = await importAndCommit(s, claudeZip("conversations-000.zip"));
    const json = (await readZip(claudeZip("conversations-000.zip"))).get("conversations.json");
    const bare = await importFile(s, json ?? Buffer.alloc(0));
    expect(bare.status, JSON.stringify(bare.body)).toBe(201);
    expect(bare.body.key).toBe(uploaded.key);
    expect(bare.body.previousImport?.importId).toBe(uploaded.importId);
    // Only what the adapter itself skips (a file without bytes) is not identical.
    expect(
      bare.body.items.filter((i) => i.action !== "identical" && i.action !== "skipped"),
    ).toEqual([]);
    // The repeat is refused unless confirmed (13d idempotency).
    const refusedRepeat = await api(s, "POST", `/api/imports/${bare.body.importId}/commit`, {});
    expect(refusedRepeat.status).toBe(409);
  });

  it("conflicts follow the 13d policies: skipped by default, copies on request", async () => {
    const s = await serve();
    await importAndCommit(s, claudeZip("conversations-000.zip"));
    const chats = (
      (await api(s, "GET", "/api/conversations")).body as unknown as {
        conversations: { id: string; title: string }[];
      }
    ).conversations;
    const target = chats.find((c) => c.title !== "Untitled chat") ?? chats[0];
    const renamed = await api(s, "PATCH", `/api/conversations/${target?.id ?? ""}`, {
      title: "Renamed here",
    });
    expect(renamed.status).toBe(200);
    const skip = await importFile(s, claudeZip("conversations-000.zip"));
    expect(count(skip.body, "conversation", "conflict")).toBe(1);
    expect(count(skip.body, "conversation", "identical")).toBe(3);
    const copy = await commit(s, skip.body.importId, { conflicts: "copy", allowRepeat: true });
    const copied = copy.preview.report?.items.find(
      (i) => i.kind === "conversation" && i.action === "copy",
    );
    expect(copied?.id).toBe(target?.id);
    expect(copied?.newId).not.toBe(target?.id);
    expect(chat(s, target?.id ?? "").title).toBe("Renamed here");
    expect(chat(s, copied?.newId ?? "").title).not.toBe("Renamed here");
  });
});

describe("Claude export: variants and reporting", () => {
  it("keeps the latest branch, and reports files without bytes, unsupported attachments, failed and refused files, other blocks and citations", async () => {
    const s = await serve();
    const root = message("human", ROOT, [text("Question")], {
      attachments: [
        { file_name: "notes.md", file_size: 5, file_type: "txt", extracted_content: "# Notes" },
        { file_name: "scan.pdf", file_size: 5, file_type: "pdf", extracted_content: "pdf text" },
      ],
      files: [{ file_uuid: uuid(), file_name: "photo.png" }],
    });
    const oldReply = message("assistant", root.uuid, [text("Old answer")], {
      created_at: "2026-03-01T10:01:00.000000Z",
    });
    const toolId = uuid();
    const failedId = uuid();
    const badNameId = uuid();
    const newReply = message(
      "assistant",
      root.uuid,
      [
        { type: "thinking", thinking: "Let me think", summaries: [] },
        {
          type: "tool_use",
          id: toolId,
          name: "create_file",
          input: { path: "/mnt/user-data/outputs/app.py", file_text: "print(1)\n" },
          display_content: { type: "code_block", language: "python", code: "", filename: "" },
        },
        {
          type: "tool_result",
          tool_use_id: toolId,
          name: "create_file",
          content: [],
          is_error: false,
        },
        {
          type: "tool_use",
          id: failedId,
          name: "create_file",
          input: { path: "/mnt/user-data/outputs/fail.py", file_text: "x" },
        },
        {
          type: "tool_result",
          tool_use_id: failedId,
          name: "create_file",
          content: [],
          is_error: true,
        },
        {
          type: "tool_use",
          id: badNameId,
          name: "create_file",
          input: { path: "/mnt/user-data/outputs/.hidden", file_text: "x" },
        },
        { type: "tool_use", id: uuid(), name: "web_search", input: {} },
        { type: "image", source: {} },
        { type: "text", text: "New answer", citations: [{ url: "https://example.com" }] },
      ],
      { created_at: "2026-03-01T10:02:00.000000Z" },
    );
    const conv = claudeConversation([root, oldReply, newReply]);
    const res = await importFile(s, await conversationsZip([conv]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const p = res.body;
    const skipped = p.items.filter((i) => i.action === "skipped");
    expect(skipped.map((i) => [i.kind, i.label, i.reason])).toEqual(
      expect.arrayContaining([
        ["attachment", "scan.pdf", "only text attachments are imported"],
        ["attachment", "photo.png", "the export doesn't include this file's contents"],
        ["artifact", "fail.py", "the tool reported an error"],
        ["artifact", ".hidden", "its name isn't allowed (hidden)"],
      ]),
    );
    const warnings = p.warnings.join("\n");
    expect(warnings).toMatch(/Skipped 1 tool call \(web_search\)/);
    expect(warnings).toMatch(/Skipped 1 unsupported content block \(image\)/);
    expect(warnings).toMatch(/Skipped 1 message on other branches/);
    expect(warnings).toMatch(/1 reply part had citations/);
    await commit(s, p.importId);
    const model = chat(s, conv.uuid);
    expect(model.blocks.map((b) => [b.type, b.id])).toEqual([
      ["user", root.uuid],
      ["reasoning", newReply.uuid],
      ["assistant", newReply.uuid],
    ]);
    const [user, reasoning, assistant] = model.blocks;
    expect(user?.body).toBe("Question");
    expect(user?.type === "user" && user.attachments?.length).toBe(1);
    expect(user?.type === "user" && user.time).toMatch(/^2026-03-01T10:00:\d{2}\.123Z$/);
    expect(reasoning?.body).toBe("Let me think");
    expect(assistant?.body).toBe("New answer");
    // Absent attributes stay absent: no provider or model is invented.
    expect(assistant?.type === "assistant" && assistant.provider).toBe(undefined);
    expect(assistant?.type === "assistant" && assistant.model).toBe(undefined);
    const files = (await api(s, "GET", "/api/artifacts")).body as unknown as {
      artifacts: { name: string; language: string | null }[];
    };
    expect(files.artifacts.map((a) => [a.name, a.language])).toEqual([["app.py", "python"]]);
  });

  it("refuses duplicate conversation and message ids, bad JSON and unknown files", async () => {
    const s = await serve();
    const conv = claudeConversation([message("human", ROOT, [text("hi")])]);
    await refused(s, await conversationsZip([conv, conv]), /Conversation .* appears twice/);
    const m = message("human", ROOT, [text("hi")]);
    await refused(
      s,
      await conversationsZip([claudeConversation([m]), claudeConversation([m])]),
      /Message .* appears twice/,
    );
    await refused(
      s,
      await buildZip([{ name: "conversations.json", data: "[{" }]),
      /isn't valid JSON/,
    );
    await refused(
      s,
      await buildZip([{ name: "conversations.json", data: "{}" }]),
      /isn't a list of conversations/,
    );
    await refused(s, '{"hello": 1}', /neither Claude's conversations\.json nor a memories file/);
    await refused(s, "hello", /isn't a ChatUI export, a Claude data export or a duck\.ai chat/);
    await refused(
      s,
      await buildZip([{ name: "other.json", data: "[]" }]),
      /neither a ChatUI export/,
    );
  });

  it("refuses traversal, symlinks, duplicate paths and ZIP bombs; enforces every cap", async () => {
    const s = await serve({
      config: {
        imports: { maxEntries: 4, maxRecords: 5, maxJsonBytes: 64 * 1024 },
      },
    });
    const json = JSON.stringify([claudeConversation([message("human", ROOT, [text("hi")])])]);
    const patch = (zip: Buffer, from: string, to: string) => {
      const out = Buffer.from(zip);
      for (let at = out.indexOf(from); at >= 0; at = out.indexOf(from, at + 1))
        Buffer.from(to).copy(out, at);
      return out;
    };
    const base: ZipEntry = { name: "conversations.json", data: json };
    await refused(
      s,
      patch(await buildZip([base, { name: "aa/evil", data: "x" }]), "aa/evil", "../evil"),
      /outside the archive/,
    );
    await refused(
      s,
      await buildZip([base, { name: "link", data: "/etc/passwd", mode: 0o120777 }]),
      /symbolic link/,
    );
    await refused(
      s,
      patch(
        await buildZip([base, { name: "conversations.jsoX", data: "[]" }]),
        "conversations.jsoX",
        "conversations.json",
      ),
      /appears twice/,
    );
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `x${String(i)}.txt`, data: "x" }));
    await refused(s, await buildZip([base, ...many]), /more than 4 entries/);
    // Canonical records: 3 conversations of 2 messages each is 9 > 5.
    const records = Array.from({ length: 3 }, () => {
      const h = message("human", ROOT, [text("q")]);
      return claudeConversation([h, message("assistant", h.uuid, [text("a")])]);
    });
    await refused(s, await conversationsZip(records), /more than 5 records/);
    // One JSON document over the cap, whether zipped or bare.
    const huge = JSON.stringify([
      claudeConversation([message("human", ROOT, [text("x".repeat(70_000))])]),
    ]);
    await refused(
      s,
      await buildZip([{ name: "conversations.json", data: huge, compress: false }]),
      /larger than/,
    );
    await refused(s, huge, /larger than/);
  });

  it("refuses a compression bomb and stops at the time limit", async () => {
    const s = await serve({ config: { imports: { maxMs: 1 } } });
    const bomb = `[${" ".repeat(3 * 1024 * 1024)}]`;
    await refused(
      s,
      await buildZip([{ name: "conversations.json", data: bomb }]),
      /suspiciously well/,
    );
    const many = Array.from({ length: 300 }, () =>
      claudeConversation([message("human", ROOT, [text("hi")])]),
    );
    await refused(s, await conversationsZip(many), /too long/);
  });
});

describe("Claude export: isolation, recovery and round trip", () => {
  it("imports into the signed-in account only", async () => {
    const s = await serve();
    const bob = await signIn(s.base, s.chatui, "bob");
    const { uploaded } = await importAndCommit(s, claudeZip("conversations-000.zip"), {}, bob);
    expect(list(path.join(userDir(s, bob), "chats"))).toHaveLength(4);
    expect(list(path.join(userDir(s), "chats"))).toEqual([]);
    expect((await api(s, "GET", `/api/imports/${uploaded.importId}`)).status).toBe(404);
    // The same export in another account: its own, independent copy.
    const mine = await importFile(s, claudeZip("conversations-000.zip"));
    expect(mine.body.previousImport).toBeNull();
    expect(count(mine.body, "conversation", "new")).toBe(4);
  });

  it("a commit interrupted by a crash is rolled back at startup", async () => {
    const dataDir = tempDataDir();
    const s = await serve({
      config: { dataDir },
      importHooks: {
        abandonOnError: true,
        afterStep: (n) => {
          if (n === 3) throw new Error("crash in the middle of the commit");
        },
      },
    });
    const up = await importFile(s, claudeZip("conversations-000.zip"));
    await commit(s, up.body.importId);
    expect(list(path.join(userDir(s), "chats")).length).toBeGreaterThan(0);
    await stopAll();
    const again = await serve({ config: { dataDir } });
    expect((await again.chatui.ready).imports?.rolledBack).toBe(1);
    expect(list(path.join(dataDir, s.session.userId, "chats"))).toEqual([]);
    expect(list(path.join(dataDir, s.session.userId, "artifacts"))).toEqual([]);
    expect(list(path.join(dataDir, s.session.userId, "attachments"))).toEqual([]);
    const status = await api(again, "GET", `/api/imports/${up.body.importId}`);
    expect(status.body.state).toBe("rolled_back");
  });

  it("the imported result round-trips through the 13d portable export", async () => {
    const s = await serve();
    await importAndCommit(s, claudeZip("conversations-000.zip"));
    const created = await api(s, "POST", "/api/exports", {});
    const { exportId } = created.body as unknown as ExportResult;
    const zip = Buffer.from(
      await (
        await fetch(`${s.base}/api/exports/${exportId}/download`, { headers: s.session.headers() })
      ).arrayBuffer(),
    );
    const carol = await signIn(s.base, s.chatui, "carol");
    const { uploaded } = await importAndCommit(s, zip, {}, carol);
    expect(uploaded.source).toBe("chatui");
    for (const id of list(path.join(userDir(s), "chats")))
      expect(readFileSync(path.join(userDir(s, carol), "chats", id))).toEqual(
        readFileSync(path.join(userDir(s), "chats", id)),
      );
    expect(list(path.join(userDir(s, carol), "artifacts"))).toEqual(
      list(path.join(userDir(s), "artifacts")),
    );
    expect(list(path.join(userDir(s, carol), "attachments"))).toEqual(
      list(path.join(userDir(s), "attachments")),
    );
  });
});

describe("duck.ai chat", () => {
  it("imports the observed chat with prompt times read in the browser's zone", async () => {
    const s = await serve();
    const res = await importFile(s, DUCK, { tz: "America/New_York" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.source).toBe("duckai");
    expect(count(res.body, "conversation", "new")).toBe(1);
    expect(res.body.warnings[0]).toMatch(/your time zone \(America\/New_York\)/);
    await commit(s, res.body.importId);
    const [file] = list(path.join(userDir(s), "chats"));
    const model = chat(s, (file ?? "").replace(/\.md$/, ""));
    expect(model.blocks.map((b) => b.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const first = model.blocks[0];
    // 11:58:58 p.m. on 2026-06-21 in New York (EDT) is 03:58:58 UTC the next day.
    expect(first?.type === "user" && first.time).toBe("2026-06-22T03:58:58.000Z");
    expect(model.createdAt).toBe("2026-06-22T03:58:58.000Z");
    expect(model.updatedAt).toBe("2026-06-22T04:00:55.000Z");
    const reply = model.blocks[1];
    expect(reply?.type === "assistant" && reply.model).toBe("Claude Haiku 4.5");
    // duck.ai records no response time and no provider: none is invented.
    expect(reply?.type === "assistant" && reply.time).toBe(undefined);
    expect(reply?.type === "assistant" && reply.provider).toBe(undefined);
    // A ==== line inside a prompt stays part of it.
    expect(model.blocks[4]?.body).toMatch(/^={20,}$/m);
    expect(Array.from(model.title).length).toBeLessThanOrEqual(80);
    // The same file again: identical.
    const again = await importFile(s, DUCK, { tz: "America/New_York" });
    expect(again.body.items.map((i) => i.action)).toEqual(["identical"]);
  });

  it("without a known time zone, times are read as UTC and the preview says so", async () => {
    const s = await serve();
    const res = await importFile(s, DUCK, { tz: "Not/AZone" });
    expect(res.body.warnings[0]).toMatch(/read as UTC/);
    await commit(s, res.body.importId);
    const [file] = list(path.join(userDir(s), "chats"));
    expect(chat(s, (file ?? "").replace(/\.md$/, "")).createdAt).toBe("2026-06-21T23:58:58.000Z");
  });

  it("an unanswered prompt imports as a prompt; malformed chats are refused", async () => {
    const s = await serve();
    const text = DUCK.toString("utf8");
    const unanswered = text.replace(
      /\nClaude Haiku 4\.5:\n(?![\s\S]*\nClaude Haiku 4\.5:\n)/,
      "\n",
    );
    const res = await importFile(s, unanswered);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings.join("\n")).toMatch(/No response was found for prompt 3/);
    await api(s, "DELETE", `/api/imports/${res.body.importId}`);
    await refused(
      s,
      text.replace("generated with Duck.ai (https://duck.ai)", "generated with Duck.ai"),
      /first line/,
    );
    await refused(
      s,
      text.replace("User prompt 2 of 3", "User prompt 2 of 4"),
      /declares 3 prompts but 1 were found/,
    );
  });

  it("converts wall times across daylight-saving changes", () => {
    // 01:30 on the US fall-back day exists twice; 02:30 on spring-forward never does.
    expect(new Date(wallTimeToUtc([2026, 1, 15, 12, 0, 0], "Europe/Berlin")).toISOString()).toBe(
      "2026-01-15T11:00:00.000Z",
    );
    expect(new Date(wallTimeToUtc([2026, 7, 15, 12, 0, 0], "Europe/Berlin")).toISOString()).toBe(
      "2026-07-15T10:00:00.000Z",
    );
    expect(new Date(wallTimeToUtc([2026, 7, 15, 12, 0, 0], null)).toISOString()).toBe(
      "2026-07-15T12:00:00.000Z",
    );
  });
});

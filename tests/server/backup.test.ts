import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acquireInstanceLock,
  BackupError,
  createBackup,
  lockHolder,
  restoreBackup,
  verifyBackup,
} from "../../server/backup.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { parseConversation } from "../../server/storage/markdown.ts";
import { startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  localProvider,
  providerConfig,
  signIn,
  tempDataDir,
  tempDir,
  testApp,
  writeProviders,
  type TestSession,
} from "./helpers.ts";

/**
 * INV-50: operator backup and restore. A verified snapshot of the complete
 * canonical state, restored only into empty state, with startup recovery
 * finishing whatever was in flight when the snapshot was taken.
 */

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4, chunkDelayMs: 40, slowChunks: 400 });
});
afterAll(async () => {
  await llama.close();
});

const servers: { server: Server; chatui: ChatUiApp }[] = [];
async function stop(chatui: ChatUiApp) {
  const i = servers.findIndex((s) => s.chatui === chatui);
  const [entry] = servers.splice(i, 1);
  if (!entry) return;
  await chatui.shutdown();
  entry.server.closeAllConnections();
  await new Promise<void>((resolve) =>
    entry.server.close(() => {
      resolve();
    }),
  );
}
afterEach(async () => {
  for (const { chatui } of [...servers]) await stop(chatui);
});

async function serve(dataDir: string) {
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [localProvider(llama.url)]);
  const { chatui } = testApp({
    config: { provider: providerConfig({ baseUrl: llama.url }), dataDir },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, chatui };
}

async function api(
  base: string,
  session: TestSession,
  method: string,
  url: string,
  body?: unknown,
) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...session.headers(method !== "GET"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function send(base: string, session: TestSession, model: string, content: string) {
  return api(base, session, "POST", "/api/generations", {
    providerId: "local",
    model,
    content,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });
}

function files(root: string, rel = ""): string[] {
  return readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? files(root, child) : [child];
  });
}

describe("INV-50: backup and restore", () => {
  it("INV-50: round trip: every canonical store survives; derived and transient state is left out", async () => {
    const dataDir = tempDataDir();
    const { base, chatui } = await serve(dataDir);
    const alice = await signIn(base, chatui);
    await api(base, alice, "POST", "/api/memories", { name: "Fact", content: "Kept note" });
    await api(base, alice, "POST", "/api/skills", {
      name: "tone",
      description: "",
      instructions: "Be brief",
    });
    const form = new FormData();
    form.append("file", new Blob(["attached words"], { type: "text/plain" }), "notes.txt");
    const up = await fetch(`${base}/api/attachments`, {
      method: "POST",
      headers: alice.headers(true),
      body: form,
    });
    const attachmentId = ((await up.json()) as { id: string }).id;
    const sent = await send(base, alice, "mock-chat", "keep this conversation");
    await chatui.services.generations.settled((sent.body as { generationId: string }).generationId);
    const conversationId = (sent.body as { conversationId: string }).conversationId;
    const chatFile = path.join(dataDir, alice.userId, "chats", `${conversationId}.md`);
    const chatBytes = readFileSync(chatFile);
    await stop(chatui);

    const dest = path.join(tempDir("chatui-backup-"), "snapshot");
    const manifest = await createBackup(dataDir, dest);
    const listed = manifest.files.map((f) => f.path);
    expect(listed).toContain(`${alice.userId}/chats/${conversationId}.md`);
    expect(listed).toContain("_system/providers.json");
    expect(listed.some((p) => p.startsWith(`${alice.userId}/attachments/${attachmentId}/`))).toBe(
      true,
    );
    expect(listed.some((p) => p.startsWith(`${alice.userId}/memories/`))).toBe(true);
    expect(listed.some((p) => /\/index\/|import-staging|_system\/sessions/.test(p))).toBe(false);
    expect(files(path.join(dest, "data")).sort()).toEqual([...listed].sort());

    const restored = path.join(tempDataDir(), "restored");
    await restoreBackup(dest, restored);
    expect(
      readFileSync(path.join(restored, alice.userId, "chats", `${conversationId}.md`)).equals(
        chatBytes,
      ),
    ).toBe(true);
    // The restored server rebuilds indexes at startup; sessions were not kept.
    const again = await serve(restored);
    const alice2 = await signIn(again.base, again.chatui);
    expect(alice2.userId).toBe(alice.userId);
    const list = await api(again.base, alice2, "GET", "/api/conversations");
    expect(JSON.stringify(list.body)).toContain(conversationId);
    const memories = await api(again.base, alice2, "GET", "/api/memories");
    expect(JSON.stringify(memories.body)).toContain("Kept note");
    const content = await fetch(`${again.base}/api/attachments/${attachmentId}/content`, {
      headers: alice2.headers(false),
    });
    expect(await content.text()).toBe("attached words");
  });

  it(
    "INV-50: a snapshot taken mid-generation restores, and recovery persists the reply exactly once",
    { timeout: 30_000 },
    async () => {
      const dataDir = tempDataDir();
      const { base, chatui } = await serve(dataDir);
      const alice = await signIn(base, chatui);
      const sent = await send(base, alice, "mock-slow", "long answer please");
      const { conversationId } = sent.body as { conversationId: string };
      // Let a checkpoint of the partial reply reach disk, then take the snapshot
      // while the generation is still running (like a filesystem snapshot).
      await vi.waitFor(
        () => {
          expect(files(path.join(dataDir, "_system", "generations")).length).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      const dest = path.join(tempDir("chatui-backup-"), "snapshot");
      await createBackup(dataDir, dest);
      await stop(chatui);

      const restored = path.join(tempDataDir(), "restored");
      await restoreBackup(dest, restored);
      const again = await serve(restored);
      const parsed = parseConversation(
        readFileSync(path.join(restored, alice.userId, "chats", `${conversationId}.md`), "utf8"),
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      const replies = parsed.conversation.blocks.filter((b) => b.type === "assistant");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ status: "interrupted" });
      await stop(again.chatui);
      // A second start recreates nothing.
      const third = await serve(restored);
      const reparsed = parseConversation(
        readFileSync(path.join(restored, alice.userId, "chats", `${conversationId}.md`), "utf8"),
      );
      if (!reparsed.ok) throw new Error(reparsed.reason);
      expect(reparsed.conversation.blocks.filter((b) => b.type === "assistant")).toHaveLength(1);
      await stop(third.chatui);
    },
  );

  it("INV-50: restore refuses non-empty state, altered, unlisted or unsafe files, and leaves nothing behind", async () => {
    const dataDir = tempDataDir();
    mkdirSync(path.join(dataDir, "_system"), { recursive: true });
    writeFileSync(path.join(dataDir, "_system", "providers.json"), '{"version":1,"providers":[]}');
    mkdirSync(path.join(dataDir, "11111111-1111-4111-8111-111111111111", "chats"), {
      recursive: true,
    });
    writeFileSync(
      path.join(dataDir, "11111111-1111-4111-8111-111111111111", "chats", "a.md"),
      "chat",
    );
    const dest = path.join(tempDir("chatui-backup-"), "snapshot");
    await createBackup(dataDir, dest);
    await expect(createBackup(dataDir, dest)).rejects.toThrow(/new or empty/);
    // A backup inside DATA_DIR would copy itself.
    await expect(createBackup(dataDir, path.join(dataDir, "backups", "b1"))).rejects.toThrow(
      /outside DATA_DIR/,
    );
    await expect(createBackup(dataDir, dataDir)).rejects.toThrow(/outside DATA_DIR/);

    // Into existing data: never merged.
    await expect(restoreBackup(dest, dataDir)).rejects.toThrow(/not empty/);

    const chat = path.join(dest, "data", "11111111-1111-4111-8111-111111111111", "chats", "a.md");
    writeFileSync(chat, "chat!");
    await expect(verifyBackup(dest)).rejects.toThrow(/checksum mismatch/);
    const target = path.join(tempDataDir(), "restored");
    await expect(restoreBackup(dest, target)).rejects.toThrow(BackupError);
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
    writeFileSync(chat, "chat");

    writeFileSync(path.join(dest, "data", "_system", "extra.json"), "{}");
    await expect(verifyBackup(dest)).rejects.toThrow(/not in the manifest/);
    await import("node:fs/promises").then((fs) =>
      fs.rm(path.join(dest, "data", "_system", "extra.json")),
    );

    const manifestFile = path.join(dest, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      files: { path: string }[];
    };
    const original = JSON.stringify(manifest);
    for (const bad of ["../outside", "/etc/passwd", "a/../../b", "a\\b", "x/index/chats.json"]) {
      const copy = JSON.parse(original) as { files: { path: string }[] };
      if (copy.files[0]) copy.files[0].path = bad;
      writeFileSync(manifestFile, JSON.stringify(copy));
      await expect(verifyBackup(dest), bad).rejects.toThrow(BackupError);
    }
    writeFileSync(manifestFile, original);
    await expect(verifyBackup(dest)).resolves.toBeTruthy();
  });

  it("INV-50: one process owns DATA_DIR: a live holder is refused, a stale lock is replaced", async () => {
    const dataDir = tempDataDir();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      mkdirSync(path.join(dataDir, "_system"), { recursive: true });
      writeFileSync(
        path.join(dataDir, "_system", "server.lock"),
        JSON.stringify({ pid: child.pid }),
      );
      expect(lockHolder(dataDir)).toBe(child.pid);
      await expect(acquireInstanceLock(dataDir)).rejects.toThrow(/in use by process/);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    expect(lockHolder(dataDir)).toBeNull();
    const release = await acquireInstanceLock(dataDir);
    expect(
      JSON.parse(readFileSync(path.join(dataDir, "_system", "server.lock"), "utf8")),
    ).toMatchObject({
      pid: process.pid,
    });
    // The lock is never part of a backup.
    const dest = path.join(tempDir("chatui-backup-"), "snapshot");
    expect((await createBackup(dataDir, dest)).files.map((f) => f.path)).not.toContain(
      "_system/server.lock",
    );
    await release();
    expect(existsSync(path.join(dataDir, "_system", "server.lock"))).toBe(false);
  });
});

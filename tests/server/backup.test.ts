import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertOffline,
  BackupError,
  createBackup,
  MANIFEST,
  restoreBackup,
} from "../../server/backup.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { InstanceLock } from "../../server/storage/instance-lock.ts";
import { makePng } from "../support/media.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { providerConfig, signIn, tempDataDir, testApp, type TestSession } from "./helpers.ts";

/** Phase 16: offline backup → restore round trip (contracts §1, INV-50). */

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4, slowChunks: 40, chunkDelayMs: 40 });
});
afterAll(async () => {
  await llama.close();
});

interface Run {
  base: string;
  chatui: ChatUiApp;
  server: Server;
  dataDir: string;
}
const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await stopServer(run);
});

async function start(dataDir: string): Promise<Run> {
  const { chatui } = testApp({
    config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const run = {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    chatui,
    server,
    dataDir,
  };
  runs.push(run);
  return run;
}

async function stopServer(run: Run) {
  const at = runs.indexOf(run);
  if (at >= 0) runs.splice(at, 1);
  await run.chatui.shutdown();
  run.server.closeAllConnections();
  await new Promise<void>((resolve) => {
    run.server.close(() => {
      resolve();
    });
  });
}

async function post(run: Run, who: TestSession, url: string, body: unknown) {
  const res = await fetch(`${run.base}${url}`, {
    method: "POST",
    headers: { ...who.headers(true), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, string> };
}

const sendBody = (content: string, model: string = MOCK_MODELS.chat) => ({
  providerId: "local",
  model,
  content,
  operationKey: crypto.randomUUID(),
  operationIssuedAt: new Date().toISOString(),
});

/** An account with chats, a file, a captured file, a memory and a reply cut off mid-stream. */
async function populate(run: Run) {
  const alice = await signIn(run.base, run.chatui, "alice");
  const done = await post(
    run,
    alice,
    "/api/generations",
    sendBody("x\n```txt file=kept.txt\nkept\n```"),
  );
  await run.chatui.services.generations.settled(done.json.generationId ?? "");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(makePng(8, 8))], { type: "image/png" }), "p.png");
  const uploaded = (await (
    await fetch(`${run.base}/api/attachments`, {
      method: "POST",
      headers: alice.headers(true),
      body: form,
    })
  ).json()) as { id: string };
  await run.chatui.services.memory.create(alice.userId, { name: "Pet", body: "has a cat" });
  const slow = await post(run, alice, "/api/generations", sendBody("cut me off", MOCK_MODELS.slow));
  const generationId = slow.json.generationId ?? "";
  await vi.waitFor(() => {
    expect(run.chatui.services.generations.snapshot(generationId).content).toContain("part3");
  });
  return {
    alice,
    chatId: done.json.conversationId ?? "",
    cutId: slow.json.conversationId ?? "",
    generationId,
    attachmentId: uploaded.id,
  };
}

describe("backup and restore", () => {
  it("round-trips every canonical store, including unfinished recovery state", async () => {
    const source = tempDataDir();
    const run = await start(source);
    const made = await populate(run);
    await stopServer(run); // graceful: the slow reply stays a running checkpoint
    expect(
      existsSync(path.join(source, "_system", "generations", `${made.generationId}.json`)),
    ).toBe(true);

    const out = path.join(tempDataDir(), "backup");
    const result = await createBackup({
      dataDir: source,
      out,
      includeSessions: false,
      chatuiVersion: "9.9.9",
    });
    expect(result.files).toBeGreaterThan(8);
    const manifest = JSON.parse(readFileSync(path.join(out, MANIFEST), "utf8")) as {
      files: { path: string }[];
      includesSessions: boolean;
    };
    const listed = manifest.files.map((f) => f.path);
    const user = made.alice.userId;
    expect(listed).toContain(`${user}/chats/${made.chatId}.md`);
    expect(listed).toContain(`${user}/attachments/${made.attachmentId}/blob`);
    expect(listed.some((p) => p.startsWith(`${user}/memories/`))).toBe(true);
    expect(listed.some((p) => p.startsWith(`${user}/artifacts/`))).toBe(true);
    expect(listed).toContain(`_system/generations/${made.generationId}.json`);
    expect(listed).toContain("_system/providers.json");
    // Derived, transient and session state stays out.
    expect(listed.some((p) => p.includes("/index/"))).toBe(false);
    expect(listed.some((p) => p.startsWith("_system/sessions/"))).toBe(false);
    expect(listed.some((p) => p.endsWith(".tmp"))).toBe(false);
    expect(manifest.includesSessions).toBe(false);

    const target = path.join(tempDataDir(), "restored");
    await restoreBackup({ from: out, dataDir: target });
    // Files are private to the server user.
    const chatFile = path.join(target, user, "chats", `${made.chatId}.md`);
    expect((await import("node:fs")).statSync(chatFile).mode & 0o777).toBe(0o600);

    const again = await start(target);
    // Startup recovery wrote the cut-off reply once, as interrupted.
    const cut = await again.chatui.services.conversations.get(user, made.cutId);
    const replies = cut.model.blocks.filter((b) => b.type === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ status: "interrupted" });
    // The index is rebuilt, files and memories are back.
    expect(
      again.chatui.services.conversations
        .list(user)
        .map((c) => c.id)
        .sort(),
    ).toEqual([made.chatId, made.cutId].sort());
    expect(
      await again.chatui.services.attachments.readBlob(user, made.attachmentId),
    ).not.toBeNull();
    expect((await again.chatui.services.memory.list(user)).map((m) => m.name)).toEqual(["Pet"]);
    expect((await again.chatui.services.artifacts.list(user)).length).toBe(1);
    // Sessions were not restored: the old cookie is signed out; the password still works.
    const old = await fetch(`${again.base}/api/conversations`, { headers: made.alice.headers() });
    expect(old.status).toBe(401);
    await signIn(again.base, again.chatui, "alice");
  });

  it("with --with-sessions the restored users stay signed in", async () => {
    const source = tempDataDir();
    const run = await start(source);
    const alice = await signIn(run.base, run.chatui, "alice");
    await stopServer(run);
    const out = path.join(tempDataDir(), "b");
    await createBackup({ dataDir: source, out, includeSessions: true, chatuiVersion: "9.9.9" });
    const target = path.join(tempDataDir(), "r");
    await restoreBackup({ from: out, dataDir: target });
    const again = await start(target);
    const res = await fetch(`${again.base}/api/conversations`, { headers: alice.headers() });
    expect(res.status).toBe(200);
  });

  it("restore refuses non-empty targets, tampering, unknown files and unsafe paths, writing nothing", async () => {
    const source = tempDataDir();
    const run = await start(source);
    await signIn(run.base, run.chatui, "alice");
    await stopServer(run);
    const fresh = async () => {
      const out = path.join(tempDataDir(), "b");
      await createBackup({ dataDir: source, out, includeSessions: false, chatuiVersion: "9.9.9" });
      return out;
    };
    const emptyTarget = () => path.join(tempDataDir(), "t");

    const full = tempDataDir();
    writeFileSync(path.join(full, "existing"), "x");
    await expect(restoreBackup({ from: await fresh(), dataDir: full })).rejects.toThrow(
      /not empty/,
    );

    const tampered = await fresh();
    const manifest = JSON.parse(readFileSync(path.join(tampered, MANIFEST), "utf8")) as {
      files: { path: string }[];
    };
    const victim = manifest.files.find((f) => f.path.endsWith("user.json"))?.path ?? "";
    writeFileSync(path.join(tampered, victim), '{"role":"admin"}');
    let target = emptyTarget();
    await expect(restoreBackup({ from: tampered, dataDir: target })).rejects.toThrow(
      /Checksum mismatch/,
    );
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);

    const extra = await fresh();
    mkdirSync(path.join(extra, "_system", "x"), { recursive: true });
    writeFileSync(path.join(extra, "_system", "x", "planted.json"), "{}");
    target = emptyTarget();
    await expect(restoreBackup({ from: extra, dataDir: target })).rejects.toThrow(/does not list/);

    const traversal = await fresh();
    const m = JSON.parse(readFileSync(path.join(traversal, MANIFEST), "utf8")) as {
      files: { path: string; size: number; sha256: string }[];
    };
    m.files.push({ path: "../outside.txt", size: 0, sha256: "0".repeat(64) });
    writeFileSync(path.join(traversal, MANIFEST), JSON.stringify(m));
    await expect(restoreBackup({ from: traversal, dataDir: emptyTarget() })).rejects.toThrow(
      /Invalid manifest entry/,
    );
    await expect(restoreBackup({ from: tempDataDir(), dataDir: emptyTarget() })).rejects.toThrow(
      BackupError,
    );
  });

  it("backup and restore refuse to run while a server uses DATA_DIR", async () => {
    const dataDir = tempDataDir();
    mkdirSync(path.join(dataDir, "_system"), { recursive: true });
    const lock = new InstanceLock(dataDir);
    expect(await lock.acquire()).toBeNull();
    await expect(assertOffline(dataDir)).rejects.toThrow(/is using this DATA_DIR/);
    await lock.release();
    await expect(assertOffline(dataDir)).resolves.toBeUndefined();
    // A backup never goes inside DATA_DIR.
    await expect(
      createBackup({
        dataDir,
        out: path.join(dataDir, "b"),
        includeSessions: false,
        chatuiVersion: "x",
      }),
    ).rejects.toThrow(/inside DATA_DIR/);
  });
});

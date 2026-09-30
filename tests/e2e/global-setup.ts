import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { serializeConversation, validateModel, type Block } from "../../server/storage/markdown.ts";
import { richAnswer, startMockLlama } from "../support/mock-llama.ts";
import { png, wav } from "../support/media.ts";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const E2E_USER = "e2e";
export const E2E_PASSWORD = "e2e password 1234";
/** A second account for account-switch tests. */
export const E2E_OTHER_USER = "e2e-other";
/** An administrator (Phase 10 admin UI tests). */
export const E2E_ADMIN = "e2e-admin";
/**
 * Memory (13b) and file (13c) specs share the second account: every browser
 * sign-in counts toward the login limit (10 per address per 15 minutes), so
 * the run keeps its number of accounts small.
 */
export const E2E_MEMORY_USER = E2E_OTHER_USER;
export const E2E_FILES_USER = E2E_OTHER_USER;
/** A second provider on the same mock server whose configuration declares tool support. */
export const TOOLS_PROVIDER = "tools";
/** A seeded 200-message conversation owned by E2E_USER. */
export const LONG_CONVERSATION = "7e0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
export const LONG_TITLE = "Long seeded conversation";
/** A conversation with wide content: a long code line, a wide table, a long URL. */
export const WIDE_CONVERSATION = "9a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
export const WIDE_TITLE = "Wide content";

/** A stored reply with math, code and a malformed formula (Phase 14 rendering). */
export const RICH_CONVERSATION = "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
export const RICH_TITLE = "Math and code";
/** The malformed display formula in the rich conversation. */
export const MALFORMED_TEX = "\\frac{a}{";

/** A second 200-message conversation that the rendering spec streams into. */
export const STREAM_CONVERSATION = "6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a";
export const STREAM_TITLE = "Streaming target";
/** A plain-text 200-message conversation nothing writes to (no math, no code). */
export const PLAIN_CONVERSATION = "8f7e6d5c-4b3a-4291-8f0e-1d2c3b4a5f6e";
export const PLAIN_TITLE = "Plain text only";

/** A 120-message conversation: every user message carries two images; the first also audio and text (Phase 12). */
export const ATTACHMENTS_CONVERSATION = "5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f";
export const ATTACHMENTS_TITLE = "Many attachments";
export const SEEDED_IMAGES = 120;

/** Unique text in an older message (find-in-page). */
export const OLDER_NEEDLE = "needle-older-message-17";

function createUser(dataDir: string, username: string, admin = false): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["server/cli.ts", "user:create", "--username", username, ...(admin ? ["--admin"] : [])],
      {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: dataDir },
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
    child.stdin.end(`${E2E_PASSWORD}\n`);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`user:create failed (${String(code)})`));
    });
  });
}

function userIdOf(dataDir: string, username: string): string {
  for (const entry of readdirSync(dataDir)) {
    const file = path.join(dataDir, entry, "user.json");
    if (!existsSync(file)) continue;
    const user = JSON.parse(readFileSync(file, "utf8")) as { username?: string };
    if (user.username === username) return entry;
  }
  throw new Error(`no account ${username}`);
}

function seedWideConversation(dataDir: string, userId: string): void {
  const at = "2026-01-02T00:00:00.000Z";
  const code = `const wide = "${"x".repeat(400)}";`;
  const table = `| ${Array.from({ length: 14 }, (_, i) => `column ${String(i)}`).join(" | ")} |\n|${" --- |".repeat(14)}\n| ${Array.from({ length: 14 }, (_, i) => `value-${String(i)}-long`).join(" | ")} |`;
  const model = {
    title: WIDE_TITLE,
    createdAt: at,
    updatedAt: at,
    blocks: [
      { type: "user" as const, id: randomUUID(), time: at, body: "Show me wide things" },
      {
        type: "assistant" as const,
        id: randomUUID(),
        status: "complete" as const,
        provider: "local",
        model: "mock-chat",
        time: at,
        body: `Here:\n\n\`\`\`js\n${code}\n\`\`\`\n\n${table}\n\nhttps://example.com/${"segment".repeat(40)}`,
      },
    ],
  };
  const problem = validateModel(model);
  if (problem) throw new Error(problem);
  const dir = path.join(dataDir, userId, "chats");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, `${WIDE_CONVERSATION}.md`), serializeConversation(model), {
    mode: 0o600,
  });
}

function seedRichConversation(dataDir: string, userId: string): void {
  // Older than the other seeded chats, so their sidebar order is unchanged.
  const at = "2025-12-15T00:00:00.000Z";
  const model = {
    title: RICH_TITLE,
    createdAt: at,
    updatedAt: at,
    blocks: [
      { type: "user" as const, id: randomUUID(), time: at, body: "Math and code, please" },
      {
        type: "assistant" as const,
        id: randomUUID(),
        status: "complete" as const,
        provider: "local",
        model: "mock-rich",
        time: at,
        body: `${richAnswer()}\n\nMalformed: $$${MALFORMED_TEX}$$\n\nA matrix: $$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$`,
      },
    ],
  };
  const problem = validateModel(model);
  if (problem) throw new Error(problem);
  const dir = path.join(dataDir, userId, "chats");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, `${RICH_CONVERSATION}.md`), serializeConversation(model), {
    mode: 0o600,
  });
}

/** Writes a canonical 200-message conversation (picked up by startup reconciliation). */
function seedLongConversation(
  dataDir: string,
  userId: string,
  id = LONG_CONVERSATION,
  title = LONG_TITLE,
): void {
  const blocks: Block[] = [];
  for (let i = 0; i < 100; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    blocks.push({ type: "user", id: randomUUID(), time: at, body: `Question ${String(i)}` });
    const needle = i === 17 && id === LONG_CONVERSATION ? ` ${OLDER_NEEDLE}` : "";
    blocks.push({
      type: "assistant",
      id: randomUUID(),
      status: "complete",
      provider: "local",
      model: "mock-chat",
      time: at,
      body: `Answer ${String(i)}${needle}.\n\nA second paragraph so every reply has some height.`,
    });
  }
  const model = {
    title,
    // The streaming target sorts below the other seeded chats.
    createdAt: id === LONG_CONVERSATION ? "2026-01-01T00:00:00.000Z" : "2025-12-01T00:00:00.000Z",
    updatedAt: id === LONG_CONVERSATION ? "2026-01-01T02:00:00.000Z" : "2025-12-01T02:00:00.000Z",
    blocks,
  };
  const problem = validateModel(model);
  if (problem) throw new Error(problem);
  const dir = path.join(dataDir, userId, "chats");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, `${id}.md`), serializeConversation(model), {
    mode: 0o600,
  });
}

/** Linked attachments on disk, as the server writes them (contracts §7). */
function seedAttachmentsConversation(dataDir: string, userId: string): void {
  const blocks: Block[] = [];
  const write = (
    bytes: Buffer,
    filename: string,
    mediaType: string,
    kind: string,
    messageId: string,
    size?: { width: number; height: number },
  ) => {
    const id = randomUUID();
    const dir = path.join(dataDir, userId, "attachments", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, "blob"), bytes, { mode: 0o600 });
    const meta = {
      version: 1,
      id,
      ownerId: userId,
      conversationId: ATTACHMENTS_CONVERSATION,
      messageId,
      filename,
      mediaType,
      kind,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: "2026-01-03T00:00:00.000Z",
      ...(size ?? {}),
    };
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
    return id;
  };
  for (let i = 0; i < 60; i++) {
    const at = new Date(Date.UTC(2026, 0, 3, 0, i)).toISOString();
    const userId_ = randomUUID();
    const attachments: string[] = [];
    // Two images per user message, plus audio and text once.
    if (i < SEEDED_IMAGES / 2)
      for (let k = 0; k < 2; k++)
        attachments.push(
          write(
            png(64, 48, [20 * k, 8 * i, 200]),
            `photo-${String(i)}-${String(k)}.png`,
            "image/png",
            "image",
            userId_,
            { width: 64, height: 48 },
          ),
        );
    if (i === 0) {
      attachments.push(write(wav(200), "clip.wav", "audio/wav", "audio", userId_));
      attachments.push(
        write(Buffer.from("# Notes\n"), "notes.md", "text/markdown", "text", userId_),
      );
    }
    blocks.push({
      type: "user",
      id: userId_,
      time: at,
      body: `Look at these ${String(i)}`,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    blocks.push({
      type: "assistant",
      id: randomUUID(),
      status: "complete",
      provider: "local",
      model: "mock-vision",
      time: at,
      body: `Reply ${String(i)}.\n\nA second paragraph so every reply has some height.`,
    });
  }
  const model = {
    title: ATTACHMENTS_TITLE,
    createdAt: "2026-01-03T00:00:00.000Z",
    updatedAt: "2026-01-03T01:00:00.000Z",
    blocks,
  };
  const problem = validateModel(model);
  if (problem) throw new Error(problem);
  const dir = path.join(dataDir, userId, "chats");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, `${ATTACHMENTS_CONVERSATION}.md`), serializeConversation(model), {
    mode: 0o600,
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Starts the production server against a paced mock provider; returns the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "chatui-e2e-"));
  const llama = await startMockLlama({
    chatChunkDelayMs: 30,
    chunkDelayMs: 120,
    slowChunks: 30,
    longChunkDelayMs: 15,
  });
  await createUser(dataDir, E2E_USER);
  await createUser(dataDir, E2E_OTHER_USER);
  await createUser(dataDir, E2E_ADMIN, true);
  // providers.json as an operator writes it: the bootstrap-equivalent `local`
  // provider, plus a tool-capable one (Phase 13b proposal tools).
  mkdirSync(path.join(dataDir, "_system"), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dataDir, "_system", "providers.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "local",
          name: "Local llama.cpp",
          kind: "openai-compatible",
          baseUrl: llama.url,
          capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
        },
        {
          id: TOOLS_PROVIDER,
          name: "Tool-capable mock",
          kind: "openai-compatible",
          baseUrl: llama.url,
          capabilities: { inputModalities: ["text"], reasoning: true, tools: true },
        },
      ],
    }),
    { mode: 0o600 },
  );
  seedLongConversation(dataDir, userIdOf(dataDir, E2E_USER));
  seedWideConversation(dataDir, userIdOf(dataDir, E2E_USER));
  seedRichConversation(dataDir, userIdOf(dataDir, E2E_USER));
  seedLongConversation(dataDir, userIdOf(dataDir, E2E_USER), STREAM_CONVERSATION, STREAM_TITLE);
  seedLongConversation(dataDir, userIdOf(dataDir, E2E_USER), PLAIN_CONVERSATION, PLAIN_TITLE);
  seedAttachmentsConversation(dataDir, userIdOf(dataDir, E2E_USER));
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const server = spawn(process.execPath, ["server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      PUBLIC_ORIGIN: base,
      DATA_DIR: dataDir,
      LLAMA_BASE_URL: llama.url,
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("server did not start"));
    }, 20_000);
    server.once("exit", (code) => {
      reject(new Error(`server exited (${String(code)})`));
    });
    createInterface({ input: server.stdout }).on("line", () => undefined);
    const poll = setInterval(() => {
      fetch(`${base}/api/health`).then(
        (res) => {
          if (res.ok) {
            clearInterval(poll);
            clearTimeout(timer);
            server.removeAllListeners("exit");
            resolve();
          }
        },
        () => undefined,
      );
    }, 200);
  });
  process.env.E2E_BASE_URL = base;
  process.env.E2E_DATA_DIR = dataDir;
  // Signed-in storage states for this run (see tests/e2e/auth.ts).
  const stateDir = mkdtempSync(path.join(tmpdir(), "chatui-e2e-state-"));
  process.env.E2E_STATE_DIR = stateDir;
  return async () => {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
    await llama.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  };
}

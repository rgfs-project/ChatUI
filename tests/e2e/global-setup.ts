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
import { startMockLlama } from "../support/mock-llama.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const E2E_USER = "e2e";
export const E2E_PASSWORD = "e2e password 1234";
/** A second account for account-switch tests. */
export const E2E_OTHER_USER = "e2e-other";
/** A seeded 200-message conversation owned by E2E_USER. */
export const LONG_CONVERSATION = "7e0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
export const LONG_TITLE = "Long seeded conversation";
/** Unique text in an older message (find-in-page). */
export const OLDER_NEEDLE = "needle-older-message-17";

function createUser(dataDir: string, username: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["server/cli.ts", "user:create", "--username", username],
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

/** Writes a canonical 200-message conversation (picked up by startup reconciliation). */
function seedLongConversation(dataDir: string, userId: string): void {
  const blocks: Block[] = [];
  for (let i = 0; i < 100; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    blocks.push({ type: "user", id: randomUUID(), time: at, body: `Question ${String(i)}` });
    const needle = i === 17 ? ` ${OLDER_NEEDLE}` : "";
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
    title: LONG_TITLE,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T02:00:00.000Z",
    blocks,
  };
  const problem = validateModel(model);
  if (problem) throw new Error(problem);
  const dir = path.join(dataDir, userId, "chats");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, `${LONG_CONVERSATION}.md`), serializeConversation(model), {
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
  seedLongConversation(dataDir, userIdOf(dataDir, E2E_USER));
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
  return async () => {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
    await llama.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
}

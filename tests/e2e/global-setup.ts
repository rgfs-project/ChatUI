import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { startMockLlama } from "../support/mock-llama.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const E2E_USER = "e2e";
export const E2E_PASSWORD = "e2e password 1234";
export const E2E_OTHER_USER = "e2e-other";
export const E2E_ADMIN = "e2e-admin";
/**
 * Browser state holding one signed-in session, created once: logins are
 * rate-limited per client address (contracts §6), so tests reuse it.
 */
export const E2E_AUTH_STATE = path.join(ROOT, "playwright", ".auth", "e2e.json");
export const E2E_ADMIN_STATE = path.join(ROOT, "playwright", ".auth", "admin.json");

async function saveSignedInState(
  base: string,
  username = E2E_USER,
  file = E2E_AUTH_STATE,
): Promise<void> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username, password: E2E_PASSWORD }),
  });
  const cookie = response.headers.get("set-cookie") ?? "";
  const [pair = ""] = cookie.split(";");
  const eq = pair.indexOf("=");
  if (!response.ok || eq < 1) throw new Error(`e2e sign-in failed (${String(response.status)})`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      cookies: [
        {
          name: pair.slice(0, eq),
          value: pair.slice(eq + 1),
          domain: new URL(base).hostname,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
  );
}
/** Messages in the seeded long conversation (100 exchanges). */
export const LONG_CHAT_MESSAGES = 200;
/** The seeded chat ends with one more exchange showing Markdown formatting. */
export const LONG_CHAT_TITLE = "Seeded long conversation";

function createUser(dataDir: string, username: string, admin = false): Promise<string> {
  const before = new Set(readdirSync(dataDir));
  return new Promise((resolve, reject) => {
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
      const created = readdirSync(dataDir).find((name) => !before.has(name) && name !== "_system");
      if (code === 0 && created) resolve(created);
      else reject(new Error(`user:create failed (${String(code)})`));
    });
  });
}

/** A canonical formatVersion 1 file with 200 messages, written before the server starts. */
function seedLongConversation(dataDir: string, userId: string): string {
  const id = randomUUID();
  const start = Date.parse("2026-10-01T09:00:00.000Z");
  const blocks: string[] = [];
  for (let i = 0; i < LONG_CHAT_MESSAGES / 2; i++) {
    const time = new Date(start + i * 60_000).toISOString();
    blocks.push(
      `<!-- cc:user id=${randomUUID()} time="${time}" -->\nQuestion number ${String(i)}: needle-${String(i)}`,
      `<!-- cc:assistant id=${randomUUID()} status=complete provider="local" model="mock-chat" time="${time}" -->\n` +
        `Answer number ${String(i)}. `.repeat(12).trim(),
    );
  }
  // The latest reply carries every Markdown element the measurement audit checks.
  blocks.push(
    `<!-- cc:user id=${randomUUID()} -->\nShow formatting`,
    `<!-- cc:assistant id=${randomUUID()} status=complete -->\n` +
      "Inline $a^2+b^2=c^2$, and it costs $5 and $10.\n\n$$\nE = mc^2\n$$\n\n" +
      "Use `inline code` here.\n\n```ts\nconst answer = 42; // " +
      "a very long line that must scroll inside the block ".repeat(8).trim() +
      "\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  );
  const file = [
    "---",
    "formatVersion: 1",
    `title: "${LONG_CHAT_TITLE}"`,
    `createdAt: "${new Date(start).toISOString()}"`,
    `updatedAt: "${new Date(start).toISOString()}"`,
    "---",
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
  const chats = path.join(dataDir, userId, "chats");
  mkdirSync(chats, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(chats, `${id}.md`), file, { mode: 0o600 });
  return id;
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
    longParagraphs: 40,
    longChunkDelayMs: 15,
  });
  const userId = await createUser(dataDir, E2E_USER);
  await createUser(dataDir, E2E_OTHER_USER);
  await createUser(dataDir, E2E_ADMIN, true);
  const longChat = seedLongConversation(dataDir, userId);
  // Tools are verified for this provider (D2): mock-tools drives the tool loop.
  mkdirSync(path.join(dataDir, "_system"), { recursive: true });
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
          capabilities: { inputModalities: ["text"], reasoning: false, tools: true },
        },
      ],
    }),
  );
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
      // One account drives the whole suite faster than a person could; the
      // per-account limits are covered in tests/server/security.test.ts.
      RATE_LIMIT_GENERATIONS: "10000",
      RATE_LIMIT_UPLOADS: "10000",
      RATE_LIMIT_ADMIN: "10000",
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
  await saveSignedInState(base);
  await saveSignedInState(base, E2E_ADMIN, E2E_ADMIN_STATE);
  process.env.E2E_BASE_URL = base;
  process.env.E2E_DATA_DIR = dataDir;
  process.env.E2E_LONG_CHAT = longChat;
  return async () => {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
    await llama.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
}

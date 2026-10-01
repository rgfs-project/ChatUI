/**
 * Clean-checkout proof (Phase 17). From a fresh clone of this repository:
 * `npm ci` → `.env` from `.env.example` → `npm run build` → admin account via
 * the CLI (password on stdin) → `npm start` → a full conversation in a real
 * browser against the deterministic mock provider → reload shows it stored →
 * clearing `data/` (keeping `.gitkeep`) returns the app to its initial state.
 *
 *   node scripts/clean-checkout.ts             clone HEAD (committed code)
 *   node scripts/clean-checkout.ts --worktree  copy the working tree instead
 *
 * Offline except for `npm ci`. Uses a temporary directory, removed afterwards.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import type * as MockLlamaModule from "../tests/support/mock-llama.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const PASSWORD = "clean checkout password";
const worktree = process.argv.includes("--worktree");

function step(message: string) {
  process.stdout.write(`clean-checkout: ${message}\n`);
}

function sh(cmd: string, args: string[], cwd: string, input?: string) {
  execFileSync(cmd, args, {
    cwd,
    stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    ...(input === undefined ? {} : { input }),
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitHealthy(base: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the server did not become healthy");
}

function start(dir: string): ChildProcess {
  // `npm start` with the checkout's .env (Node reads it natively).
  return spawn(process.execPath, ["--env-file=.env", "server/main.ts"], {
    cwd: dir,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function stop(server: ChildProcess) {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await exited;
}

const work = mkdtempSync(path.join(tmpdir(), "chatui-clean-"));
const dir = path.join(work, "ChatUI");
let server: ChildProcess | undefined;
let mockClose: (() => Promise<void>) | undefined;
try {
  if (worktree) {
    step("copying the working tree (tracked and untracked, not ignored)");
    const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: ROOT,
    })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    for (const file of files)
      cpSync(path.join(ROOT, file), path.join(dir, file), { recursive: true });
  } else {
    step("cloning HEAD");
    sh("git", ["clone", "--quiet", "--no-local", ROOT, dir], work);
  }
  step("npm ci");
  sh("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], dir);

  const mock = (await import(
    path.join(dir, "tests/support/mock-llama.ts")
  )) as typeof MockLlamaModule;
  const llama = await mock.startMockLlama({ slots: 2, chatChunkDelayMs: 5 });
  mockClose = () => llama.close();
  const port = await freePort();
  const base = `http://localhost:${String(port)}`;

  step("writing .env from .env.example");
  const env = readFileSync(path.join(dir, ".env.example"), "utf8")
    .replace(/^PORT=.*$/m, `PORT=${String(port)}`)
    .replace(/^NODE_ENV=.*$/m, "NODE_ENV=production")
    .replace(/^#?\s*PUBLIC_ORIGIN=.*$/m, `PUBLIC_ORIGIN=${base}`)
    .replace(/^#?\s*LLAMA_BASE_URL=.*$/m, `LLAMA_BASE_URL=${llama.url}`);
  writeFileSync(
    path.join(dir, ".env"),
    `${env}\n${/^PUBLIC_ORIGIN=/m.test(env) ? "" : `PUBLIC_ORIGIN=${base}\n`}${/^LLAMA_BASE_URL=/m.test(env) ? "" : `LLAMA_BASE_URL=${llama.url}\n`}`,
  );

  step("npm run build");
  sh("npm", ["run", "build", "--silent"], dir);

  step("creating the admin with the CLI (password on stdin)");
  sh(
    process.execPath,
    ["--env-file=.env", "server/cli.ts", "user:create", "--username", "admin", "--admin"],
    dir,
    `${PASSWORD}\n`,
  );

  step("npm start");
  server = start(dir);
  await waitHealthy(base);

  step("a full conversation in the browser");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/login`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/chat\/new$/);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.locator(`[data-model='${JSON.stringify(["local", "mock-chat"])}']`).click();
  await page.locator("#message").fill("hello from a clean checkout");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  const reply = page.getByTestId("message-assistant").last();
  await reply.waitFor({ timeout: 30_000 });
  await page.reload();
  await page.waitForSelector('html[data-hydrated="true"]');
  const stored = (await page.getByTestId("message-assistant").last().textContent()) ?? "";
  if (!stored.trim()) throw new Error("the reply was not stored");
  if (!(await page.getByTestId("message-user").last().textContent())?.includes("clean checkout"))
    throw new Error("the message was not stored");
  await browser.close();

  step("clearing data/ (keeping .gitkeep) returns the app to its initial state");
  await stop(server);
  const data = path.join(dir, "data");
  for (const entry of readdirSync(data))
    if (entry !== ".gitkeep") rmSync(path.join(data, entry), { recursive: true, force: true });
  server = start(dir);
  await waitHealthy(base);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  if (login.status !== 401)
    throw new Error(`expected no accounts after clearing data/, got ${String(login.status)}`);
  const left = readdirSync(data).filter((e) => e !== ".gitkeep" && e !== "_system");
  if (left.length > 0) throw new Error(`unexpected data after restart: ${left.join(", ")}`);
  step("PASS");
} finally {
  if (server) await stop(server);
  await mockClose?.();
  rmSync(work, { recursive: true, force: true });
}

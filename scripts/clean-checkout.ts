/**
 * Clean-checkout proof (Phase 17): from a fresh clone of the committed tree,
 *   npm ci → .env from .env.example → build → admin via the CLI (stdin) →
 *   start → a full conversation through real HTTP and a real browser against
 *   the deterministic mock provider → clean shutdown → deleting data/ (except
 *   .gitkeep) returns the app to its initial state.
 *
 *   node scripts/clean-checkout.ts
 *
 * Uses a temporary directory; never touches this checkout's data/ or .env.
 * Live providers are not used: LLAMA_BASE_URL points at the mock.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import type * as MockLlamaModule from "../tests/support/mock-llama.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const PASSWORD = "clean checkout password 4e1f";
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}\n`);
}

function sh(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const res = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: res.status ?? 1, out: `${res.stdout}${res.stderr}` };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** KEY=value lines of a dotenv file (comments and blanks skipped). */
function parseEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1]) env[match[1]] = match[2] ?? "";
  }
  return env;
}

function startServer(cwd: string, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["server/main.ts"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not start:\n${logs.join("")}`));
    }, 30_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${String(code)}):\n${logs.join("")}`));
    });
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      logs.push(line);
      if (line.includes('"msg":"listening"')) {
        clearTimeout(timer);
        child.removeAllListeners("exit");
        resolve(child);
      }
    });
  });
}

function stop(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
    child.kill("SIGTERM");
  });
}

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), "chatui-clean-"));
  const repo = path.join(work, "repo");
  try {
    const clone = sh(work, "git", ["clone", "--quiet", "--no-hardlinks", ROOT, repo]);
    check("fresh clone of the committed tree", clone.code === 0, clone.out);
    const tracked = sh(repo, "git", ["ls-files", "data"]).out.trim();
    check("data/ holds only .gitkeep in the repository", tracked === "data/.gitkeep", tracked);

    const ci = sh(repo, "npm", ["ci", "--no-audit", "--no-fund"]);
    check("npm ci", ci.code === 0, ci.out.slice(-2000));
    copyFileSync(path.join(repo, ".env.example"), path.join(repo, ".env"));
    const build = sh(repo, "npm", ["run", "build"]);
    check("npm run build", build.code === 0, build.out.slice(-2000));

    const mockModule = (await import(
      pathToFileURL(path.join(repo, "tests/support/mock-llama.ts")).href
    )) as typeof MockLlamaModule;
    const llama = await mockModule.startMockLlama();
    const port = await freePort();
    const base = `http://127.0.0.1:${String(port)}`;
    // .env.example as written, plus what a clean local run must set.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...parseEnv(path.join(repo, ".env")),
      NODE_ENV: "production",
      PORT: String(port),
      PUBLIC_ORIGIN: base,
      LLAMA_BASE_URL: llama.url,
      DATA_DIR: "./data",
    };
    try {
      const create = spawnSync(
        process.execPath,
        ["server/cli.ts", "user:create", "--username", "admin", "--admin"],
        { cwd: repo, env, input: `${PASSWORD}\n`, encoding: "utf8" },
      );
      check("admin created with the CLI (password on stdin)", create.status === 0, create.stderr);

      let server = await startServer(repo, env);
      const health = (await (await fetch(`${base}/api/health`)).json()) as { status?: string };
      check("health is ok", health.status === "ok");

      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        const problems: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
        });
        await page.goto(`${base}/login?returnTo=%2Fchat%2Fnew`);
        await page.waitForSelector('html[data-hydrated="true"]');
        await page.locator("#username").fill("admin");
        await page.locator("#password").fill(PASSWORD);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForURL(`${base}/chat/new`);
        await page.waitForSelector('html[data-hydrated="true"]');
        await page.getByTestId("composer-menu").click();
        await page.getByRole("menuitemradio", { name: /^mock-chat(\s|$)/ }).click();
        await page.locator("#message").fill("hello from a clean checkout");
        await page.getByRole("button", { name: "Send" }).click();
        await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
        const reply = page.getByTestId("message-assistant").last();
        await reply.getByText("Echo: hello from a clean checkout").waitFor();
        check("browser: sign in, send, and the streamed reply arrives", true);
        await page.reload();
        await page.waitForSelector('html[data-hydrated="true"]');
        await reply.getByText("Echo: hello from a clean checkout").waitFor();
        check("browser: the conversation is there after a reload", true);
        check(
          "browser: no console errors or warnings",
          problems.length === 0,
          problems.join(" | "),
        );
      } finally {
        await browser.close();
      }
      check("clean shutdown (exit 0)", (await stop(server)) === 0);

      // Deleting data/ (except .gitkeep) is a clean initial state.
      const dataDir = path.join(repo, "data");
      check("data/ was used", readdirSync(dataDir).length > 1);
      for (const name of readdirSync(dataDir))
        if (name !== ".gitkeep") rmSync(path.join(dataDir, name), { recursive: true, force: true });
      check(
        "the working tree is unchanged by running",
        sh(repo, "git", ["status", "--porcelain"]).out.trim() === "",
      );
      server = await startServer(repo, env);
      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ username: "admin", password: PASSWORD }),
      });
      check("after deleting data/, the old account no longer exists", login.status === 401);
      const status = await fetch(`${base}/status`);
      check("after deleting data/, the app starts fresh", status.status === 200);
      check("clean shutdown after the reset (exit 0)", (await stop(server)) === 0);
    } finally {
      await llama.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\nclean-checkout: ${String(results.length - failed.length)}/${String(results.length)} checks passed\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `clean-checkout failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

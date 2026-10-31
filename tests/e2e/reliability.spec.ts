import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import { startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { E2E_OTHER_STATE, E2E_PASSWORD } from "./global-setup.ts";
import { base, chooseModel, hydrated, send, signIn, storedReplies } from "./helpers.ts";

/**
 * Phase 17: behaviour the spec asks to see in a real browser, with the
 * absence of duplicated, lost or leaked replies asserted explicitly.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

test("a provider failure ends the reply as failed, once, without upstream details", async ({
  page,
}) => {
  await signIn(page);
  await chooseModel(page, "mock-500");
  await send(page, "this will fail");
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  const reply = storedReplies(page);
  await expect(reply).toHaveCount(1);
  await expect(reply.getByTestId("message-status")).toContainText("Failed");
  await expect(page.locator("body")).not.toContainText("boom");
  await page.reload();
  await hydrated(page);
  await expect(storedReplies(page)).toHaveCount(1);
  await expect(page.getByTestId("message-user")).toHaveCount(1);
  // The composer works again right away.
  await chooseModel(page, "mock-chat");
  await send(page, "and now it works");
  await expect(storedReplies(page)).toHaveCount(2);
  // The failed reply is empty, so the prompt carries both user turns.
  await expect(storedReplies(page).last()).toContainText("and now it works");
});

test("two users stream at the same time in separate browsers; nothing crosses over", async ({
  page,
  browser,
}) => {
  // A saved session: form sign-ins share the per-address login limit with the suite.
  const other = await browser.newContext({ storageState: E2E_OTHER_STATE });
  const second = await other.newPage();
  try {
    await signIn(page);
    await signIn(second);
    await chooseModel(page, "mock-slow");
    await chooseModel(second, "mock-slow");
    await send(page, "first user's secret plan");
    await send(second, "second user's secret plan");
    await Promise.all([
      page.waitForURL(/\/chat\/[0-9a-f-]{36}$/),
      second.waitForURL(/\/chat\/[0-9a-f-]{36}$/),
    ]);
    for (const p of [page, second])
      await expect(p.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("body")).not.toContainText("second user's");
    await expect(second.locator("body")).not.toContainText("first user's");
    // The other user's chat address is a not-found for this one.
    const theirs = new URL(second.url()).pathname;
    const res = await page.request.get(`${base()}${theirs}`);
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain("second user's");
    for (const p of [page, second]) {
      await p.reload();
      await hydrated(p);
      await expect(storedReplies(p)).toHaveCount(1);
    }
  } finally {
    await other.close();
  }
});

/** A server of its own, so it can be killed mid-reply without disturbing the suite. */
async function ownServer(dataDir: string, llamaUrl: string, port: number): Promise<ChildProcess> {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    PUBLIC_ORIGIN: `http://127.0.0.1:${String(port)}`,
    DATA_DIR: dataDir,
    LLAMA_BASE_URL: llamaUrl,
    LOG_LEVEL: "warn",
  };
  const child = spawn(process.execPath, ["server/main.ts"], {
    cwd: ROOT,
    env: { ...env, LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("server did not start"));
    }, 20_000);
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      if (line.includes('"msg":"listening"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
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

async function login(page: Page, origin: string) {
  await page.goto(`${origin}/login?returnTo=%2Fchat%2Fnew`);
  await hydrated(page);
  await page.locator("#username").fill("restart");
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/chat/new`);
  await hydrated(page);
}

test.describe("a server restart mid-generation", () => {
  let llama: MockLlama;
  let dataDir: string;
  test.beforeAll(async () => {
    llama = await startMockLlama({ slowChunks: 200, chunkDelayMs: 50 });
    dataDir = mkdtempSync(path.join(tmpdir(), "chatui-e2e-restart-"));
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
            capabilities: { inputModalities: ["text"], reasoning: false, tools: false },
          },
        ],
      }),
    );
    const created = spawnSync(
      process.execPath,
      ["server/cli.ts", "user:create", "--username", "restart"],
      { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir }, input: `${E2E_PASSWORD}\n` },
    );
    expect(created.status).toBe(0);
  });
  test.afterAll(async () => {
    await llama.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a hard kill mid-reply comes back as one interrupted reply with its partial text", async ({
    browser,
  }) => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    let server = await ownServer(dataDir, llama.url, port);
    try {
      await login(page, origin);
      await chooseModel(page, "mock-slow");
      await page.locator("#message").fill("keep going");
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
      // Past the first checkpoint (GENERATION_CHECKPOINT_MS, 1 s): its text survives a crash.
      await expect(page.getByTestId("content")).toContainText("part30", { timeout: 15_000 });
      // A crash, not a clean shutdown.
      server.kill("SIGKILL");
      await new Promise((resolve) => server.once("exit", resolve));
      server = await ownServer(dataDir, llama.url, port);
      await page.reload();
      await hydrated(page);
      const replies = storedReplies(page);
      await expect(replies).toHaveCount(1);
      await expect(replies.getByTestId("message-status")).toContainText("Interrupted");
      await expect(replies).toContainText("part0 part1");
      await expect(page.getByTestId("message-user")).toHaveCount(1);
      // Usable again: a new message gets a fresh reply.
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    } finally {
      server.kill("SIGTERM");
      await context.close();
    }
  });
});

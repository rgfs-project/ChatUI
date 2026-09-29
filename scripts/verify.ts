/**
 * End-to-end verification of the PRODUCTION build (run via `npm run verify`,
 * which builds first). Starts the real Express + React Router SSR server on an
 * ephemeral loopback port with a temporary DATA_DIR and checks:
 *   - health JSON; useful server HTML without executing JS; CSP nonce wiring
 *   - API / asset / document 404 separation and document status codes
 *   - hydration in a real browser under the production CSP with no warnings
 *   - clean shutdown; persistence across restarts, index rebuild, hand edits,
 *     malformed isolation and deletion (Phase 3)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { chromium, type ConsoleMessage } from "@playwright/test";
import { MOCK_MODELS, startMockLlama } from "../tests/support/mock-llama.ts";
import {
  browserChecks,
  chatChecks,
  check,
  httpChecks,
  results,
  sendAndWait,
} from "./lib/checks.ts";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
type Mode = "production" | "development";

function startServer(
  dataDir: string,
  mode: Mode,
  extraEnv: Record<string, string> = {},
): Promise<{ child: ChildProcess; port: number; logs: string[] }> {
  const args =
    mode === "development" ? ["--conditions=development", "server/main.ts"] : ["server/main.ts"];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: mode,
      PORT: "0",
      DATA_DIR: dataDir,
      LOG_LEVEL: "info",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not start:\n${logs.join("\n")}`));
    }, 15_000);
    child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${String(code)}):\n${logs.join("\n")}`));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      logs.push(line);
      try {
        const entry = JSON.parse(line) as { msg?: string; port?: number; host?: string };
        if (entry.msg === "listening" && typeof entry.port === "number") {
          clearTimeout(timer);
          child.removeAllListeners("exit");
          check(`${mode}: server binds to loopback only`, entry.host === "127.0.0.1", entry.host);
          resolve({ child, port: entry.port, logs });
        }
      } catch {
        // non-JSON line
      }
    });
  });
}

/**
 * React's production build does not report attribute hydration mismatches, so
 * hydration is also checked against the development build (dev CSP).
 */
async function developmentHydrationCheck(dataDir: string, llamaUrl: string): Promise<void> {
  const { child, port } = await startServer(dataDir, "development", { LLAMA_BASE_URL: llamaUrl });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        problems.push(`${msg.type()}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    for (const path of ["/", "/chat"]) {
      await page.goto(`http://127.0.0.1:${String(port)}${path}`);
      await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    }
    check(
      "INV-56: development build: / and /chat hydrate without mismatch or console warnings",
      problems.length === 0,
      problems.map((p) => p.slice(0, 300)).join(" | "),
    );
  } finally {
    await browser.close();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
}

const LOCAL_USER = "5f0c6a3e-9d0b-4c1e-8f2a-3b6d7e8f9a01";

async function stopServer(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

/**
 * Phase 3 persistence scenario on the production build: send → restart →
 * delete index → restart → hand-edit → corrupt one file → delete.
 */
async function persistenceChecks(llamaUrl: string): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "chatui-verify-persist-"));
  const env = { LLAMA_BASE_URL: llamaUrl };
  const chats = path.join(dataDir, LOCAL_USER, "chats");
  const get = async (base: string, url: string) => {
    const res = await fetch(`${base}${url}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    let server = await startServer(dataDir, "production", env);
    let base = `http://127.0.0.1:${String(server.port)}`;
    const first = await sendAndWait(base, MOCK_MODELS.chat, "remember me");
    const second = await sendAndWait(base, MOCK_MODELS.chat, "other conversation");
    await stopServer(server.child);

    server = await startServer(dataDir, "production", env);
    base = `http://127.0.0.1:${String(server.port)}`;
    const after = await get(base, `/api/conversations/${first.conversationId}`);
    check(
      "persistence: the conversation survives a restart",
      after.status === 200 && JSON.stringify(after.body).includes("Echo: remember me"),
    );
    await stopServer(server.child);

    rmSync(path.join(dataDir, LOCAL_USER, "index"), { recursive: true, force: true });
    server = await startServer(dataDir, "production", env);
    base = `http://127.0.0.1:${String(server.port)}`;
    const listed = (await get(base, "/api/conversations")).body.conversations as { id: string }[];
    check(
      "INV-11: deleting the index and restarting rebuilds it",
      listed.length === 2 && existsSync(path.join(dataDir, LOCAL_USER, "index", "chats.json")),
    );
    await stopServer(server.child);

    const file = path.join(chats, `${first.conversationId}.md`);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('title: "remember me"', 'title: "Edited by hand"'),
    );
    writeFileSync(
      path.join(chats, `${second.conversationId}.md`),
      "---\nthis is: not a conversation\n",
    );
    server = await startServer(dataDir, "production", env);
    base = `http://127.0.0.1:${String(server.port)}`;
    const entries = (await get(base, "/api/conversations")).body.conversations as {
      id: string;
      title: string;
      malformed: boolean;
    }[];
    check(
      "hand edits to Markdown are reflected after a restart",
      entries.some((e) => e.id === first.conversationId && e.title === "Edited by hand"),
    );
    const broken = await get(base, `/api/conversations/${second.conversationId}`);
    check(
      "INV-10: a corrupted file is listed as malformed and returns CONVERSATION_MALFORMED",
      entries.some((e) => e.id === second.conversationId && e.malformed) &&
        (broken.body.error as { code?: string } | undefined)?.code === "CONVERSATION_MALFORMED",
    );
    const stillWorks = await sendAndWait(
      base,
      MOCK_MODELS.chat,
      "still fine",
      first.conversationId,
    );
    check("another conversation keeps working next to a malformed one", stillWorks.status === 202);
    const deleted = await fetch(`${base}/api/conversations/${second.conversationId}`, {
      method: "DELETE",
    });
    const afterDelete = (await get(base, "/api/conversations")).body.conversations as {
      id: string;
    }[];
    check(
      "deleting the malformed conversation removes it",
      deleted.status === 200 &&
        !afterDelete.some((e) => e.id === second.conversationId) &&
        !existsSync(path.join(chats, `${second.conversationId}.md`)),
    );
    await stopServer(server.child);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (
    !existsSync(path.join(ROOT, "build/server/index.js")) ||
    !existsSync(path.join(ROOT, "build/client/assets"))
  ) {
    throw new Error(
      "Production build missing: run `npm run build` first (npm run verify does this).",
    );
  }
  const dataDir = mkdtempSync(path.join(tmpdir(), "chatui-verify-"));
  // Deterministic provider for the chat demo; paced so streaming is observable.
  const llama = await startMockLlama({ chatChunkDelayMs: 40, chunkDelayMs: 100, slowChunks: 30 });
  const { child, port, logs } = await startServer(dataDir, "production", {
    LLAMA_BASE_URL: llama.url,
  });
  const base = `http://127.0.0.1:${String(port)}`;
  try {
    await httpChecks(base);
    await browserChecks(base);
    await chatChecks(base, { chat: MOCK_MODELS.chat, slow: MOCK_MODELS.slow });
  } finally {
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => {
        resolve(code);
      }),
    );
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<"timeout">((r) =>
        setTimeout(() => {
          r("timeout");
        }, 12_000),
      ),
    ]);
    if (code === "timeout") child.kill("SIGKILL");
    check("clean shutdown on SIGTERM (exit 0)", code === 0, String(code));
    check(
      "shutdown logged",
      logs.some((line) => line.includes('"shutdown complete"')),
    );
    check(
      "DATA_DIR holds only the local user's directory",
      JSON.stringify(readdirSync(dataDir)) === JSON.stringify([LOCAL_USER]),
      readdirSync(dataDir).join(","),
    );
  }
  try {
    await persistenceChecks(llama.url);
    await developmentHydrationCheck(dataDir, llama.url);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    await llama.close();
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\nverify: ${String(results.length - failed.length)}/${String(results.length)} checks passed\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `verify failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

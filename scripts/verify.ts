/**
 * End-to-end verification of the PRODUCTION build (run via `npm run verify`,
 * which builds first). Starts the real Express + React Router SSR server on an
 * ephemeral loopback port with a temporary DATA_DIR and checks:
 *   - health JSON; useful server HTML without executing JS; CSP nonce wiring
 *   - API / asset / document 404 separation and document status codes
 *   - hydration in a real browser under the production CSP with no warnings
 *   - clean shutdown; DATA_DIR untouched
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { chromium, type ConsoleMessage } from "@playwright/test";
import { browserChecks, check, httpChecks, results } from "./lib/checks.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
type Mode = "production" | "development";

function startServer(
  dataDir: string,
  mode: Mode,
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
async function developmentHydrationCheck(dataDir: string): Promise<void> {
  const { child, port } = await startServer(dataDir, "development");
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
    await page.goto(`http://127.0.0.1:${String(port)}/`);
    await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    check(
      "INV-56: development build: hydration without mismatch or console warnings",
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
  const { child, port, logs } = await startServer(dataDir, "production");
  const base = `http://127.0.0.1:${String(port)}`;
  try {
    await httpChecks(base);
    await browserChecks(base);
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
    check("DATA_DIR untouched (nothing writes in Phase 1a)", readdirSync(dataDir).length === 0);
  }
  try {
    await developmentHydrationCheck(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
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

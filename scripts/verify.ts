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

const ROOT = path.resolve(import.meta.dirname, "..");
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push(detail === undefined ? { name, ok } : { name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}\n`);
}

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

function nonceOf(csp: string | null): string | undefined {
  const scriptSrc = csp?.split(";").find((d) => d.trim().startsWith("script-src ")) ?? "";
  return /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
}

async function httpChecks(base: string): Promise<string[]> {
  // Health API
  const health = await fetch(`${base}/api/health`);
  const healthBody: unknown = await health.json();
  check(
    "GET /api/health returns the health DTO",
    health.status === 200 &&
      JSON.stringify(healthBody) ===
        JSON.stringify({ status: "ok", version: process.env.npm_package_version ?? "0.1.0" }),
    JSON.stringify(healthBody),
  );

  // Server-rendered document, inspected WITHOUT executing JavaScript.
  const doc = await fetch(`${base}/`);
  const html = await doc.text();
  const csp = doc.headers.get("content-security-policy");
  const nonce = nonceOf(csp);
  check(
    "GET / is 200 text/html",
    doc.status === 200 && (doc.headers.get("content-type") ?? "").startsWith("text/html"),
  );
  check("INV-54: server HTML contains the heading", html.includes("<h1>ChatUI</h1>"));
  check(
    "INV-54: server HTML contains the server-rendered health result",
    html.includes('data-testid="health-status">OK<') &&
      /data-testid="health-version">[^<]+</.test(html),
  );
  check(
    "server HTML is not an empty client-side shell",
    !/<body>\s*<div id="root"><\/div>/.test(html) && html.length > 1000,
  );
  check("document is not cacheable", doc.headers.get("cache-control") === "no-store");
  check("CSP header present with a script nonce", Boolean(nonce), csp ?? "missing");
  check(
    "CSP has no unsafe-inline/unsafe-eval",
    !!csp && !/unsafe-(inline|eval)/.test(csp),
    csp ?? "",
  );
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  check(
    "INV-57: every <script> carries the response nonce",
    scripts.length > 0 && scripts.every((tag) => tag.includes(`nonce="${nonce ?? "?"}"`)),
    scripts.filter((tag) => !tag.includes(`nonce="${nonce ?? "?"}"`)).join(" "),
  );
  check("no inline event handler attributes", !/\son[a-z]+="/i.test(html));
  const second = nonceOf((await fetch(`${base}/`)).headers.get("content-security-policy"));
  check("nonce differs between responses", Boolean(second) && second !== nonce);

  // Boundaries and statuses.
  const apiMissing = await fetch(`${base}/api/unknown`);
  const apiMissingBody = (await apiMissing.json()) as { error?: { code?: string } };
  check(
    "INV-57: /api/unknown is a JSON 404 NOT_FOUND",
    apiMissing.status === 404 &&
      (apiMissing.headers.get("content-type") ?? "").startsWith("application/json") &&
      apiMissingBody.error?.code === "NOT_FOUND",
  );
  const assetMissing = await fetch(`${base}/assets/does-not-exist-123.js`);
  await assetMissing.arrayBuffer();
  check(
    "INV-57: missing asset is a non-HTML 404",
    assetMissing.status === 404 &&
      !(assetMissing.headers.get("content-type") ?? "").includes("text/html"),
  );
  const pageMissing = await fetch(`${base}/no/such/page`);
  const pageMissingHtml = await pageMissing.text();
  check(
    "INV-57: unknown document route is an HTML 404 rendered by the framework",
    pageMissing.status === 404 &&
      (pageMissing.headers.get("content-type") ?? "").startsWith("text/html") &&
      pageMissingHtml.includes("Page not found"),
  );
  const tooLarge = await fetch(`${base}/api/health`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: "y".repeat(400 * 1024) }),
  });
  const tooLargeBody = (await tooLarge.json()) as { error?: { code?: string } };
  check(
    "oversized body is 413 PAYLOAD_TOO_LARGE",
    tooLarge.status === 413 && tooLargeBody.error?.code === "PAYLOAD_TOO_LARGE",
  );

  // Real hashed assets referenced by the document are served immutably.
  const assetPaths = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((m) => m[1] ?? "");
  let immutable = assetPaths.length > 0;
  for (const assetPath of new Set(assetPaths)) {
    const asset = await fetch(`${base}${assetPath}`);
    await asset.arrayBuffer();
    if (asset.status !== 200 || !(asset.headers.get("cache-control") ?? "").includes("immutable"))
      immutable = false;
  }
  check("referenced hashed assets are first-party and immutable", immutable, assetPaths.join(", "));
  const external = [...html.matchAll(/(?:href|src)="(https?:)?\/\/[^"]+"/g)].map((m) => m[0]);
  check("no third-party runtime asset URLs", external.length === 0, external.join(", "));
  return assetPaths;
}

async function browserChecks(base: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    // Without JavaScript: the server HTML alone is useful.
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    const staticPage = await noJs.newPage();
    await staticPage.goto(`${base}/`);
    check(
      "INV-54: without JS: heading visible",
      await staticPage.getByRole("heading", { name: "ChatUI" }).isVisible(),
    );
    check(
      "INV-54: without JS: health status visible",
      (await staticPage.getByTestId("health-status").textContent()) === "OK",
    );
    await noJs.close();

    // With JavaScript under the production CSP.
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error" || msg.type() === "warning")
        problems.push(`${msg.type()}: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("requestfailed", (req) => problems.push(`requestfailed: ${req.url()}`));
    await page.goto(`${base}/`);
    await page.waitForSelector('html[data-hydrated="true"]', { timeout: 10_000 });
    check("hydration completes", true);
    check(
      "hydrated page becomes interactive",
      (await page.getByTestId("hydration-state").textContent()) === "Interactive" &&
        (await page.getByRole("button", { name: "Check again" }).isEnabled()),
    );
    const healthResponse = page.waitForResponse((r) => r.url().endsWith("/api/health"));
    await page.getByRole("button", { name: "Check again" }).click();
    check("client fetch to /api/health allowed by CSP", (await healthResponse).status() === 200);
    check(
      "INV-56: no hydration mismatch, CSP violation or console warnings",
      problems.length === 0,
      problems.join(" | "),
    );
    const sw = await page.evaluate(async () =>
      "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    );
    check("no service worker registered", sw === 0);

    // The 404 document also hydrates cleanly.
    problems.length = 0;
    const missingUrl = `${base}/missing-page`;
    // Chromium reports the document's own intended 404 status as a console error; ignore only that.
    page.removeAllListeners("console");
    page.on("console", (msg: ConsoleMessage) => {
      const own = msg.location().url === missingUrl && msg.text().includes("404");
      if (!own && (msg.type() === "error" || msg.type() === "warning"))
        problems.push(`${msg.type()}: ${msg.text()}`);
    });
    const notFound = await page.goto(missingUrl);
    await page.waitForSelector('html[data-hydrated="true"]', { timeout: 10_000 });
    check(
      "404 document hydrates without problems",
      notFound?.status() === 404 && problems.length === 0,
      problems.join(" | "),
    );
    await context.close();
  } finally {
    await browser.close();
  }
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

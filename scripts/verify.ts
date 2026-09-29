/**
 * End-to-end verification of the PRODUCTION build (run via `npm run verify`,
 * which builds first). Starts the real Express + React Router SSR server on an
 * ephemeral loopback port with a temporary DATA_DIR and checks:
 *   - health JSON; useful server HTML without executing JS; CSP nonce wiring
 *   - API / asset / document 404 separation and document status codes
 *   - hydration in a real browser under the production CSP with no warnings
 *   - clean shutdown; persistence across restarts, index rebuild, hand edits,
 *     malformed isolation and deletion (Phase 3)
 *   - accounts via the CLI (password on stdin), sign-in, protected SSR with
 *     private no-store documents, cross-user isolation (also under concurrent
 *     requests), validated return-to, logout and disabled accounts (Phase 4)
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { chromium, type ConsoleMessage } from "@playwright/test";
import { MOCK_MODELS, startMockLlama } from "../tests/support/mock-llama.ts";
import { check as checkBudget, measure, type Budget } from "./perf-check.ts";
import {
  apiLogin,
  browserChecks,
  chatChecks,
  check,
  httpChecks,
  results,
  sendAndWait,
  sessionHeaders,
  type ApiSession,
} from "./lib/checks.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
type Mode = "production" | "development";
const PASSWORD = "verify password 1234";

/** A free loopback port, so PUBLIC_ORIGIN can name the exact origin. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Creates an account with the operator CLI; the password goes to stdin, never argv. */
function createUser(
  dataDir: string,
  username: string,
  admin = false,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["server/cli.ts", "user:create", "--username", username, ...(admin ? ["--admin"] : [])],
      { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(`${PASSWORD}\n`);
    child.once("exit", (code) => {
      resolve({ code, out });
    });
  });
}

async function startServer(
  dataDir: string,
  mode: Mode,
  extraEnv: Record<string, string> = {},
): Promise<{ child: ChildProcess; port: number; base: string; logs: string[] }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const args =
    mode === "development" ? ["--conditions=development", "server/main.ts"] : ["server/main.ts"];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: mode,
      PORT: String(port),
      PUBLIC_ORIGIN: base,
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
          resolve({ child, port: entry.port, base, logs });
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
    for (const path of ["/", "/login"]) {
      await page.goto(`http://127.0.0.1:${String(port)}${path}`);
      await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    }
    check(
      "INV-56: development build: / and /login hydrate without mismatch or console warnings",
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
  await createUser(dataDir, "persist");
  let session: ApiSession | undefined;
  const get = async (base: string, url: string) => {
    const res = await fetch(`${base}${url}`, { headers: session ? sessionHeaders(session) : {} });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const signIn = async (base: string): Promise<ApiSession> => {
    const s = await apiLogin(base, "persist", PASSWORD);
    if (!s) throw new Error("persistence: sign-in failed");
    session = s;
    return s;
  };
  try {
    let server = await startServer(dataDir, "production", env);
    let base = server.base;
    const me = await signIn(base);
    const chats = path.join(dataDir, me.userId, "chats");
    const first = await sendAndWait(base, me, MOCK_MODELS.chat, "remember me");
    const second = await sendAndWait(base, me, MOCK_MODELS.chat, "other conversation");
    await stopServer(server.child);

    server = await startServer(dataDir, "production", env);
    base = server.base;
    await signIn(base);
    const after = await get(base, `/api/conversations/${first.conversationId}`);
    check(
      "persistence: the conversation survives a restart",
      after.status === 200 && JSON.stringify(after.body).includes("Echo: remember me"),
    );
    await stopServer(server.child);

    rmSync(path.join(dataDir, me.userId, "index"), { recursive: true, force: true });
    server = await startServer(dataDir, "production", env);
    base = server.base;
    await signIn(base);
    const listed = (await get(base, "/api/conversations")).body.conversations as { id: string }[];
    check(
      "INV-11: deleting the index and restarting rebuilds it",
      listed.length === 2 && existsSync(path.join(dataDir, me.userId, "index", "chats.json")),
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
    base = server.base;
    await signIn(base);
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
      await signIn(base),
      MOCK_MODELS.chat,
      "still fine",
      first.conversationId,
    );
    check("another conversation keeps working next to a malformed one", stillWorks.status === 202);
    const deleted = await fetch(`${base}/api/conversations/${second.conversationId}`, {
      method: "DELETE",
      headers: sessionHeaders(session ?? me, true),
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

/**
 * Phase 4: protected SSR and API, cross-user isolation, validated return-to,
 * logout and disabled accounts, on the production build.
 */
async function authChecks(base: string, dataDir: string, admin: ApiSession): Promise<void> {
  const anon = await fetch(`${base}/chat/00000000-0000-4000-8000-000000000000`, {
    redirect: "manual",
  });
  await anon.arrayBuffer();
  check(
    "INV-54: signed out, /chat redirects to sign-in with a validated return-to",
    anon.status === 302 &&
      anon.headers.get("location") ===
        "/login?returnTo=%2Fchat%2F00000000-0000-4000-8000-000000000000",
    `${String(anon.status)} ${anon.headers.get("location") ?? ""}`,
  );
  const anonApi = await fetch(`${base}/api/conversations`);
  await anonApi.arrayBuffer();
  check("signed out, protected API routes return 401", anonApi.status === 401);

  const created = await createUser(dataDir, "bob");
  check("second account created with the CLI", created.code === 0, created.out);
  const bob = await apiLogin(base, "bob", PASSWORD);
  if (!bob) return;
  const secret = await sendAndWait(base, admin, MOCK_MODELS.chat, "admin-only secret");
  const doc = await fetch(`${base}/chat/${secret.conversationId}`, {
    headers: sessionHeaders(admin),
  });
  const docHtml = await doc.text();
  check(
    "INV-55: authenticated documents are private, no-store and contain the owner's transcript",
    doc.status === 200 &&
      doc.headers.get("cache-control") === "private, no-store" &&
      docHtml.includes("admin-only secret"),
  );
  const cross = await fetch(`${base}/chat/${secret.conversationId}`, {
    headers: sessionHeaders(bob),
  });
  const crossHtml = await cross.text();
  const crossApi = await fetch(`${base}/api/conversations/${secret.conversationId}`, {
    headers: sessionHeaders(bob),
  });
  await crossApi.arrayBuffer();
  check(
    "INV-15: another user's conversation looks like not-found (HTML and API)",
    !crossHtml.includes("admin-only secret") &&
      crossHtml.includes("does not exist") &&
      crossApi.status === 404,
  );
  // Concurrent requests with two identities never mix.
  const mixed = await Promise.all(
    Array.from({ length: 20 }, (_, i) => {
      const who = i % 2 === 0 ? admin : bob;
      return fetch(`${base}/chat/new`, { headers: sessionHeaders(who) }).then(async (r) => ({
        who,
        html: await r.text(),
      }));
    }),
  );
  check(
    "INV-55: concurrent documents for two users never mix identities",
    mixed.every(({ who, html }) => {
      const other = who === admin ? bob : admin;
      return (
        html.includes(`data-testid="signed-in-user">${who.username}<`) &&
        !html.includes(`data-testid="signed-in-user">${other.username}<`) &&
        (who === bob ? !html.includes("admin-only secret") : true)
      );
    }),
  );
  // Adversarial sentinel (Phase 9): the owner's private text must never reach
  // the other user through documents, route data (single fetch) or error
  // pages, even when both users' requests interleave.
  const targets = [
    `/chat/${secret.conversationId}`,
    `/chat/${secret.conversationId}.data`,
    "/no/such/page",
    "/chat/new",
  ];
  const interleaved = await Promise.all(
    Array.from({ length: 32 }, (_, i) => {
      const who = i % 2 === 0 ? admin : bob;
      const url = targets[Math.floor(i / 2) % targets.length] ?? "/chat/new";
      return fetch(`${base}${url}`, { headers: sessionHeaders(who), redirect: "manual" }).then(
        async (r) => ({
          who,
          url,
          body: await r.text(),
          headers: JSON.stringify(Object.fromEntries(r.headers)),
          cache: r.headers.get("cache-control") ?? "",
        }),
      );
    }),
  );
  const leaks = interleaved.filter(
    (r) =>
      r.who === bob &&
      (r.body.includes("admin-only secret") || r.headers.includes("admin-only secret")),
  );
  check(
    "INV-55: interleaved A/B documents, route data and error pages never leak A's sentinel to B",
    leaks.length === 0 &&
      interleaved.some(
        (r) => r.who === admin && r.url.endsWith(".data") && r.body.includes("admin-only secret"),
      ),
    leaks.map((l) => l.url).join(", "),
  );
  check(
    "INV-55: private route data (.data) and documents are never cacheable",
    interleaved
      .filter((r) => r.url.startsWith("/chat/"))
      .every((r) => r.cache.includes("no-store") && r.cache.includes("private")),
    [...new Set(interleaved.map((r) => `${r.url} ${r.cache}`))].join(" | "),
  );
  const returnTo = await fetch(`${base}/login?returnTo=%2F%2Fevil.example%2F`, {
    headers: sessionHeaders(bob),
    redirect: "manual",
  });
  await returnTo.arrayBuffer();
  check(
    "login return-to is validated (no open redirect)",
    returnTo.status === 302 && returnTo.headers.get("location") === "/chat",
    returnTo.headers.get("location") ?? "",
  );
  const out = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: sessionHeaders(bob, true),
  });
  await out.arrayBuffer();
  const afterLogout = await fetch(`${base}/api/conversations`, { headers: sessionHeaders(bob) });
  await afterLogout.arrayBuffer();
  check("after logout the session gets 401", out.status === 200 && afterLogout.status === 401);

  const bob2 = await apiLogin(base, "bob", PASSWORD);
  if (!bob2) return;
  const userFile = path.join(dataDir, bob2.userId, "user.json");
  const record = JSON.parse(readFileSync(userFile, "utf8")) as Record<string, unknown>;
  writeFileSync(userFile, JSON.stringify({ ...record, status: "disabled" })); // test-only helper
  const disabled = await fetch(`${base}/api/conversations`, { headers: sessionHeaders(bob2) });
  await disabled.arrayBuffer();
  check("a disabled account's session is rejected", disabled.status === 401);
}

/** Bundle budget (contracts §9.5): the real budget passes, a lowered one fails. */
function budgetChecks(): void {
  const sizes = measure();
  const budget = JSON.parse(
    readFileSync(path.join(ROOT, "performance-budget.json"), "utf8"),
  ) as Budget;
  const real = checkBudget(sizes, budget);
  check(
    "perf:check: the production build is within performance-budget.json",
    real.ok,
    real.lines.join(" | "),
  );
  const lowered: Budget = {
    ...budget,
    budgets: Object.fromEntries(
      Object.entries(budget.budgets).map(([k, v]) => [k, Math.floor(v * 0.5)]),
    ),
  };
  check("perf:check: an intentionally lowered budget fails", !checkBudget(sizes, lowered).ok);
  const assets = readdirSync(path.join(ROOT, "build/client/assets")).filter((f) =>
    /\.(js|css)$/.test(f),
  );
  check(
    "every JS/CSS asset name is content-hashed (a content change changes its URL)",
    assets.length > 0 && assets.every((f) => /-[\w-]{8,}\.(js|css)$/.test(f)),
    assets.filter((f) => !/-[\w-]{8,}\.(js|css)$/.test(f)).join(", "),
  );
  check(
    "every compressible asset has Brotli and gzip variants",
    assets.every(
      (f) =>
        statSync(path.join(ROOT, "build/client/assets", f)).size < 1024 ||
        (existsSync(path.join(ROOT, "build/client/assets", `${f}.br`)) &&
          existsSync(path.join(ROOT, "build/client/assets", `${f}.gz`))),
    ),
  );
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
  budgetChecks();
  const dataDir = mkdtempSync(path.join(tmpdir(), "chatui-verify-"));
  const created = await createUser(dataDir, "admin", true);
  const noArgv = await new Promise<number | null>((resolve) => {
    const child = spawn(
      process.execPath,
      ["server/cli.ts", "user:create", "--username", "x", "--password", "y"],
      {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: dataDir },
        stdio: "ignore",
      },
    );
    child.once("exit", resolve);
  });
  check(
    "first admin created with the CLI (password on stdin, never argv)",
    created.code === 0 && noArgv === 2,
    created.out,
  );
  // Deterministic provider for the chat demo; paced so streaming is observable.
  const llama = await startMockLlama({ chatChunkDelayMs: 40, chunkDelayMs: 100, slowChunks: 30 });
  const { child, base, logs } = await startServer(dataDir, "production", {
    LLAMA_BASE_URL: llama.url,
  });
  try {
    await httpChecks(base);
    await browserChecks(base);
    await chatChecks(
      base,
      { chat: MOCK_MODELS.chat, slow: MOCK_MODELS.slow },
      { username: "admin", password: PASSWORD },
    );
    const admin = await apiLogin(base, "admin", PASSWORD);
    if (admin) await authChecks(base, dataDir, admin);
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
    const entries = readdirSync(dataDir);
    check(
      "DATA_DIR holds only account directories and _system",
      entries.every((name) => name === "_system" || /^[0-9a-f-]{36}$/.test(name)),
      entries.join(","),
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

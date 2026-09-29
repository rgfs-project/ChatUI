/**
 * HTTP and browser checks shared by `verify` (host) and `verify:compose`
 * (container). Each check prints PASS/FAIL and is collected in `results`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type ConsoleMessage } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const VERSION = (
  JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

export const results: { name: string; ok: boolean; detail?: string }[] = [];

export function check(name: string, ok: boolean, detail?: string): void {
  results.push(detail === undefined ? { name, ok } : { name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}\n`);
}

function nonceOf(csp: string | null): string | undefined {
  const scriptSrc = csp?.split(";").find((d) => d.trim().startsWith("script-src ")) ?? "";
  return /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
}

export async function httpChecks(base: string): Promise<string[]> {
  // Health API
  const health = await fetch(`${base}/api/health`);
  const healthBody: unknown = await health.json();
  check(
    "GET /api/health returns the health DTO",
    health.status === 200 &&
      JSON.stringify(healthBody) === JSON.stringify({ status: "ok", version: VERSION }),
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
  check(
    "document is not cacheable (private, no-store)",
    doc.headers.get("cache-control") === "private, no-store",
  );
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

export async function browserChecks(base: string): Promise<void> {
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

/** A signed-in API client (cookie + CSRF token + expected user). */
export interface ApiSession {
  userId: string;
  username: string;
  cookie: string;
  csrfToken: string;
}

export function sessionHeaders(session: ApiSession, mutation = false): Record<string, string> {
  return {
    Cookie: session.cookie,
    ...(mutation ? { "X-CSRF-Token": session.csrfToken, "X-Expected-User": session.userId } : {}),
  };
}

/** Signs in over HTTP like a same-origin browser would. */
export async function apiLogin(
  base: string,
  username: string,
  password: string,
): Promise<ApiSession | undefined> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) return undefined;
  const body = (await res.json()) as { user: { id: string }; csrfToken: string };
  return {
    userId: body.user.id,
    username,
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    csrfToken: body.csrfToken,
  };
}

function sendPayload(model: string, content: string, conversationId?: string) {
  return JSON.stringify({
    ...(conversationId ? { conversationId } : {}),
    model,
    content,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });
}

/** Sends over HTTP and follows the SSE stream to its terminal event. */
export async function sendAndWait(
  base: string,
  session: ApiSession,
  model: string,
  content: string,
  conversationId?: string,
): Promise<{ status: number; conversationId: string; sse: string }> {
  const start = await fetch(`${base}/api/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders(session, true) },
    body: sendPayload(model, content, conversationId),
  });
  const started = (await start.json()) as { conversationId?: string; generationId?: string };
  if (start.status !== 202) return { status: start.status, conversationId: "", sse: "" };
  const stream = await fetch(`${base}/api/generations/${started.generationId ?? ""}/stream`, {
    headers: sessionHeaders(session),
  });
  return { status: 202, conversationId: started.conversationId ?? "", sse: await stream.text() };
}

/** Chat demo checks (host process with a mock provider), Phase 2 + 3 UI. */
export async function chatChecks(
  base: string,
  models: { chat: string; slow: string },
  account: { username: string; password: string },
): Promise<void> {
  const session = await apiLogin(base, account.username, account.password);
  check("API sign-in with the CLI-created account", session !== undefined);
  if (!session) return;
  // Raw server HTML, no JavaScript executed.
  const res = await fetch(`${base}/chat`, { headers: sessionHeaders(session) });
  const html = await res.text();
  check(
    "INV-54: /chat server HTML contains the native textarea",
    res.status === 200 && /<textarea[^>]*id="message"/.test(html),
  );
  check(
    "/chat server HTML lists discovered models",
    html.includes(`<option value="${models.chat}"`),
  );
  check(
    "/chat Send is disabled until hydration (no fake no-JS send)",
    html.includes('<button type="submit" disabled=""'),
  );

  // API send over real HTTP + SSE, persisted canonically.
  const sent = await sendAndWait(base, session, models.chat, "over http");
  check(
    "POST /api/generations returns 202 and the SSE stream ends with one terminal event",
    sent.status === 202 &&
      sent.sse.includes("event: snapshot") &&
      (sent.sse.match(/event: terminal/g) ?? []).length === 1,
  );
  const conversation = (await (
    await fetch(`${base}/api/conversations/${sent.conversationId}`, {
      headers: sessionHeaders(session),
    })
  ).json()) as {
    messages?: { role: string; content: string }[];
  };
  check(
    "the exchange is stored in the conversation",
    JSON.stringify(conversation.messages?.map((m) => [m.role, m.content])) ===
      JSON.stringify([
        ["user", "over http"],
        ["assistant", "Echo: over http"],
      ]),
  );

  const browser = await chromium.launch();
  try {
    const [cookieName, cookieValue] = session.cookie.split("=");
    const cookie = { name: cookieName ?? "", value: cookieValue ?? "", url: base };
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    await noJs.addCookies([cookie]);
    const staticPage = await noJs.newPage();
    await staticPage.goto(`${base}/chat?c=${sent.conversationId}`);
    check(
      "INV-54: without JS the transcript and textarea are server-rendered",
      (await staticPage.getByTestId("message-assistant").first().textContent())?.includes(
        "Echo: over http",
      ) === true && (await staticPage.locator("#message").isEditable()),
    );
    await noJs.close();

    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error" || msg.type() === "warning")
        problems.push(`${msg.type()}: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("dialog", (dialog) => void dialog.accept());

    // Sign in through the real login page (validated return-to).
    await page.goto(`${base}/chat`);
    await page.waitForURL(/\/login\?returnTo=%2Fchat$/);
    await page.waitForSelector('html[data-hydrated="true"]');
    await page.locator("#username").fill(account.username);
    await page.locator("#password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/chat$/);
    check("browser sign-in redirects back to the protected page", true);

    // Hold back every script so the user types before hydration.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/assets/**/*.js", async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(`${base}/chat`, { waitUntil: "domcontentloaded" });
    await page.locator("#message").fill("typed before hydration");
    release();
    await page.waitForSelector('html[data-hydrated="true"]', { timeout: 15_000 });
    await page.unroute("**/assets/**/*.js");
    check(
      "INV-56: text typed before hydration survives hydration",
      (await page.locator("#message").inputValue()) === "typed before hydration",
    );

    // First send creates the conversation; the URL then identifies it.
    await page.getByRole("button", { name: "Send" }).click();
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: "Echo: typed before hydration" })
      .waitFor({ timeout: 15_000 });
    check("browser send streams and stores the reply", true);
    check("the URL identifies the new conversation", /\/chat\?c=[0-9a-f-]{36}$/.test(page.url()));
    check(
      "the conversation is listed with its auto-title",
      (await page.getByTestId("conversation-list").textContent())?.includes(
        "typed before hydration",
      ) === true,
    );

    // Reload mid-generation: it keeps running and is re-observed.
    await page.locator("#model").selectOption(models.slow);
    await page.locator("#message").fill("slow one");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("content").filter({ hasText: "part2" }).waitFor({ timeout: 15_000 });
    await page.reload();
    await page.waitForSelector('html[data-hydrated="true"]');
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: "part29" })
      .waitFor({ timeout: 20_000 });
    check("INV-06: reload does not stop the generation; the reply is stored", true);

    // Stop.
    await page.locator("#model").selectOption(models.slow);
    await page.locator("#message").fill("cancel me");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("content").filter({ hasText: "part1" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop generating" }).click();
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: "Stopped" })
      .waitFor({ timeout: 10_000 });
    check("Stop cancels and stores a cancelled reply", true);

    // Rename and delete.
    await page.locator("#title").fill("Renamed in verify");
    await page.getByRole("button", { name: "Rename" }).click();
    await page
      .getByTestId("conversation-list")
      .filter({ hasText: "Renamed in verify" })
      .waitFor({ timeout: 5_000 });
    check("rename updates the title", true);
    await page.getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/\/chat$/);
    check(
      "delete removes the conversation",
      !((await page.getByTestId("conversation-list").textContent()) ?? "").includes(
        "Renamed in verify",
      ),
    );
    check(
      "chat demo: no console errors, warnings or CSP violations",
      problems.length === 0,
      problems.join(" | "),
    );
    await context.close();
  } finally {
    await browser.close();
  }
}

/** Container: private surfaces require a session (no pre-auth chat). */
export async function chatDisabledChecks(base: string): Promise<void> {
  const page = await fetch(`${base}/chat`, { redirect: "manual" });
  await page.arrayBuffer();
  const api = await fetch(`${base}/api/conversations`);
  await api.arrayBuffer();
  check(
    "container: /chat redirects to sign-in and the API requires a session",
    page.status === 302 &&
      (page.headers.get("location") ?? "").startsWith("/login") &&
      api.status === 401,
    `${String(page.status)} ${String(api.status)}`,
  );
}

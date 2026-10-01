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
  // `/` sends signed-out visitors to sign-in; the status page lives at /status.
  const root = await fetch(`${base}/`, { redirect: "manual" });
  check(
    "/ redirects a signed-out visitor to /login",
    [302, 303].includes(root.status) && (root.headers.get("location") ?? "").startsWith("/login"),
    `${String(root.status)} ${root.headers.get("location") ?? ""}`,
  );
  const doc = await fetch(`${base}/status`);
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
  const second = nonceOf((await fetch(`${base}/status`)).headers.get("content-security-policy"));
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
  // Unmatched document routes live inside the guarded shell: signed out they
  // redirect to sign-in (the signed-in HTML 404 is checked in the chat demo).
  const pageMissing = await fetch(`${base}/no/such/page`, { redirect: "manual" });
  await pageMissing.arrayBuffer();
  check(
    "INV-57: unknown document route redirects signed-out visitors to sign-in",
    pageMissing.status === 302 &&
      pageMissing.headers.get("location") === "/login?returnTo=%2Fno%2Fsuch%2Fpage",
    `${String(pageMissing.status)} ${pageMissing.headers.get("location") ?? ""}`,
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
    await staticPage.goto(`${base}/status`);
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
    await page.goto(`${base}/status`);
    await page.waitForSelector('html[data-hydrated="true"]', { timeout: 10_000 });
    check("hydration completes", true);
    check(
      "hydrated page becomes interactive",
      (await page.getByTestId("hydration-state").textContent()) === "Interactive" &&
        (await page.getByRole("button", { name: "Check status again" }).isEnabled()),
    );
    const healthResponse = page.waitForResponse((r) => r.url().endsWith("/api/health"));
    await page.getByRole("button", { name: "Check status again" }).click();
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
    providerId: "local",
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
  const res = await fetch(`${base}/chat/new`, { headers: sessionHeaders(session) });
  const html = await res.text();
  check(
    "INV-54: /chat server HTML contains the native textarea",
    res.status === 200 && /<textarea[^>]*id="message"/.test(html),
  );
  check(
    "/chat server HTML shows the chosen model and carries the discovered list",
    /<button[^>]*aria-label="Model: [^"]+"/.test(html) && html.includes(models.chat),
  );
  check(
    "/chat Send is disabled until hydration (no fake no-JS send)",
    /<button(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>/.test(html),
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

  await reconnectCheck(base, session, models.slow);

  const browser = await chromium.launch();
  try {
    const [cookieName, cookieValue] = session.cookie.split("=");
    const cookie = { name: cookieName ?? "", value: cookieValue ?? "", url: base };
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    await noJs.addCookies([cookie]);
    const staticPage = await noJs.newPage();
    await staticPage.goto(`${base}/chat/${sent.conversationId}`);
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
    // Chromium reports the 404 document's own intended status as a console error.
    const missingUrl = `${base}/no/such/page`;
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.location().url === missingUrl && msg.text().includes("404")) return;
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
    await page.waitForURL(/\/chat\/new$/);
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
    await page.goto(`${base}/chat/new`, { waitUntil: "domcontentloaded" });
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
    check("the URL identifies the new conversation", /\/chat\/[0-9a-f-]{36}$/.test(page.url()));
    check(
      "the conversation is listed with its auto-title",
      (await page.getByTestId("conversation-list").textContent())?.includes(
        "typed before hydration",
      ) === true,
    );

    // Reload mid-generation: it keeps running and is re-observed.
    await page.getByRole("button", { name: /^Model: / }).click();
    await page.locator(`[data-model='${JSON.stringify(["local", models.slow])}']`).click();
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
    await page.getByRole("button", { name: /^Model: / }).click();
    await page.locator(`[data-model='${JSON.stringify(["local", models.slow])}']`).click();
    await page.locator("#message").fill("cancel me");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("content").filter({ hasText: "part1" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop generating" }).click();
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: "Stopped" })
      .waitFor({ timeout: 10_000 });
    check("Stop cancels and stores a cancelled reply", true);

    // Rename and delete through the sidebar menu and dialogs (Radix).
    const current = page.getByTestId("conversation-list").locator("li.current");
    await current.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.locator("#rename-title").fill("Renamed in verify");
    await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    await page
      .getByTestId("conversation-list")
      .filter({ hasText: "Renamed in verify" })
      .waitFor({ timeout: 5_000 });
    check("rename updates the title", true);
    await current.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/\/chat\/new$/);
    await page
      .getByTestId("conversation-list")
      .filter({ hasNotText: "Renamed in verify" })
      .waitFor({ timeout: 5_000 });
    check("delete removes the conversation", true);
    // Signed in, an unmatched document route is the framework's HTML 404.
    const notFound = await page.goto(missingUrl);
    await page.waitForSelector('html[data-hydrated="true"]', { timeout: 10_000 });
    check(
      "INV-57: unknown document route is an HTML 404 rendered by the framework",
      notFound?.status() === 404 &&
        (await page.getByRole("heading", { name: "Page not found" }).isVisible()),
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
  const page = await fetch(`${base}/chat/new`, { redirect: "manual" });
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

/**
 * Phase 6 acceptance: disconnect mid-stream, reconnect with Last-Event-ID,
 * receive exactly the missed events, and find exactly one canonical reply.
 */
async function reconnectCheck(base: string, session: ApiSession, model: string): Promise<void> {
  const start = await fetch(`${base}/api/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders(session, true) },
    body: sendPayload(model, "reconnect me"),
  });
  const started = (await start.json()) as {
    conversationId: string;
    generationId: string;
    assistantMessageId: string;
  };
  const url = `${base}/api/generations/${started.generationId}/stream`;
  const controller = new AbortController();
  const first = await fetch(url, { headers: sessionHeaders(session), signal: controller.signal });
  const reader = first.body?.getReader();
  let text = "";
  const decoder = new TextDecoder();
  while (reader && (text.match(/event: delta/g) ?? []).length < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  const lastId = Math.max(...ids);
  const resumed = await fetch(url, {
    headers: { ...sessionHeaders(session), "Last-Event-ID": String(lastId) },
  });
  const rest = await resumed.text();
  const restIds = [...rest.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  const deltas = (chunk: string) =>
    [...chunk.matchAll(/^event: delta\ndata: (.*)$/gm)]
      .map((m) => (JSON.parse(m[1] ?? "{}") as { content?: string }).content ?? "")
      .join("");
  const snapshot =
    (JSON.parse(/^event: snapshot\ndata: (.*)$/m.exec(text)?.[1] ?? "{}") as { content?: string })
      .content ?? "";
  const conversation = (await (
    await fetch(`${base}/api/conversations/${started.conversationId}`, {
      headers: sessionHeaders(session),
    })
  ).json()) as { messages: { id: string; role: string; content: string }[] };
  const replies = conversation.messages.filter((m) => m.id === started.assistantMessageId);
  check(
    "INV-20: reconnect with Last-Event-ID replays exactly the missed events",
    restIds[0] === lastId + 1 &&
      !rest.includes("event: snapshot") &&
      !rest.includes("event: resync") &&
      rest.includes("event: terminal"),
  );
  check(
    "INV-07: no duplicate canonical assistant write after a reconnect; streamed text equals the stored reply",
    replies.length === 1 && replies[0]?.content === snapshot + deltas(text) + deltas(rest),
  );
}

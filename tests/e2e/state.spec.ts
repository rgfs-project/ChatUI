import { expect, test, type Page, type Route } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_PASSWORD, E2E_USER, LONG_CONVERSATION, LONG_TITLE } from "./global-setup.ts";

/** Phase 8: loading, request lifecycle and session continuity in a real browser. */

const base = () => process.env.E2E_BASE_URL ?? "";
const CHAT = JSON.stringify(["local", "mock-chat"]);
const SLOW = JSON.stringify(["local", "mock-slow"]);
const hydrated = (page: Page) => page.waitForSelector('html[data-hydrated="true"]');

test.use({
  storageState: async ({ browser }, use) => {
    await use(await signedInState(browser));
  },
});

/** CSRF headers for API setup calls made with the page's own cookie. */
async function apiHeaders(page: Page) {
  const session = (await (await page.request.get(`${base()}/api/auth/session`)).json()) as {
    csrfToken: string;
    user: { id: string };
  };
  return { "X-CSRF-Token": session.csrfToken, "X-Expected-User": session.user.id };
}

test("slow network cold load: composer usable while the conversation list is held open", async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 300,
    downloadThroughput: (256 * 1024) / 8,
    uploadThroughput: (128 * 1024) / 8,
  });
  // Hold the secondary list until the test releases it.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let listRequested = 0;
  await page.route("**/api/conversations", async (route: Route) => {
    listRequested = Date.now();
    await held;
    await route.continue();
  });

  const t0 = Date.now();
  await page.goto(`${base()}/chat/${LONG_CONVERSATION}`, { waitUntil: "domcontentloaded" });
  // Server HTML already carries the authorized transcript and a native composer.
  await expect(page.getByRole("heading", { name: LONG_TITLE })).toBeAttached();
  await page.locator("#message").fill("typed on a slow network");
  await hydrated(page);
  const tHydrated = Date.now() - t0;
  await page.locator("#model").selectOption(CHAT);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  const tUsable = Date.now() - t0;
  // Still waiting on the secondary list…
  await expect(page.getByTestId("conversations-loading")).toBeVisible();
  expect(listRequested).toBeGreaterThan(0);
  // …and the composer works end to end.
  await expect(page.locator("#message")).toHaveValue("typed on a slow network");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "Echo: typed on a slow network",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("conversations-loading")).toBeVisible();
  const tReleased = Date.now() - t0;
  release();
  await expect(page.getByTestId("conversation-list")).toContainText(LONG_TITLE);
  console.log(
    `slow cold load: hydrated ${String(tHydrated)} ms, composer usable ${String(tUsable)} ms, ` +
      `reply stored and list still pending at ${String(tReleased)} ms`,
  );
});

test("hard reloads of /chat/:id, /settings and /admin: no /api request is answered with HTML", async ({
  page,
}) => {
  const apiResponses: { url: string; type: string }[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/"))
      apiResponses.push({ url: response.url(), type: response.headers()["content-type"] ?? "" });
  });
  for (const path of [`/chat/${LONG_CONVERSATION}`, "/settings", "/admin"]) {
    await page.goto(`${base()}${path}`);
    await page.reload();
    await hydrated(page);
    await page.waitForLoadState("networkidle");
  }
  expect(apiResponses.length).toBeGreaterThan(0);
  for (const r of apiResponses) expect(r.type, r.url).not.toContain("text/html");
  const unknown = await page.request.get(`${base()}/api/does-not-exist`);
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()["content-type"]).toContain("application/json");
});

test("rapid conversation switching lands on the last one and never shows stale content", async ({
  page,
}) => {
  await page.goto(`${base()}/chat/new`);
  const headers = await apiHeaders(page);
  const titles = ["Switch A", "Switch B", "Switch C"];
  const ids: string[] = [];
  for (const title of titles) {
    const res = await page.request.post(`${base()}/api/conversations`, {
      data: { title },
      headers,
    });
    ids.push(((await res.json()) as { id: string }).id);
  }
  // Random latency on route data so responses come back out of order.
  await page.route(/\.data(\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 400));
    await route.continue();
  });
  await page.reload();
  await hydrated(page);
  const list = page.getByTestId("conversation-list");
  await expect(list).toContainText("Switch C");
  for (const title of ["Switch A", "Switch B", "Switch C", "Switch A", "Switch B", "Switch C"])
    await list.getByRole("link", { name: title }).click({ noWaitAfter: true });
  await expect(page).toHaveURL(new RegExp(`/chat/${ids[2] ?? ""}$`));
  await expect(page.getByRole("heading", { name: "Switch C" })).toBeVisible();
  // Nothing late overwrites the final view.
  await page.waitForTimeout(800);
  await expect(page.getByRole("heading", { name: "Switch C" })).toBeVisible();
  await expect(list.locator('[aria-current="page"]')).toHaveText("Switch C");
});

test("rapid model switching: the send carries the last selection", async ({ page }) => {
  await page.goto(`${base()}/chat/new`);
  await hydrated(page);
  const select = page.locator("#model");
  for (const choice of [SLOW, CHAT, SLOW, CHAT, SLOW, CHAT]) await select.selectOption(choice);
  const sent = page.waitForRequest(
    (r) => r.url().endsWith("/api/generations") && r.method() === "POST",
  );
  await page.locator("#message").fill("which model answers?");
  await page.getByRole("button", { name: "Send" }).click();
  expect(((await sent).postDataJSON() as { model: string }).model).toBe("mock-chat");
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "Echo: which model answers?",
  );
});

test("session expiry mid-use: in-app re-authentication restores the draft; a reload discards it", async ({
  browser,
}) => {
  // Its own session: this test revokes it.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const signIn = async () => {
    await page.locator("#username").fill(E2E_USER);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
  };
  await page.goto(`${base()}/login?returnTo=%2Fchat%2Fnew`);
  await hydrated(page);
  await signIn();
  await page.waitForURL(/\/chat\/new$/);
  await hydrated(page);
  await page.locator("#model").selectOption(CHAT);
  await page.locator("#message").fill("draft kept across re-auth");
  // A marker that a document navigation would lose.
  await page.evaluate(() => {
    (window as unknown as { marker: number }).marker = 1;
  });

  // The session ends server-side.
  const headers = await apiHeaders(page);
  await page.request.post(`${base()}/api/auth/logout`, { headers });

  await page.getByRole("button", { name: "Send" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in again" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/new$/);
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
  await expect(page.locator("#message")).toHaveCount(0); // private content hidden
  await dialog.getByLabel("Password").fill(E2E_PASSWORD);
  await dialog.getByRole("button", { name: "Sign in" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#message")).toHaveValue("draft kept across re-auth");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "Echo: draft kept across re-auth",
  );

  // Expire again with a fresh draft, then reload: the draft is gone.
  await page.locator("#message").fill("draft lost on reload");
  await page.request.post(`${base()}/api/auth/logout`, { headers: await apiHeaders(page) });
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("dialog", { name: "Sign in again" })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await hydrated(page);
  await signIn();
  await hydrated(page);
  await expect(page.locator("#message")).toHaveValue("");
  // Never in browser storage (React Router's scroll positions are its own).
  const stored = await page.evaluate(() =>
    [localStorage, sessionStorage].flatMap((store) =>
      Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ""}`),
    ),
  );
  expect(stored.join("\n")).not.toContain("draft");
  expect(stored.join("\n")).not.toContain("re-auth");
  await context.close();
});

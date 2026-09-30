import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_ADMIN, E2E_OTHER_USER, LONG_CONVERSATION, OLDER_NEEDLE } from "./global-setup.ts";

/**
 * Phase 17: SSR and hydration reliability (INV-54–INV-57) against the
 * production server: private markup only for the authorized account, even
 * under parallel requests; correct statuses; nonce'd scripts; no duplicated
 * initial fetches after hydration.
 */

const base = () => process.env.E2E_BASE_URL ?? "";

async function contextFor(browser: Browser, username?: string, javaScriptEnabled = true) {
  return browser.newContext({
    javaScriptEnabled,
    storageState: username ? await signedInState(browser, username) : { cookies: [], origins: [] },
  });
}

async function html(request: APIRequestContext, url: string) {
  const res = await request.get(`${base()}${url}`, { maxRedirects: 0 });
  return { status: res.status(), headers: res.headers(), body: await res.text() };
}

test("A/B isolation: parallel document requests never carry the other account's content", async ({
  browser,
}) => {
  const a = await contextFor(browser, undefined);
  const aState = await signedInState(browser);
  const alice = await browser.newContext({ storageState: aState });
  const bob = await contextFor(browser, E2E_OTHER_USER);
  // Bob's private conversation with a unique sentinel.
  const sentinel = `SENTINEL-B-${String(Date.now())}`;
  const page = await bob.newPage();
  await page.goto(`${base()}/chat/new`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.locator("#model").selectOption(JSON.stringify(["local", "mock-chat"]));
  await page.locator("#message").fill(sentinel);
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  const bobChat = new URL(page.url()).pathname;
  await expect(page.getByTestId("message-assistant").last()).toBeVisible();

  const requests = Array.from({ length: 24 }, (_, i) =>
    i % 2 === 0
      ? html(alice.request, `/chat/${LONG_CONVERSATION}`).then((r) => ({ who: "alice", ...r }))
      : html(bob.request, bobChat).then((r) => ({ who: "bob", ...r })),
  );
  for (const r of await Promise.all(requests)) {
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    if (r.who === "alice") {
      expect(r.body).toContain(OLDER_NEEDLE);
      expect(r.body).not.toContain(sentinel);
      expect(r.body).not.toContain(E2E_OTHER_USER);
    } else {
      expect(r.body).toContain(sentinel);
      expect(r.body).not.toContain(OLDER_NEEDLE);
    }
  }
  // Foreign and anonymous requests get no private markup or data.
  const foreign = await html(alice.request, bobChat);
  expect(foreign.status).toBe(404);
  expect(foreign.body).not.toContain(sentinel);
  const anonymous = await html(a.request, bobChat);
  expect([302, 303]).toContain(anonymous.status);
  expect(anonymous.headers.location).toMatch(/^\/login\?returnTo=/);
  expect(anonymous.body).not.toContain(sentinel);
  await Promise.all([a.close(), alice.close(), bob.close()]);
});

test("statuses: unknown route 404, missing conversation 404 with the shell, admin 404 for users", async ({
  browser,
}) => {
  const alice = await contextFor(browser, undefined);
  await alice.close();
  const ctx = await browser.newContext({ storageState: await signedInState(browser) });
  // `/` goes straight into the app when signed in; the status page is /status.
  const root = await html(ctx.request, "/");
  expect([302, 303]).toContain(root.status);
  expect(root.headers.location).toBe("/chat/new");
  expect((await html(ctx.request, "/status")).status).toBe(200);
  const unknown = await html(ctx.request, "/no/such/page");
  expect(unknown.status).toBe(404);
  const missing = await html(ctx.request, "/chat/00000000-0000-4000-8000-000000000000");
  expect(missing.status).toBe(404);
  // A data error inside the shell, not the route 404.
  expect(missing.body).toContain('data-testid="app-shell"');
  expect(missing.body).toContain('data-testid="missing-state"');
  expect(unknown.body).not.toContain('data-testid="missing-state"');
  const admin = await html(ctx.request, "/admin");
  expect(admin.status).toBe(404);
  const api = await ctx.request.get(`${base()}/api/nope`);
  expect(api.status()).toBe(404);
  expect(api.headers()["content-type"]).toMatch(/^application\/json/);
  const asset = await ctx.request.get(`${base()}/assets/missing-deadbeef.js`);
  expect(asset.status()).toBe(404);
  expect(asset.headers()["content-type"] ?? "").not.toMatch(/text\/html/);
  await ctx.close();
});

test("without JavaScript: Settings and Admin fall back to the shell for their owners; every script carries the nonce", async ({
  browser,
}) => {
  const user = await contextFor(browser, undefined, false);
  await user.close();
  const noJs = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await signedInState(browser),
  });
  const page = await noJs.newPage();
  // The Settings overlay is a portal mounted after hydration; without JS the
  // direct link serves its fallback: the shell with a usable textarea.
  const settings = await page.goto(`${base()}/settings`);
  expect(settings?.status()).toBe(200);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("#message")).toBeVisible();
  const adminCtx = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await signedInState(browser, E2E_ADMIN),
  });
  const adminPage = await adminCtx.newPage();
  const response = await adminPage.goto(`${base()}/admin`);
  expect(response?.status()).toBe(200);
  // Also an overlay: the admin gets 200 and the shell (a user gets 404, above).
  await expect(adminPage.getByTestId("app-shell")).toBeVisible();

  const doc = await noJs.request.get(`${base()}/chat/${LONG_CONVERSATION}`);
  const csp = doc.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  const body = await doc.text();
  const scripts = [...body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const tag of scripts) expect(tag, tag).toContain(`nonce="${nonce ?? ""}"`);
  await Promise.all([noJs.close(), adminCtx.close()]);
});

test("hydration reuses the server data: no duplicate initial conversation or model fetch", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ storageState: await signedInState(browser) });
  const page = await ctx.newPage();
  const api: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/")) api.push(url.pathname);
  });
  await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.waitForLoadState("networkidle");
  expect(api.filter((p) => p === `/api/conversations/${LONG_CONVERSATION}`)).toEqual([]);
  expect(api.filter((p) => p === "/api/models")).toEqual([]);
  // The sidebar list is secondary: fetched once, after hydration.
  expect(api.filter((p) => p === "/api/conversations").length).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)),
  ).toBe(0);
  await ctx.close();
});

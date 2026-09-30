import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_USER, LONG_CONVERSATION } from "./global-setup.ts";

/** Phase 9: instrumentation, bundle boundaries and asset delivery in the production build. */

const base = () => process.env.E2E_BASE_URL ?? "";
const CHAT = JSON.stringify(["local", "mock-chat"]);
const SENTINEL = "PERF-PRIVATE-SENTINEL-41d9";

test.use({
  storageState: async ({ browser }, use) => {
    await use(await signedInState(browser));
  },
});

interface Entry {
  name: string;
  type: string;
  startTime: number;
  duration: number;
  detail: unknown;
}

function entries(page: Page): Promise<Entry[]> {
  return page.evaluate(() =>
    [...performance.getEntriesByType("mark"), ...performance.getEntriesByType("measure")]
      .filter((e) => e.name.startsWith("chatui:"))
      .map((e) => ({
        name: e.name,
        type: e.entryType,
        startTime: e.startTime,
        duration: e.duration,
        detail: (e as PerformanceMark).detail as unknown,
      })),
  );
}

const count = (list: Entry[], name: string) => list.filter((e) => e.name === name).length;

test("marks: emitted once in lifecycle order; ComposerTTI and FirstAssistantEvent computable; no private content", async ({
  page,
}) => {
  await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
  await expect.poll(async () => count(await entries(page), "chatui:composer-interactive")).toBe(1);
  await page.locator("#model").selectOption(CHAT);
  await page.locator("#message").fill(`measure me ${SENTINEL}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText(SENTINEL);
  await expect.poll(async () => count(await entries(page), "chatui:generation-complete")).toBe(1);

  const list = await entries(page);
  for (const name of [
    "chatui:navigation-start",
    "chatui:shell-painted",
    "chatui:hydration-complete",
    "chatui:composer-interactive",
    "chatui:conversation-visible",
    "chatui:generation-accepted",
    "chatui:stream-open",
    "chatui:first-assistant-event",
    "chatui:first-assistant-paint",
    "chatui:generation-complete",
    "chatui:ComposerTTI",
    "chatui:FirstAssistantEvent",
  ])
    expect(count(list, name), name).toBe(1);
  const at = (name: string) => list.find((e) => e.name === name)?.startTime ?? NaN;
  // Document lifecycle order.
  expect(at("chatui:navigation-start")).toBe(0);
  expect(at("chatui:shell-painted")).toBeLessThanOrEqual(at("chatui:hydration-complete"));
  expect(at("chatui:hydration-complete")).toBeLessThanOrEqual(at("chatui:composer-interactive"));
  // Send path order.
  expect(at("chatui:generation-accepted")).toBeLessThanOrEqual(at("chatui:stream-open"));
  expect(at("chatui:stream-open")).toBeLessThanOrEqual(at("chatui:first-assistant-event"));
  expect(at("chatui:first-assistant-event")).toBeLessThanOrEqual(
    at("chatui:first-assistant-paint"),
  );
  // Privacy: names and details only, and details are opaque ids.
  const serialized = JSON.stringify(list);
  expect(serialized).not.toContain(SENTINEL);
  expect(serialized).not.toContain(E2E_USER);
  for (const e of list)
    for (const value of Object.values((e.detail ?? {}) as Record<string, unknown>))
      expect(String(value)).toMatch(/^[0-9a-f-]{36}$/);
});

test("bundle boundaries: interaction-only chunks are absent from the initial load and fetched on intent", async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.push(new URL(r.url()).pathname);
  });
  // What the server tells the browser to preload for a cold chat load.
  const html = await (await page.request.get(`${base()}/chat/new`)).text();
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(
    (m) => m[1] ?? "",
  );
  expect(preloaded.length).toBeGreaterThan(3);
  await page.goto(`${base()}/chat/new`);
  await page.waitForSelector('html[data-hydrated="true"]');
  for (const lazy of [
    /\/Menus-/,
    /\/Dialogs-/,
    /\/ReauthDialog-/,
    /\/settings-/,
    // Phase 12: the composer tray and the image viewer load with the first use.
    /\/AttachmentTray-/,
    /\/ImageViewer-/,
  ])
    expect(
      preloaded.some((p) => lazy.test(p)),
      String(lazy),
    ).toBe(false);
  await page.waitForLoadState("networkidle");
  expect(scripts.some((p) => p.includes("/Dialogs-"))).toBe(false);
  expect(scripts.some((p) => p.includes("/settings-"))).toBe(false);
  expect(scripts.some((p) => p.includes("/ReauthDialog-"))).toBe(false);
  expect(scripts.some((p) => p.includes("/AttachmentTray-"))).toBe(false);
  expect(scripts.some((p) => p.includes("/ImageViewer-"))).toBe(false);

  // Opening the account menu prefetches the Settings route chunk before any click.
  await page.getByTestId("signed-in-user").click();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect.poll(() => scripts.some((p) => p.includes("/settings-"))).toBe(true);
  await page.keyboard.press("Escape");
  // Opening a conversation menu fetches the dialog chunk ahead of use.
  const trigger = page.getByTestId("conversation-list").getByRole("button").first();
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect.poll(() => scripts.some((p) => p.includes("/Dialogs-"))).toBe(true);
});

test("a failed route chunk load recovers: the page reloads into a working app and Settings opens on retry", async ({
  page,
}) => {
  await page.goto(`${base()}/chat/new`);
  await page.waitForSelector('html[data-hydrated="true"]');
  let failures = 0;
  await page.route(/\/assets\/settings-[\w-]+\.js$/, async (route) => {
    if (failures === 0) {
      failures++;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  const reloaded = page.waitForEvent("load");
  await page.getByTestId("signed-in-user").click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  // React Router reloads the document when a route module can't be loaded
  // (e.g. deploy skew); the reloaded page is a working app.
  await reloaded;
  await page.waitForSelector('html[data-hydrated="true"]');
  expect(failures).toBe(1);
  await page.getByTestId("signed-in-user").click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("assets: first-party only, hashed assets immutable and compressed, documents never cached", async ({
  page,
}) => {
  const origin = new URL(base()).origin;
  const foreign: string[] = [];
  const assets: { url: string; cache: string; encoding: string }[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    const type = response.request().resourceType();
    if (["script", "stylesheet", "font", "image"].includes(type) && url.origin !== origin)
      foreign.push(response.url());
    if (url.pathname.startsWith("/assets/") && /\.(js|css)$/.test(url.pathname))
      assets.push({
        url: url.pathname,
        cache: response.headers()["cache-control"] ?? "",
        encoding: response.headers()["content-encoding"] ?? "",
      });
  });
  const doc = await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.waitForLoadState("networkidle");
  expect(foreign).toEqual([]);
  expect(assets.length).toBeGreaterThan(3);
  for (const a of assets) {
    expect(a.cache, a.url).toContain("immutable");
    expect(a.cache, a.url).toContain("max-age=31536000");
  }
  expect(assets.filter((a) => a.encoding === "br").length).toBeGreaterThan(0);
  expect(doc?.headers()["cache-control"]).toMatch(/no-store/);
  expect(doc?.headers()["cache-control"]).not.toMatch(/immutable/);
  const sw = await page.evaluate(async () =>
    "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  );
  expect(sw).toBe(0);
});

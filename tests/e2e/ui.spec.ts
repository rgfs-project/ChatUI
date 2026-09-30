import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import {
  E2E_OTHER_USER,
  E2E_PASSWORD,
  E2E_USER,
  LONG_CONVERSATION,
  LONG_TITLE,
  OLDER_NEEDLE,
} from "./global-setup.ts";

/** Phase 7 UI: layout, scroll intent, overlays and INV-53 routing. */

const base = () => process.env.E2E_BASE_URL ?? "";
const LONG = JSON.stringify(["local", "mock-long"]);
const CHAT = JSON.stringify(["local", "mock-chat"]);
const PIN_THRESHOLD = 48;
const hydrated = (page: Page) => page.waitForSelector('html[data-hydrated="true"]');

/** Settings lives in the account menu at the bottom of the sidebar. */
async function openSettings(page: Page) {
  await page.getByTestId("signed-in-user").click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
}

async function openLong(page: Page) {
  await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: LONG_TITLE })).toBeVisible();
}

/** Geometry of the shell and the transcript's scroll state. */
function layout(page: Page) {
  return page.evaluate(() => {
    const t = document.querySelector<HTMLElement>('[data-testid="transcript"]');
    const header = document.querySelector(".app-header")?.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    if (!t || !header || !composer) throw new Error("shell not rendered");
    return {
      pageScrollable: document.scrollingElement
        ? document.scrollingElement.scrollHeight > window.innerHeight + 1
        : false,
      windowScrollY: window.scrollY,
      headerTop: header.top,
      composerBottom: composer.bottom,
      viewport: window.innerHeight,
      scrollTop: t.scrollTop,
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      distance: t.scrollHeight - t.scrollTop - t.clientHeight,
    };
  });
}

test.describe.configure({ mode: "serial" });

test.use({
  storageState: async ({ browser }, use) => {
    await use(await signedInState(browser));
  },
});

test("200 messages: the transcript scrolls independently of the fixed shell", async ({ page }) => {
  await openLong(page);
  expect(await page.getByTestId("message-user").count()).toBe(100);
  const start = await layout(page);
  expect(start.pageScrollable).toBe(false);
  expect(start.scrollHeight).toBeGreaterThan(start.clientHeight * 3);
  expect(start.distance).toBeLessThanOrEqual(PIN_THRESHOLD); // opens at the latest message
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -2_000);
  await expect.poll(async () => (await layout(page)).scrollTop).toBeLessThan(start.scrollTop);
  const after = await layout(page);
  expect(after.windowScrollY).toBe(0);
  expect(after.headerTop).toBe(start.headerTop);
  expect(after.composerBottom).toBe(start.composerBottom);
  expect(after.composerBottom).toBeLessThanOrEqual(after.viewport);
});

test("find-in-page reaches an older rendered message (no virtualization)", async ({ page }) => {
  await openLong(page);
  const found = await page.evaluate((needle) => {
    // Chromium's find-in-page API searches the rendered text, like Ctrl+F.
    const find = (window as unknown as { find: (s: string) => boolean }).find;
    const hit = find(needle);
    const anchor = window.getSelection()?.anchorNode?.parentElement;
    anchor?.scrollIntoView({ block: "center" });
    return { hit, inMessage: anchor?.closest('[data-testid="message-assistant"]') !== null };
  }, OLDER_NEEDLE);
  expect(found).toEqual({ hit: true, inMessage: true });
  await expect(page.getByText(OLDER_NEEDLE)).toBeInViewport();
  // The pinned-bottom logic does not pull the viewport back.
  await page.waitForTimeout(300);
  await expect(page.getByText(OLDER_NEEDLE)).toBeInViewport();
});

test("streaming a long answer while pinned follows it without viewport jumps", async ({ page }) => {
  await openLong(page);
  const start = await layout(page);
  // Sample every frame in the page: the pinned transcript never lags a chunk.
  await page.evaluate(() => {
    const w = window as unknown as { samples: number[][]; sampling: boolean };
    w.samples = [];
    w.sampling = true;
    const t = document.querySelector<HTMLElement>('[data-testid="transcript"]');
    const header = document.querySelector(".app-header");
    // Measure after each frame is painted (rAF runs before layout and
    // ResizeObserver, so it would see pre-correction state).
    const sample = () => {
      if (!t || !header || !w.sampling) return;
      w.samples.push([
        t.scrollHeight - t.scrollTop - t.clientHeight,
        window.scrollY,
        header.getBoundingClientRect().top,
      ]);
      requestAnimationFrame(() => setTimeout(sample, 0));
    };
    requestAnimationFrame(() => setTimeout(sample, 0));
  });
  await page.locator("#model").selectOption(LONG);
  await page.locator("#message").fill("write something long");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("LONG-ANSWER-END", {
    timeout: 30_000,
  });
  const samples = await page.evaluate(() => {
    const w = window as unknown as { samples: number[][]; sampling: boolean };
    w.sampling = false;
    return w.samples;
  });
  expect(samples.length).toBeGreaterThan(30);
  for (const [distance, scrollY, headerTop] of samples) {
    expect(distance).toBeLessThanOrEqual(PIN_THRESHOLD);
    expect(scrollY).toBe(0);
    expect(headerTop).toBe(start.headerTop);
  }
  // Streaming Markdown rendered as structure, stored identically.
  const reply = page.getByTestId("message-assistant").last();
  await expect(reply.locator("pre code").first()).toContainText("const value1_0 = 0;");
  await expect(reply.locator("table").first()).toBeVisible();
});

test("scrolled up during streaming: the viewport stays put; jump to latest re-pins", async ({
  page,
}) => {
  await openLong(page);
  await page.locator("#model").selectOption(LONG);
  await page.locator("#message").fill("another long one");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByTestId("content").filter({ hasText: "Section 1" }).waitFor();
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -1_500);
  await expect.poll(async () => (await layout(page)).distance).toBeGreaterThan(1_000);
  const held = (await layout(page)).scrollTop;
  await page.getByTestId("content").filter({ hasText: "Section 4" }).waitFor();
  expect(Math.abs((await layout(page)).scrollTop - held)).toBeLessThanOrEqual(1);
  const jump = page.getByTestId("jump-to-latest");
  await expect(jump).toBeVisible();
  await jump.click();
  await expect.poll(async () => (await layout(page)).distance).toBeLessThanOrEqual(PIN_THRESHOLD);
  await expect(jump).toBeHidden();
  await expect(page.getByTestId("message-assistant").last()).toContainText("LONG-ANSWER-END", {
    timeout: 30_000,
  });
  expect((await layout(page)).distance).toBeLessThanOrEqual(PIN_THRESHOLD);
});

test("sidebar collapses and expands; the transcript takes the space", async ({ page }) => {
  await openLong(page);
  const toggle = page.getByRole("button", { name: "Hide sidebar" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const wide = await page.getByTestId("transcript").boundingBox();
  await toggle.click();
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeHidden();
  const show = page.getByRole("button", { name: "Show sidebar" });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  const wider = await page.getByTestId("transcript").boundingBox();
  expect(wider?.width ?? 0).toBeGreaterThan(wide?.width ?? 0);
  await show.click();
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible();
});

test("menus and dialogs render in a portal, unclipped and on top", async ({ page }) => {
  await openLong(page);
  const trigger = page.getByRole("button", { name: `Actions for ${LONG_TITLE}` });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const onTop = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      hitsMenu: hit !== null && el.contains(hit),
      portaled: !document.querySelector("#sidebar")?.contains(el),
    };
  });
  expect(onTop).toEqual({ inViewport: true, hitsMenu: true, portaled: true });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test.describe("INV-53 routing", () => {
  test("a deep link survives a hard reload", async ({ page }) => {
    await openLong(page);
    await page.reload();
    await hydrated(page);
    expect(new URL(page.url()).pathname).toBe(`/chat/${LONG_CONVERSATION}`);
    await expect(page.getByRole("heading", { name: LONG_TITLE })).toBeVisible();
    await expect(page.locator('#sidebar [aria-current="page"]')).toContainText(LONG_TITLE);
  });

  test("settings overlay: opens over the conversation; Back/Forward/Escape", async ({ page }) => {
    await openLong(page);
    await page.locator("#message").fill("draft kept under the overlay");
    await openSettings(page);
    await expect(page).toHaveURL(/\/settings$/);
    const overlay = page.getByRole("dialog", { name: "Settings" });
    await expect(overlay).toBeVisible();
    // The conversation stays behind it (inert).
    // Hidden from assistive tech and input while the overlay is open.
    await expect(page.locator('[data-testid="conversation"][inert] h1')).toHaveText(LONG_TITLE);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/chat/${LONG_CONVERSATION}$`));
    await expect(overlay).toBeHidden();
    await expect(page.locator("#message")).toHaveValue("draft kept under the overlay");
    await page.goForward();
    await expect(overlay).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/chat/${LONG_CONVERSATION}$`));
    await expect(overlay).toBeHidden();
  });

  test("a directly loaded overlay opens over the fallback and closes to it", async ({ page }) => {
    await page.goto(`${base()}/settings`);
    await hydrated(page);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page).toHaveURL(/\/chat\/new$/);
  });

  test("the first send replaces the draft URL; Back skips the empty draft", async ({ page }) => {
    await openLong(page);
    await page.getByRole("link", { name: "New chat" }).click();
    await expect(page).toHaveURL(/\/chat\/new$/);
    await page.locator("#model").selectOption(CHAT);
    await page.locator("#message").fill("hello routing");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("message-assistant").last()).toContainText("Echo: hello routing");
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/chat/${LONG_CONVERSATION}$`));
  });

  test("missing conversation id is a data error; an unmatched URL is a route 404", async ({
    page,
  }) => {
    const missing = await page.goto(`${base()}/chat/00000000-0000-4000-8000-000000000000`);
    expect(missing?.status()).toBe(404);
    await hydrated(page);
    await expect(page.getByTestId("missing-state")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible();
    const unmatched = await page.goto(`${base()}/chat/new/extra/segments`);
    expect(unmatched?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("an expired session returns to the same deep link after sign-in", async ({
    page,
    context,
  }) => {
    await openLong(page);
    await context.clearCookies();
    await page.getByRole("link", { name: "New chat" }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fchat%2Fnew$/);
    await context.clearCookies();
    await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=%2Fchat%2F${LONG_CONVERSATION}$`));
    await hydrated(page);
    await page.locator("#username").fill(E2E_USER);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${LONG_CONVERSATION}$`));
    await expect(page.getByRole("heading", { name: LONG_TITLE })).toBeVisible();
  });

  test("an account switch shows none of the previous account's data", async ({ browser }) => {
    // Its own session (test options would otherwise seed the shared one):
    // signing out must not revoke the session the other tests reuse.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${base()}/login?returnTo=${encodeURIComponent(`/chat/${LONG_CONVERSATION}`)}`);
    await hydrated(page);
    await page.locator("#username").fill(E2E_USER);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: LONG_TITLE })).toBeVisible();
    await openSettings(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await hydrated(page);
    await page.locator("#username").fill(E2E_OTHER_USER);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("signed-in-user")).toHaveText(E2E_OTHER_USER);
    await expect(page.getByTestId("conversation-list")).not.toContainText(LONG_TITLE);
    const other = await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
    expect(other?.status()).toBe(404);
    await expect(page.getByTestId("missing-state")).toBeVisible();
    await context.close();
  });
});

test.describe("composer", () => {
  const SLOW = JSON.stringify(["local", "mock-slow"]);

  test("a message sent while a reply streams is queued, then sent after it", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await page.locator("#model").selectOption(SLOW);
    await page.locator("#message").fill("first, slowly");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("content").filter({ hasText: "part2" }).waitFor();
    await page.locator("#message").fill("queued follow-up");
    await page.locator("#message").press("Enter");
    const queued = page.getByTestId("message-queued");
    await expect(queued).toContainText("queued follow-up");
    await expect(page.locator("#message")).toHaveValue("");
    // After the slow reply finishes, the queued message goes out by itself.
    await expect(queued).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId("message-user").last()).toContainText("queued follow-up");
    await expect(page.getByTestId("message-assistant")).toHaveCount(2, { timeout: 30_000 });
  });

  test('"/" opens the command list; Enter runs the highlighted command', async ({ page }) => {
    await openLong(page);
    await page.locator("#message").fill("");
    await page.locator("#message").pressSequentially("/sett");
    const list = page.getByRole("listbox", { name: "Commands" });
    await expect(list).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(1);
    await page.locator("#message").press("Enter");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

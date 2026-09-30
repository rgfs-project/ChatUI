import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { LONG_CONVERSATION, LONG_TITLE, WIDE_CONVERSATION, WIDE_TITLE } from "./global-setup.ts";

/**
 * Phase 15 (INV-47): the chosen primitives in a real browser. Keyboard-only
 * use, nested dialogs, route changes with a dialog open, no leaked portals or
 * global listeners, the accessibility tree a screen reader receives, reduced
 * motion, and measured dialog/keystroke latency.
 */

const base = () => process.env.E2E_BASE_URL ?? "";

test.use({
  storageState: async ({ browser }, use) => {
    await use(await signedInState(browser));
  },
});

async function open(page: Page, id: string) {
  await page.goto(`${base()}/chat/${id}`);
  await page.waitForSelector('html[data-hydrated="true"]');
}

/** Leftovers a closed Radix layer must not leave behind. */
async function layerLeftovers(page: Page) {
  return page.evaluate(() => ({
    hiddenSiblings: [...document.body.children].filter(
      (el) => el.getAttribute("aria-hidden") === "true",
    ).length,
    inertSiblings: [...document.body.children].filter((el) => el.hasAttribute("inert")).length,
    focusGuards: document.querySelectorAll("[data-radix-focus-guard]").length,
    scrollLocked: document.body.hasAttribute("data-scroll-locked"),
    pointerEvents: document.body.style.pointerEvents,
    portals: document.querySelectorAll("[data-radix-popper-content-wrapper], [role=dialog]").length,
  }));
}

const CLEAN = {
  hiddenSiblings: 0,
  inertSiblings: 0,
  focusGuards: 0,
  scrollLocked: false,
  pointerEvents: "",
  portals: 0,
};

test("INV-47: keyboard only: menu roving focus and typeahead, dialog trap, focus returns", async ({
  page,
}) => {
  await open(page, LONG_CONVERSATION);
  const trigger = page.getByRole("button", { name: `Actions for ${LONG_TITLE}` });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  // Screen-reader smoke: the menu's accessibility tree.
  await expect(menu).toMatchAriaSnapshot(`
    - menu "Actions for ${LONG_TITLE}":
      - menuitem "Rename"
      - menuitem /Pin|Unpin/
      - menuitem "Delete"
  `);
  // Typeahead jumps to "Rename" by its first letter.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("r");
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /Rename/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toBeFocused();
  // Tab cycles inside the dialog.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await layerLeftovers(page)).toEqual(CLEAN);
});

test("INV-47: nested dialogs: Escape closes the inner one first; focus returns at each level", async ({
  page,
}) => {
  await open(page, LONG_CONVERSATION);
  const account = page.getByTestId("signed-in-user");
  await account.click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  const deleteAll = settings.getByRole("button", { name: "Delete all" });
  await deleteAll.click();
  const confirm = page.getByRole("dialog", { name: "Delete all chats?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toMatchAriaSnapshot(`
    - dialog "Delete all chats?":
      - heading "Delete all chats?"
      - paragraph
      - button "Cancel"
      - button "Delete all"
  `);
  // The Settings dialog is hidden from assistive technology meanwhile.
  await expect(settings).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(deleteAll).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/chat/${LONG_CONVERSATION}$`));
  // Back to the account menu's trigger (the menu item that opened Settings is gone).
  await expect(page.locator("button.account-trigger")).toBeFocused();

  // Search, opened from its button, returns focus there too.
  const searchButton = page.getByRole("button", { name: "Search chats" });
  await searchButton.click();
  await expect(page.getByTestId("search-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(searchButton).toBeFocused();
  expect(await layerLeftovers(page)).toEqual(CLEAN);
});

test("INV-47: a route change with a dialog open leaves no inert, hidden or locked page", async ({
  page,
}) => {
  await open(page, WIDE_CONVERSATION);
  await open(page, LONG_CONVERSATION);
  await page.getByRole("button", { name: `Actions for ${LONG_TITLE}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByRole("dialog", { name: /Rename/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: WIDE_TITLE })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await layerLeftovers(page)).toEqual(CLEAN);
  // The page is fully usable: the composer takes typing.
  await page.locator("#message").fill("still usable");
  await expect(page.locator("#message")).toHaveValue("still usable");
});

test("INV-47: repeated opening leaks no portals or global listeners", async ({ page }) => {
  await open(page, LONG_CONVERSATION);
  const cdp = await page.context().newCDPSession(page);
  const listeners = async () => {
    const { result } = await cdp.send("Runtime.evaluate", { expression: "window" });
    const onWindow = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: result.objectId ?? "",
    });
    const { result: doc } = await cdp.send("Runtime.evaluate", { expression: "document" });
    const onDocument = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: doc.objectId ?? "",
    });
    return onWindow.listeners.length + onDocument.listeners.length;
  };
  const cycle = async () => {
    await page.getByRole("button", { name: `Actions for ${LONG_TITLE}` }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByTestId("signed-in-user").click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  };
  await cycle(); // Loads the lazy chunks once.
  const before = {
    listeners: await listeners(),
    children: await page.evaluate(() => document.body.childElementCount),
  };
  for (let i = 0; i < 5; i++) await cycle();
  expect(await listeners()).toBe(before.listeners);
  expect(await page.evaluate(() => document.body.childElementCount)).toBe(before.children);
  expect(await layerLeftovers(page)).toEqual(CLEAN);
});

test("INV-47: reduced motion: opening menus and dialogs runs no animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, LONG_CONVERSATION);
  await page.getByRole("button", { name: `Actions for ${LONG_TITLE}` }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("measured: dialog open and keystroke latency (recorded, not asserted)", async ({ page }) => {
  await open(page, LONG_CONVERSATION);
  await page.evaluate(() => {
    const w = window as unknown as { __events?: { name: string; duration: number }[] };
    w.__events = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__events?.push({ name: e.name, duration: e.duration });
    }).observe({
      type: "event",
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit);
  });
  // Warm the lazy chunks, then measure a warm open.
  await page.getByRole("button", { name: `Actions for ${LONG_TITLE}` }).click();
  await page.keyboard.press("Escape");
  const opened = await page.evaluate(async (title) => {
    const trigger = document.querySelector<HTMLButtonElement>(
      `[aria-label="Actions for ${title}"]`,
    );
    const start = performance.now();
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    await new Promise<void>((resolve) => {
      const check = () => {
        if (document.querySelector("[role=menu]")) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
    return performance.now() - start;
  }, LONG_TITLE);
  await page.keyboard.press("Escape");
  await page.locator("#message").click();
  await page.keyboard.type("measuring keystroke latency in the native composer", { delay: 15 });
  const slow = await page.evaluate(
    () => (window as unknown as { __events?: { name: string; duration: number }[] }).__events ?? [],
  );
  const keys = slow
    .filter((e) => e.name.startsWith("key") || e.name === "input")
    .map((e) => e.duration)
    .sort((x, y) => x - y);
  const at = (q: number) =>
    Math.round(keys[Math.min(keys.length - 1, Math.floor(q * keys.length))] ?? 0);
  // Event Timing durations run to the next paint (8 ms granularity); INP "good" is < 200 ms.
  test.info().annotations.push({
    type: "latency",
    description: `menu open ${String(Math.round(opened))} ms; key/input events ≥ 16 ms: ${String(keys.length)}, p50 ${String(at(0.5))} ms, p95 ${String(at(0.95))} ms, max ${String(at(1))} ms`,
  });
  await expect(page.locator("#message")).toHaveValue(
    "measuring keystroke latency in the native composer",
  );
});

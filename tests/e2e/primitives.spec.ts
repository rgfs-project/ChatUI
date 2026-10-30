import { expect, test, type Page } from "@playwright/test";
import { E2E_AUTH_STATE } from "./global-setup.ts";
import { base, hydrated, longChat, signIn } from "./helpers.ts";

/** Phase 15 audit (INV-47): behaviour every overlay must share. */

/** Leftovers a closed modal must not leave behind. */
async function noModalResidue(page: Page) {
  const residue = await page.evaluate(() => ({
    pointerEvents: document.body.style.pointerEvents,
    hidden: Array.from(document.body.children)
      .filter((el) => el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert"))
      .map((el) => el.tagName + (el.id ? `#${el.id}` : "")),
    poppers: document.querySelectorAll("[data-radix-popper-content-wrapper]").length,
    dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length,
    scrollLock: document.body.hasAttribute("data-scroll-locked"),
  }));
  expect(residue).toEqual({
    pointerEvents: "",
    hidden: [],
    poppers: 0,
    dialogs: 0,
    scrollLock: false,
  });
}

test("a modal hides the page from assistive technology, locks scroll, and cleans up", async ({
  page,
}) => {
  await signIn(page, `/chat/${longChat()}`);
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename chat" });
  await expect(dialog).toBeVisible();
  const outside = await page.evaluate(() => {
    const shell = document.querySelector(".chat-area");
    return {
      hidden: shell?.closest('[aria-hidden="true"]') !== null,
      locked: document.body.hasAttribute("data-scroll-locked"),
    };
  });
  expect(outside).toEqual({ hidden: true, locked: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await noModalResidue(page);
});

test("nested: a confirmation over Settings closes alone and returns focus inside Settings", async ({
  page,
}) => {
  await signIn(page, "/settings/data");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  const opener = settings.getByRole("button", { name: "Delete all", exact: true });
  await opener.click();
  const confirm = page.getByRole("alertdialog", { name: "Delete all chats?" });
  await expect(confirm).toBeVisible();
  // The safe choice has focus; Tab stays inside the confirmation.
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await confirm.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(opener).toBeFocused();
  // The next Escape closes Settings itself.
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await noModalResidue(page);
});

test("route changes: Back closes a URL overlay cleanly; Forward reopens it", async ({ page }) => {
  await signIn(page, `/chat/${longChat()}`);
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await page.goBack();
  await expect(settings).toBeHidden();
  await noModalResidue(page);
  // Focus is back on the page, not lost to an unmounted node.
  expect(await page.evaluate(() => document.activeElement?.isConnected ?? false)).toBe(true);
  await page.goForward();
  await expect(settings).toBeVisible();
  // Navigating away from inside the overlay also leaves nothing behind.
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(settings).toBeHidden();
  await noModalResidue(page);
});

test("menus open and close without piling up portals or live regions", async ({ page }) => {
  await signIn(page, `/chat/${longChat()}`);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("composer-menu").click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Chat options" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Search chats" })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await noModalResidue(page);
  const regions = await page.evaluate(() => ({
    polite: document.querySelectorAll('.toast-region[role="status"]').length,
    assertive: document.querySelectorAll('.toast-region[role="alert"]').length,
  }));
  expect(regions).toEqual({ polite: 1, assertive: 1 });
});

test("keyboard only: a sidebar chat's menu opens, moves, closes and returns focus", async ({
  page,
}) => {
  await signIn(page, `/chat/${longChat()}`);
  const trigger = page
    .getByTestId("conversation-list")
    .getByRole("button", { name: /options/i })
    .first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  // Typeahead jumps to an item by its first letter.
  await page.keyboard.press("r");
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("reduced motion stops transitions and spinners", async ({ browser }) => {
  const context = await browser.newContext({
    storageState: E2E_AUTH_STATE,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${base()}/chat/new`);
  await hydrated(page);
  const durations = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "spin";
    document.body.append(probe);
    const button = document.querySelector(".icon-button");
    const result = {
      spinner: getComputedStyle(probe).animationDuration,
      button: button ? getComputedStyle(button).transitionDuration : null,
    };
    probe.remove();
    return result;
  });
  expect(durations.spinner).toBe("0s");
  expect(durations.button?.split(",").every((d) => d.trim() === "0s")).toBe(true);
  await context.close();
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });

  test("the model picker and chat menu stay inside the screen", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    for (const open of [
      () => page.getByTestId("composer-menu").tap(),
      () => page.getByRole("button", { name: "Chat options" }).tap(),
    ]) {
      await open();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
  });
});

test("keyboard only: search results, its type tabs and opening a result", async ({ page }) => {
  await signIn(page, `/chat/${longChat()}`);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search chats" });
  const input = dialog.getByRole("combobox", { name: "Search chats and files" });
  await expect(input).toBeFocused();
  await input.fill("message");
  const all = dialog.getByRole("tab", { name: "All" });
  await expect(all).toHaveAttribute("aria-selected", "true");
  // One tab stop for the tab list; the arrows move along it.
  await all.focus();
  await page.keyboard.press("ArrowRight");
  const chats = dialog.getByRole("tab", { name: "Chats" });
  await expect(chats).toBeFocused();
  await expect(chats).toHaveAttribute("aria-selected", "true");
  await expect(all).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("tab", { name: "Documents" })).toBeFocused();
  await input.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await noModalResidue(page);
});

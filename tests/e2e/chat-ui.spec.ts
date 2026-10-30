import { expect, test } from "@playwright/test";
import { LONG_CHAT_MESSAGES, LONG_CHAT_TITLE } from "./global-setup.ts";
import {
  base,
  chooseModel,
  hydrated,
  longChat,
  scrollState,
  send,
  signIn,
  storedReplies,
} from "./helpers.ts";

test.describe("transcript and scrolling", () => {
  test("a 200-message chat scrolls inside the transcript and opens at the latest message", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${base()}/chat/${longChat()}`);
    await hydrated(page);
    const doc = await page.evaluate(() => ({
      scroll: document.scrollingElement?.scrollHeight ?? 0,
      viewport: window.innerHeight,
    }));
    // The document never becomes the scroll container.
    expect(doc.scroll).toBeLessThanOrEqual(doc.viewport);
    const s = await scrollState(page);
    expect(s.max).toBeGreaterThan(2_000);
    expect(s.max - s.top).toBeLessThanOrEqual(2);
    await expect(page.getByTestId("message-user")).toHaveCount(LONG_CHAT_MESSAGES / 2 + 1);
  });

  test("find-in-page reaches an old message (no virtualization)", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    const found = await page.evaluate(() =>
      (window as unknown as { find: (s: string) => boolean }).find("needle-3"),
    );
    expect(found).toBe(true);
  });

  test("streaming follows while pinned, holds still when scrolled up, and offers jump to latest", async ({
    page,
  }) => {
    await signIn(page, `/chat/${longChat()}`);
    await chooseModel(page, "mock-long");
    await send(page, "a long answer please");
    await page.getByTestId("live-reply").waitFor();
    await page.waitForTimeout(600);
    // Pinned: the view follows the growing reply (a sample may land between a
    // token and the follow-up scroll, so allow a few lines).
    let s = await scrollState(page);
    expect(s.max - s.top).toBeLessThanOrEqual(160);
    // The user scrolls up: growth no longer moves the viewport.
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, -1_500);
    await page.waitForTimeout(300);
    const held = (await scrollState(page)).top;
    await page.waitForTimeout(1_200);
    s = await scrollState(page);
    expect(Math.abs(s.top - held)).toBeLessThanOrEqual(1);
    const jump = page.getByRole("button", { name: "Jump to latest" });
    await expect(jump).toBeVisible();
    await jump.click();
    s = await scrollState(page);
    expect(s.max - s.top).toBeLessThanOrEqual(160);
    await expect(storedReplies(page).last()).toContainText("Paragraph 39", { timeout: 30_000 });
    // Once streaming ends the pinned view rests exactly at the bottom.
    await expect
      .poll(async () => {
        const end = await scrollState(page);
        return end.max - end.top;
      })
      .toBeLessThanOrEqual(2);
    // Incomplete structures rendered as they streamed and are complete now.
    await expect(storedReplies(page).last().locator("table")).toHaveCount(10);
    await expect(storedReplies(page).last().locator(".code-block")).toHaveCount(10);
  });
});

test.describe("shell", () => {
  test("the sidebar collapse is remembered and rendered by the server", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(page.locator("nav.sidebar")).toBeHidden();
    const html = await (await page.request.get(`${base()}/chat/new`)).text();
    expect(html).toMatch(/class="app sidebar-collapsed/);
    await page.reload();
    await expect(page.locator("nav.sidebar")).toBeHidden();
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(page.locator("nav.sidebar")).toBeVisible();
  });

  test("menus render in a portal and are never clipped", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    await page.getByTestId("composer-menu").click();
    const menu = page.getByRole("menu", { name: "Composer options" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport).toBeTruthy();
    if (box && viewport) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
    const inPortal = await menu.evaluate((el) => !el.closest(".app"));
    expect(inPortal).toBe(true);
  });

  test("Ctrl+A selects only the conversation", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    await page.locator(".chat-header").click({ position: { x: 600, y: 20 } });
    await page.keyboard.press("Control+a");
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected).toContain("needle-0");
    expect(selected).not.toContain("Recents");
  });
});

test.describe("INV-47: menus and dialogs", () => {
  test("the model menu works from the keyboard and returns focus", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    const trigger = page.getByTestId("composer-menu");
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Composer options" });
    await expect(menu).toBeVisible();
    // Attaching files comes first (Phase 12), then the models.
    await expect(menu.getByRole("menuitem", { name: "Add photos and files" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio").nth(1)).toBeFocused();
    expect(await menu.ariaSnapshot()).toContain('menuitemradio "mock-chat"');
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("rename: the dialog traps focus, Escape closes it and focus returns", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    const options = page.getByRole("button", { name: "Chat options" });
    await options.click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename chat" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Chat title" })).toBeFocused();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(options).toBeFocused();
  });

  test("rename and delete with in-app confirmation", async ({ page }) => {
    await signIn(page);
    await chooseModel(page, "mock-chat");
    await send(page, "rename then delete me");
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(storedReplies(page).last()).toContainText("Echo:");
    await page.getByRole("button", { name: "Chat options" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const input = page.getByRole("textbox", { name: "Chat title" });
    await input.fill("Renamed by the test");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("conversation-list")).toContainText("Renamed by the test");
    await page.getByRole("button", { name: "Chat options" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete chat?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId("conversation-list")).toContainText("Renamed by the test");
    await page.getByRole("button", { name: "Chat options" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/\/chat\/new$/);
    await expect(page.getByTestId("conversation-list")).not.toContainText("Renamed by the test");
    await expect(page.getByTestId("conversation-list")).toContainText(LONG_CHAT_TITLE);
  });
});

test("Recents is a button that folds the chat list; the server remembers it", async ({ page }) => {
  await signIn(page);
  const recents = page.getByRole("button", { name: "Recents" });
  await expect(recents).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("conversation-list")).toBeVisible();
  await recents.click();
  await expect(recents).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("conversation-list")).toHaveCount(0);
  // Server-rendered folded: no list in the HTML before hydration.
  const html = await (await page.request.get(page.url())).text();
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('data-testid="conversation-list"');
  await page.reload();
  await expect(page.getByRole("button", { name: "Recents" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("button", { name: "Recents" }).click();
  await expect(page.getByTestId("conversation-list")).toBeVisible();
});

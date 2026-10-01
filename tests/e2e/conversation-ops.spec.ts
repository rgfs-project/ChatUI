import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_OTHER_USER, LONG_CONVERSATION, OLDER_NEEDLE } from "./global-setup.ts";
import { chooseModel } from "./model.ts";

/** Phase 13a: search, pins, edit/delete/regenerate and clear history in the browser. */

const base = () => process.env.E2E_BASE_URL ?? "";
const CHAT = JSON.stringify(["local", "mock-chat"]);
const SHOTS = path.resolve(import.meta.dirname, "../../docs/phase-reports/phase-13a");

async function hydrated(page: Page) {
  await page.waitForSelector('html[data-hydrated="true"]');
}

/** Sends from the composer and waits for the stored reply. */
async function sendMessage(page: Page, text: string, replies: number) {
  await chooseModel(page, CHAT);
  await page.locator("#message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant")).toHaveCount(replies, { timeout: 20_000 });
  await expect(page.getByTestId("message-assistant").last()).toContainText(`Echo: ${text}`);
}

test.describe("search (INV-36)", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser)).cookies);
  });

  test("finds an older message, opens the conversation at it and marks it", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    const trigger = page.getByRole("button", { name: "Search chats" });
    await trigger.click();
    const dialog = page.getByTestId("search-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Search chats" }).fill(OLDER_NEEDLE);
    const option = dialog.getByRole("option").first();
    await expect(option).toContainText(OLDER_NEEDLE);
    await expect(option).toHaveAttribute("aria-selected", "true");
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, "search.png") });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/chat/${LONG_CONVERSATION}#m-[0-9a-f-]{36}$`));
    const hit = page.locator(".turn.search-hit");
    await expect(hit).toContainText(OLDER_NEEDLE);
    await expect(hit).toBeInViewport();
  });

  test("Ctrl+K opens search; Escape closes it and focus returns", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await page.keyboard.press("Control+k");
    const dialog = page.getByTestId("search-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await dialog.getByRole("combobox").fill("zzzz-no-such-text");
    await expect(dialog.getByRole("status")).toHaveText("No matches.");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Search chats" })).toBeFocused();
  });
});

test.describe("conversation operations (INV-35)", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_OTHER_USER)).cookies);
  });

  test("pin from the row menu, survive a reload, unpin from the title menu", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await sendMessage(page, "pin me", 1);
    const title = await page.getByRole("heading", { level: 1 }).textContent();
    await page
      .getByRole("button", { name: `Actions for ${title ?? ""}` })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Pin" }).click();
    const pinned = page.getByTestId("pinned-list");
    await expect(pinned).toContainText(title ?? "");
    await page.reload();
    await hydrated(page);
    await expect(page.getByTestId("pinned-list")).toContainText(title ?? "");
    await page.locator(".chat-title .title-trigger").click();
    await page.getByRole("menuitem", { name: "Unpin" }).click();
    await expect(page.getByTestId("pinned-list")).toHaveCount(0);
  });

  test("edit and send replaces the reply; later turns are removed", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await sendMessage(page, "first", 1);
    await sendMessage(page, "second", 2);
    const firstTurn = page.getByTestId("message-user").first();
    await firstTurn.hover();
    await firstTurn.getByRole("button", { name: "Edit message" }).click();
    const editor = page.getByRole("form", { name: "Edit message" });
    await expect(editor.getByRole("textbox")).toBeFocused();
    mkdirSync(SHOTS, { recursive: true });
    await page.getByTestId("transcript").screenshot({ path: path.join(SHOTS, "edit.png") });
    await editor.getByRole("textbox").fill("first, edited");
    await editor.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("message-assistant")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId("message-assistant").last()).toContainText("Echo: first, edited");
    await expect(page.getByTestId("message-user")).toHaveCount(1);
    // Escape cancels an edit without changes.
    await page.getByTestId("message-user").first().hover();
    await page.getByRole("button", { name: "Edit message" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("form", { name: "Edit message" })).toHaveCount(0);
  });

  test("delete an exchange keeps later turns; regenerate asks first and replaces the reply", async ({
    page,
  }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await sendMessage(page, "alpha", 1);
    await sendMessage(page, "beta", 2);
    const firstTurn = page.getByTestId("message-user").first();
    await firstTurn.hover();
    await firstTurn.getByRole("button", { name: "Delete message and reply" }).click();
    const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(confirm).toContainText("Later replies may refer to it");
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("message-user")).toHaveCount(1);
    await expect(page.getByTestId("message-user").first()).toContainText("beta");
    const reply = page.getByTestId("message-assistant").last();
    await reply.hover();
    await reply.getByRole("button", { name: "Regenerate reply" }).click();
    const again = page.getByRole("dialog");
    await expect(again).toContainText("The current reply will be replaced.");
    await again.getByRole("button", { name: "Regenerate" }).click();
    await expect(page.getByTestId("message-assistant")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId("message-assistant").last()).toContainText("Echo: beta");
    await expect(page.getByTestId("message-user")).toHaveCount(1);
  });

  test("clear history deletes every chat of this account", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await sendMessage(page, "to be cleared", 1);
    await page.goto(`${base()}/settings`);
    await hydrated(page);
    await page.getByRole("button", { name: "Delete all" }).click();
    await page
      .getByRole("dialog", { name: "Delete all chats?" })
      .getByRole("button", { name: "Delete all" })
      .click();
    await expect(page.getByRole("status").filter({ hasText: /chats? deleted/ })).toBeVisible();
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await expect(page.getByTestId("conversations-empty")).toBeVisible();
  });
});

test.describe("operations on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_OTHER_USER)).cookies);
  });

  test("message actions are visible 44 px touch targets", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await sendMessage(page, "phone", 1);
    for (const name of ["Edit message", "Delete message and reply", "Regenerate reply"]) {
      const button = page.getByRole("button", { name }).last();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box && box.width >= 44 && box.height >= 44, name).toBe(true);
    }
  });
});

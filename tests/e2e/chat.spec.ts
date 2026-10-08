import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import {
  ATTACHMENTS_CONVERSATION,
  RICH_CONVERSATION,
  RICH_TITLE,
  WIDE_CONVERSATION,
} from "./global-setup.ts";
import { chooseModel } from "./model.ts";

const base = () => process.env.E2E_BASE_URL ?? "";
const CHAT = JSON.stringify(["local", "mock-chat"]);
const SLOW = JSON.stringify(["local", "mock-slow"]);

async function open(page: Page, path: string) {
  await page.goto(`${base()}${path}`);
  await page.waitForSelector('html[data-hydrated="true"]');
}

test.beforeEach(async ({ browser, context }) => {
  const state = await signedInState(browser);
  await context.addCookies(state.cookies);
});

test("a new chat: send, stream, title in the sidebar, then reply again", async ({ page }) => {
  await open(page, "/chat/new");
  await expect(page.getByRole("heading", { name: "How can I help?" })).toBeVisible();
  await chooseModel(page, CHAT);
  await page.locator("#message").fill("first e2e message");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "Echo: first e2e message",
  );
  await expect(page.getByTestId("conversation-list")).toContainText("first e2e message");
  await page.locator("#message").fill("second one");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("message-assistant").last()).toContainText("Echo: second one");
  await expect(page.getByTestId("message-user")).toHaveCount(2);
});

test("Stop ends a reply and marks it stopped", async ({ page }) => {
  await open(page, "/chat/new");
  await chooseModel(page, SLOW);
  await page.locator("#message").fill("stop me");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByTestId("content").filter({ hasText: "part1" }).waitFor();
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("Stopped");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("edit a message and regenerate a reply", async ({ page }) => {
  await open(page, "/chat/new");
  await chooseModel(page, CHAT);
  await page.locator("#message").fill("original text");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("Echo: original text");
  await page.getByTestId("message-user").hover();
  await page.getByRole("button", { name: "Edit message" }).click();
  await page.locator("#edit-message").fill("edited text");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("Echo: edited text");
  await expect(page.getByTestId("message-assistant")).toHaveCount(1);
  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("Echo: edited text");
  await expect(page.getByTestId("message-assistant")).toHaveCount(1);
});

test("rename, pin and delete from the sidebar", async ({ page }) => {
  await open(page, "/chat/new");
  await chooseModel(page, CHAT);
  await page.locator("#message").fill("to be renamed");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("Echo: to be renamed");
  const list = page.getByTestId("conversation-list");
  const current = list.locator("li.current");
  await current.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.locator("#rename-title").fill("Renamed in e2e");
  await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
  await expect(list).toContainText("Renamed in e2e");
  await current.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(list.getByRole("heading", { name: "Pinned" })).toBeVisible();
  await current.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await page.waitForURL(/\/chat\/new$/);
  await expect(list).not.toContainText("Renamed in e2e");
});

test("search finds a chat by its text", async ({ page }) => {
  await open(page, "/chat/new");
  await page.getByRole("button", { name: "Search chats" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Search chats" });
  await dialog.getByRole("searchbox").fill("Math and code");
  await dialog
    .getByRole("link", { name: new RegExp(RICH_TITLE) })
    .first()
    .click();
  await page.waitForURL(new RegExp(RICH_CONVERSATION));
});

test("replies render math and highlighted code; raw HTML stays text", async ({ page }) => {
  await open(page, `/chat/${RICH_CONVERSATION}`);
  const reply = page.getByTestId("message-assistant").first();
  await expect(reply.locator("math").first()).toBeVisible();
  await expect(reply.locator(".code-block").first()).toBeVisible();
  await expect(reply.locator(".math-error")).toHaveCount(1);
});

test("wide content scrolls inside the reply, not the page", async ({ page }) => {
  await open(page, `/chat/${WIDE_CONVERSATION}`);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the slash menu offers commands and skills", async ({ page }) => {
  await open(page, "/chat/new");
  await page.locator("#message").fill("/");
  const menu = page.getByRole("listbox", { name: "Commands" });
  await expect(menu.getByRole("option", { name: /\/model/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("an unknown chat id looks like not found", async ({ page }) => {
  const response = await page.goto(`${base()}/chat/00000000-0000-4000-8000-000000000000`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This chat does not exist" })).toBeVisible();
});

test("an image opens in the in-page viewer; Escape closes it", async ({ page }) => {
  await open(page, `/chat/${ATTACHMENTS_CONVERSATION}`);
  const image = page.locator(".image-attachment a").last();
  await image.scrollIntoViewIfNeeded();
  await image.click();
  await expect(page.getByRole("dialog").locator("img")).toBeVisible();
  expect(page.url()).toContain(ATTACHMENTS_CONVERSATION);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

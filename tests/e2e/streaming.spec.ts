import { expect, test, type Page } from "@playwright/test";
import { chooseModel, hydrated, send, signIn, storedReplies } from "./helpers.ts";

const EXPECTED = Array.from({ length: 30 }, (_, i) => `part${String(i)} `)
  .join("")
  .trimEnd();

async function sendSlow(page: Page, text: string) {
  await chooseModel(page, "mock-slow");
  await send(page, text);
  await page.getByTestId("content").filter({ hasText: "part2" }).waitFor();
}

const lastReplyText = async (page: Page) =>
  ((await storedReplies(page).last().locator(".markdown").textContent()) ?? "").trim();

test("reloading mid-generation resumes the stream", async ({ page }) => {
  await signIn(page);
  await sendSlow(page, "reload me");
  await page.reload();
  await hydrated(page);
  await expect(page.getByTestId("content")).toContainText("part");
  await expect(storedReplies(page).last()).toContainText("part29", { timeout: 20_000 });
  expect(await lastReplyText(page)).toBe(EXPECTED);
});

test("a network drop and reconnect resume with no duplicated or lost text", async ({
  page,
  context,
}) => {
  await signIn(page);
  await sendSlow(page, "drop me");
  await context.setOffline(true);
  await page.waitForTimeout(1_500);
  await context.setOffline(false);
  // EventSource reconnects on its own with Last-Event-ID; the server replays.
  await page.getByTestId("content").filter({ hasText: "part20" }).waitFor({ timeout: 20_000 });
  const live = (await page.getByTestId("content").textContent()) ?? "";
  expect(EXPECTED.startsWith(live.trim())).toBe(true);
  await expect(storedReplies(page).last()).toContainText("part29", { timeout: 20_000 });
  expect(await lastReplyText(page)).toBe(EXPECTED);
});

test("cancel from the UI stops the reply and stores it as stopped", async ({ page }) => {
  await signIn(page);
  await sendSlow(page, "stop me");
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(storedReplies(page).last().getByTestId("message-status")).toHaveText("Stopped", {
    timeout: 10_000,
  });
  const text = await lastReplyText(page);
  expect(EXPECTED.startsWith(text)).toBe(true);
  expect(text.length).toBeLessThan(EXPECTED.length);
});

test("a reply stays in its own chat when another chat is opened (no leak into New chat)", async ({
  page,
}) => {
  await signIn(page);
  await sendSlow(page, "stay here");
  const source = page.url();
  await page.getByTestId("new-chat").click();
  await page.waitForURL(/\/chat\/new$/);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("live-reply")).toHaveCount(0);
  await page.goto(source);
  await expect(storedReplies(page).last()).toContainText("part29", { timeout: 20_000 });
});

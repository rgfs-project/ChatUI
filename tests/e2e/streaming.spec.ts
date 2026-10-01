import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { chooseModel } from "./model.ts";

const base = () => process.env.E2E_BASE_URL ?? "";
const SLOW = JSON.stringify(["local", "mock-slow"]);
const EXPECTED = Array.from({ length: 30 }, (_, i) => `part${String(i)} `)
  .join("")
  .trimEnd();

test.use({
  storageState: async ({ browser }, use) => {
    await use(await signedInState(browser));
  },
});

async function signIn(page: Page) {
  await page.goto(`${base()}/chat/new`);
  await page.waitForSelector('html[data-hydrated="true"]');
}

async function sendSlow(page: Page, text: string) {
  await chooseModel(page, SLOW);
  await page.locator("#message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByTestId("content").filter({ hasText: "part2" }).waitFor();
}

const storedReply = (page: Page) => page.getByTestId("message-assistant").last();

test("reloading mid-generation resumes the stream", async ({ page }) => {
  await signIn(page);
  await sendSlow(page, "reload me");
  await page.reload();
  await page.waitForSelector('html[data-hydrated="true"]');
  await expect(page.getByTestId("content")).toContainText("part");
  await expect(storedReply(page)).toContainText("part29", { timeout: 20_000 });
  expect((await storedReply(page).locator("p").last().textContent())?.trim()).toBe(EXPECTED);
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
  await expect(storedReply(page)).toContainText("part29", { timeout: 20_000 });
  expect((await storedReply(page).locator("p").last().textContent())?.trim()).toBe(EXPECTED);
});

test("cancel from the UI stops the reply and stores it as stopped", async ({ page }) => {
  await signIn(page);
  await sendSlow(page, "stop me");
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(storedReply(page)).toContainText("Stopped", { timeout: 10_000 });
  const text = (await storedReply(page).locator("p").last().textContent())?.trim() ?? "";
  expect(EXPECTED.startsWith(text)).toBe(true);
  expect(text.length).toBeLessThan(EXPECTED.length);
});

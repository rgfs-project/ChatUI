import { expect, test } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { RICH_TITLE } from "./global-setup.ts";

const base = () => process.env.E2E_BASE_URL ?? "";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test.beforeEach(async ({ browser, context }) => {
  await context.addCookies((await signedInState(browser)).cookies);
});

test("phones use a drawer for conversations", async ({ page }) => {
  await page.goto(`${base()}/chat/new`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeHidden();
  await page.getByRole("button", { name: "Open conversations" }).click();
  const drawer = page.getByRole("dialog", { name: "Conversations" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: RICH_TITLE }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId("message-assistant").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("settings on a phone: the list, then a section", async ({ page }) => {
  await page.goto(`${base()}/settings`);
  await page.waitForSelector('html[data-hydrated="true"]');
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "General" }).click();
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
  await dialog.getByRole("button", { name: "All settings" }).click();
  await expect(dialog.getByRole("button", { name: "Account" })).toBeVisible();
});

test.describe("a narrow desktop window", () => {
  test.use({ viewport: { width: 500, height: 800 }, hasTouch: false, isMobile: false });

  test("keeps the desktop layout and sizes", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await page.waitForSelector('html[data-hydrated="true"]');
    await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open conversations" })).toHaveCount(0);
    const height = await page
      .getByRole("button", { name: /^Model: / })
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBe(40);
  });
});

test("on a phone Return adds a line; only the Send button sends", async ({ page }) => {
  await page.goto(`${base()}/chat/new`);
  await page.waitForSelector('html[data-hydrated="true"]');
  const box = page.locator("#message");
  await box.fill("first line");
  await box.press("Enter");
  await box.pressSequentially("second line");
  await expect(box).toHaveValue("first line\nsecond line");
  expect(page.url()).toMatch(/\/chat\/new$/);
});

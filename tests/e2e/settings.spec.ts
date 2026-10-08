import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_ADMIN } from "./global-setup.ts";

const base = () => process.env.E2E_BASE_URL ?? "";

async function open(page: Page, path: string) {
  await page.goto(`${base()}${path}`);
  await page.waitForSelector('html[data-hydrated="true"]');
}

test.describe("member", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser)).cookies);
  });

  test("settings open from the account menu; theme applies and persists", async ({ page }) => {
    await open(page, "/chat/new");
    await page.getByRole("button", { name: /^Account: / }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Users" })).toHaveCount(0);
    await dialog.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.waitForSelector('html[data-hydrated="true"]');
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("radio", { name: "System" })
      .click();
    await page.getByRole("button", { name: "Close" }).click();
    await page.waitForURL(/\/chat\/new$/);
  });

  test("settings search narrows the sections", async ({ page }) => {
    await open(page, "/settings");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("searchbox", { name: "Search settings" }).fill("export");
    await expect(dialog.getByRole("button", { name: "Data" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Skills" })).toHaveCount(0);
  });

  test("a skill can be created and used from the / menu", async ({ page }) => {
    await open(page, "/settings?section=skills");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "New skill" }).click();
    await dialog.getByLabel("Name").fill("e2e-skill");
    await dialog.getByLabel("Instructions").fill("Answer briefly.");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("button", { name: /\/e2e-skill/ })).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.locator("#message").fill("/e2e");
    await expect(page.getByRole("option", { name: /\/e2e-skill/ })).toBeVisible();
  });

  test("a memory can be added and deleted", async ({ page }) => {
    await open(page, "/settings?section=memories");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "New memory" }).click();
    await dialog.getByLabel("Name").fill("Favourite colour");
    await dialog.getByLabel("Note").fill("Blue");
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.getByRole("button", { name: /Favourite colour/ }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog")
      .or(page.getByRole("dialog", { name: "Delete memory?" }))
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(dialog.getByRole("button", { name: /Favourite colour/ })).toHaveCount(0);
  });

  test("everything can be exported", async ({ page }) => {
    await open(page, "/settings?section=data");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "Export" }).click();
    await expect(dialog.getByRole("link", { name: "Download" })).toBeVisible();
  });
});

test.describe("administrator", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_ADMIN)).cookies);
  });

  test("administration sections are in Settings", async ({ page }) => {
    await open(page, "/settings?section=users");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("heading", { name: "Users" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /e2e-admin/ })).toBeVisible();
    await dialog.getByRole("button", { name: "Providers" }).click();
    await expect(dialog.getByRole("button", { name: "Add provider" })).toBeVisible();
    await dialog.getByRole("button", { name: "Models" }).click();
    await expect(dialog.getByRole("button", { name: /mock-chat/ }).first()).toBeVisible();
    await dialog.getByRole("button", { name: "Audit log" }).click();
    await expect(dialog.getByRole("heading", { name: "Audit log" })).toBeVisible();
  });

  test("/admin opens the administration settings", async ({ page }) => {
    await open(page, "/admin");
    await expect(page).toHaveURL(/\/settings\?section=users$/);
  });
});

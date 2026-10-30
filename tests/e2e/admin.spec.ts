import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2E_ADMIN_STATE, E2E_PASSWORD } from "./global-setup.ts";
import { base, hydrated, signIn } from "./helpers.ts";

test.describe("administration (admin session)", () => {
  test.use({ storageState: E2E_ADMIN_STATE });

  test("create an account, set a notice, hide a model, delete the account", async ({
    page,
    browser,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: /^Account:/ }).click();
    await page.getByRole("menuitem", { name: "Administration" }).click();
    await page.waitForURL(/\/admin$/);
    const dialog = page.getByRole("dialog", { name: "Administration" });
    await expect(dialog.getByRole("heading", { name: "Accounts" })).toBeVisible();

    // Create a member.
    const create = dialog.getByRole("form", { name: "Create account" });
    await create.getByLabel("Username").fill("e2e-temp");
    await create.getByLabel("Password").fill(E2E_PASSWORD);
    await create.getByRole("button", { name: "Create" }).click();
    await expect(dialog.getByTestId("admin-user-e2e-temp")).toBeVisible();

    // A notice for everyone.
    await dialog.getByRole("button", { name: "Instance" }).click();
    await dialog.getByLabel("Notice for everyone (optional)").fill("Maintenance tonight at 22:00.");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Instance settings saved.")).toBeVisible();

    // Hide mock-hang from members.
    await dialog.getByRole("button", { name: "Models" }).click();
    await dialog.getByRole("switch", { name: "Show mock-hang to members" }).uncheck();
    await expect(
      dialog.getByRole("switch", { name: "Show mock-hang to members" }),
    ).not.toBeChecked();

    // The member's view: notice shown and dismissable; hidden model absent.
    const member = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const memberPage = await member.newPage();
    await memberPage.goto(`${base()}/login`);
    await hydrated(memberPage);
    await memberPage.locator("#username").fill("e2e-temp");
    await memberPage.locator("#password").fill(E2E_PASSWORD);
    await memberPage.getByRole("button", { name: "Sign in" }).click();
    await memberPage.waitForURL(/\/chat\/new$/);
    await expect(memberPage.getByTestId("notice")).toContainText("Maintenance tonight");
    await memberPage.getByTestId("composer-menu").click();
    await expect(memberPage.getByRole("menuitemradio", { name: /^mock-chat/ })).toBeVisible();
    await expect(memberPage.getByRole("menuitemradio", { name: /^mock-hang/ })).toHaveCount(0);
    await memberPage.keyboard.press("Escape");
    await memberPage.getByRole("button", { name: "Dismiss notice" }).click();
    await memberPage.reload();
    await hydrated(memberPage);
    await expect(memberPage.getByTestId("notice")).toHaveCount(0);
    await member.close();

    // Clean up: show the model again, clear the notice, delete the account.
    await dialog.getByRole("switch", { name: "Show mock-hang to members" }).check();
    await dialog.getByRole("button", { name: "Instance" }).click();
    await dialog.getByLabel("Notice for everyone (optional)").fill("");
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.getByRole("button", { name: "Accounts" }).click();
    await dialog.getByRole("button", { name: "Actions for e2e-temp" }).click();
    await page.getByRole("menuitem", { name: "Delete account" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete e2e-temp?" });
    await confirm.getByLabel("Username").fill("e2e-temp");
    await confirm.getByRole("button", { name: "Delete account" }).click();
    await expect(dialog.getByTestId("admin-user-e2e-temp")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Audit log" }).click();
    await expect(dialog.getByText("user.delete")).toBeVisible();
  });
});

test("members never load admin code or call admin APIs", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    requests.push(new URL(request.url()).pathname);
  });
  await signIn(page);
  await page.waitForTimeout(500);
  expect(requests.filter((p) => p.startsWith("/api/admin"))).toEqual([]);
  const manifest = JSON.parse(
    readFileSync(new URL("../../build/client/.vite/manifest.json", import.meta.url), "utf8"),
  ) as Record<string, { file: string }>;
  const adminChunk = manifest["app/routes/admin.tsx?__react-router-build-client-route"]?.file;
  expect(adminChunk).toBeTruthy();
  expect(requests).not.toContain(`/${adminChunk ?? ""}`);
  const forbidden = await page.request.get(`${base()}/api/admin/users`);
  expect(forbidden.status()).toBe(403);
  const html = await page.request.get(`${base()}/admin`);
  expect(html.status()).toBe(404);
});

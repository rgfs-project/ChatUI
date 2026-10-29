import { expect, test } from "@playwright/test";
import { base, hydrated, signIn } from "./helpers.ts";

test.describe("appearance", () => {
  test("theme, accent and sizes apply at once and are rendered by the server next time", async ({
    page,
  }) => {
    await signIn(page, "/settings/appearance");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.getByRole("radio", { name: "Dark" }).check({ force: true });
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.getByRole("radio", { name: "Green" }).check({ force: true });
    await expect(html).toHaveAttribute("data-accent", "green");
    await page.getByLabel("Interface text size").selectOption("16");
    await expect(html).toHaveAttribute("data-ui-size", "16");
    await page.getByRole("switch", { name: "Reduce motion" }).check();
    await expect(html).toHaveAttribute("data-motion", "reduce");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(0, 0, 0)");
    // The next document arrives with the choice already applied (no flash).
    const doc = await (await page.request.get(`${base()}/chat/new`)).text();
    expect(doc).toMatch(
      /<html[^>]*data-theme="dark"[^>]*data-accent="green"[^>]*data-ui-size="16"/,
    );
    await page.reload();
    await hydrated(page);
    await expect(html).toHaveAttribute("data-theme", "dark");
    // Restore the defaults for the other tests in this run.
    await page.getByRole("radio", { name: "Light" }).check({ force: true });
    await page.getByRole("radio", { name: "Orange" }).check({ force: true });
    await page.getByLabel("Interface text size").selectOption("14");
    await page.getByRole("switch", { name: "Reduce motion" }).uncheck();
    await expect(html).toHaveAttribute("data-theme", "light");
  });

  test("settings search finds rows across sections", async ({ page }) => {
    await signIn(page, "/settings/general");
    await page.getByRole("searchbox", { name: "Search settings" }).fill("password");
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
    await expect(page.getByText("Default model")).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search settings" }).fill("zzz");
    await expect(page.getByText("No settings match")).toBeVisible();
  });
});

test.describe("signed-out pages", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign-in explains how to get an account when registration is closed", async ({ page }) => {
    await page.goto(`${base()}/login`);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByText("Ask an admin to create one.")).toBeVisible();
  });

  test("the error document is styled and returns a real 404", async ({ page }) => {
    const response = await page.goto(`${base()}/register`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to ChatUI" })).toBeVisible();
  });
});

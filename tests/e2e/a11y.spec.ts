import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import {
  ATTACHMENTS_CONVERSATION,
  E2E_ADMIN,
  LONG_CONVERSATION,
  LONG_TITLE,
  RICH_CONVERSATION,
} from "./global-setup.ts";

/**
 * Phase 15 (INV-47): automated accessibility scans (axe-core, WCAG 2.2 A/AA
 * rules) of every interaction surface in its open state, in both color
 * schemes. Anything axe can't judge (screen-reader speech, reading order
 * across portals) is covered by the keyboard/focus tests and the audit.
 */

const base = () => process.env.E2E_BASE_URL ?? "";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function hydrated(page: Page) {
  await page.waitForSelector('html[data-hydrated="true"]');
}

async function scan(page: Page, surface: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found = results.violations.map((v) => ({
    surface,
    rule: v.id,
    impact: v.impact,
    help: v.help,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
  }));
  if (process.env.A11Y_REPORT) console.log(JSON.stringify(found));
  return found;
}

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  for (const scheme of ["light", "dark"] as const)
    test(`public pages (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const found = [];
      for (const url of ["/", "/login", "/register"]) {
        await page.goto(`${base()}${url}`);
        await hydrated(page);
        found.push(...(await scan(page, `${url} ${scheme}`)));
      }
      expect(found).toEqual([]);
    });
});

test.describe("signed in", () => {
  test.use({
    storageState: async ({ browser }, use) => {
      await use(await signedInState(browser));
    },
  });

  for (const scheme of ["light", "dark"] as const)
    test(`chat surfaces (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const found = [];
      await page.goto(`${base()}/chat/new`);
      await hydrated(page);
      found.push(...(await scan(page, `new chat ${scheme}`)));

      // The "/" command list open under the composer.
      await page.locator("#message").fill("/");
      await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
      found.push(...(await scan(page, `command list ${scheme}`)));
      await page.locator("#message").fill("");

      await page.goto(`${base()}/chat/${RICH_CONVERSATION}`);
      await hydrated(page);
      await expect(page.getByRole("math").first()).toBeVisible();
      found.push(...(await scan(page, `math and code ${scheme}`)));

      await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
      await hydrated(page);
      found.push(...(await scan(page, `long conversation ${scheme}`)));

      // Row menu, then the rename dialog opened from the title menu.
      await page.getByRole("button", { name: `Actions for ${LONG_TITLE}` }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      found.push(...(await scan(page, `row menu ${scheme}`)));
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Search chats" }).click();
      await expect(page.getByTestId("search-dialog")).toBeVisible();
      await page.getByRole("combobox", { name: "Search chats" }).fill("Answer 1");
      await expect(page.getByRole("option").first()).toBeVisible();
      found.push(...(await scan(page, `search dialog ${scheme}`)));
      await page.keyboard.press("Escape");

      await page.getByTestId("signed-in-user").click();
      await expect(page.getByRole("menu")).toBeVisible();
      found.push(...(await scan(page, `account menu ${scheme}`)));
      await page.getByRole("menuitem", { name: "Settings" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      for (const tab of [
        "Account",
        "Data",
        "Features",
        "Skills",
        "Memories",
        "Files",
        "Attachments",
      ]) {
        await page.getByRole("button", { name: tab, exact: true }).click();
        await page.waitForLoadState("networkidle");
        found.push(...(await scan(page, `settings ${tab} ${scheme}`)));
      }
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page.getByRole("button", { name: "Delete all" }).click();
      // Nested: Radix hides the Settings dialog from assistive technology meanwhile.
      await expect(page.getByRole("dialog", { name: "Delete all chats?" })).toBeVisible();
      found.push(...(await scan(page, `nested confirm ${scheme}`)));
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      await page.goto(`${base()}/chat/${ATTACHMENTS_CONVERSATION}`);
      await hydrated(page);
      await page.getByTestId("attachment-thumbnail").first().click();
      await expect(page.getByTestId("image-viewer")).toBeVisible();
      found.push(...(await scan(page, `image viewer ${scheme}`)));
      await page.keyboard.press("Escape");

      expect(found).toEqual([]);
    });

  test("phone: drawer and composer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const found = [];
    await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
    await hydrated(page);
    found.push(...(await scan(page, "phone conversation")));
    await page.getByRole("button", { name: "Open conversations" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    found.push(...(await scan(page, "phone drawer")));
    expect(found).toEqual([]);
  });
});

test.describe("administration", () => {
  test.use({
    storageState: async ({ browser }, use) => {
      await use(await signedInState(browser, E2E_ADMIN));
    },
  });
  test("admin panel", async ({ page }) => {
    const found = [];
    await page.goto(`${base()}/admin`);
    await hydrated(page);
    await expect(page.getByTestId("admin-users")).toBeVisible();
    found.push(...(await scan(page, "admin")));
    expect(found).toEqual([]);
  });
});

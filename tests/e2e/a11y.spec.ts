import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { RICH_CONVERSATION } from "./global-setup.ts";

/** Automated WCAG 2.2 A/AA scans of the main surfaces, in both color schemes. */
const base = () => process.env.E2E_BASE_URL ?? "";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map(
    (v) =>
      `${v.id}: ${v.nodes
        .map((n) => n.target.join(" "))
        .slice(0, 3)
        .join(", ")}`,
  );
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test("sign-in page", async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(`${base()}/login`);
      await page.waitForSelector('html[data-hydrated="true"]');
      expect(await violations(page)).toEqual([]);
      await context.close();
    });

    test("chat surfaces", async ({ browser, context, page }) => {
      await context.addCookies((await signedInState(browser)).cookies);
      await page.goto(`${base()}/chat/new`);
      await page.waitForSelector('html[data-hydrated="true"]');
      expect(await violations(page)).toEqual([]);
      await page.goto(`${base()}/chat/${RICH_CONVERSATION}`);
      await page.waitForSelector('html[data-hydrated="true"]');
      expect(await violations(page)).toEqual([]);
      await page.getByRole("button", { name: /^Model: / }).click();
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.goto(`${base()}/settings?section=general`);
      await page.waitForSelector('html[data-hydrated="true"]');
      expect(await violations(page)).toEqual([]);
    });
  });
}

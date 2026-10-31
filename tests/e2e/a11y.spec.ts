import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { makePng } from "../support/media.ts";
import { APPEARANCE_COOKIE } from "../../app/lib/appearance.ts";
import { E2E_ADMIN_STATE } from "./global-setup.ts";
import { base, chooseModel, hydrated, longChat, send, signIn, storedReplies } from "./helpers.ts";

/**
 * axe-core over every surface and overlay, WCAG 2.2 A/AA rules including
 * colour contrast (Phase 15 audit, INV-47; contrast since Phase 18), in the
 * light and the dark theme.
 */
async function axe(page: Page, label: string, include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22aa",
  ]);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const failures = results.violations.map(
    (v) =>
      `${label}: ${v.id} (${v.impact ?? "?"}) ${v.help}\n${v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(" ")} ${n.html.slice(0, 200)} — ${n.failureSummary ?? ""}`)
        .join("\n")}`,
  );
  expect(failures, failures.join("\n")).toEqual([]);
}

const themeCookie = (theme: string) => ({
  name: APPEARANCE_COOKIE,
  // Invalid sizes fall back to the defaults; only the theme matters here.
  value: `${theme}.orange.x.x.system`,
  url: base(),
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ context }) => {
      await context.addCookies([themeCookie(theme)]);
    });

    test.describe("axe: pages", () => {
      test("chat, a long conversation, Library, Profile and every Settings section", async ({
        page,
      }) => {
        await signIn(page);
        await axe(page, "new chat");
        await signIn(page, `/chat/${longChat()}`);
        await axe(page, "long chat");
        await signIn(page, "/library");
        await axe(page, "library");
        await signIn(page, "/profile");
        await axe(page, "profile");
        for (const section of [
          "general",
          "memory",
          "data",
          "appearance",
          "files",
          "account",
          "shortcuts",
        ]) {
          await signIn(page, `/settings/${section}`);
          await axe(page, `settings/${section}`);
        }
      });

      test("signed-out pages", async ({ browser }) => {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        await context.addCookies([themeCookie(theme)]);
        const page = await context.newPage();
        for (const path of ["/login", "/register", "/status"]) {
          await page.goto(`${base()}${path}`);
          await hydrated(page);
          await axe(page, path);
        }
        await context.close();
      });
    });

    test.describe("axe: admin", () => {
      test.use({ storageState: E2E_ADMIN_STATE });
      test("admin sections", async ({ page }) => {
        for (const section of ["", "/users", "/providers"]) {
          await signIn(page, `/admin${section}`);
          await axe(page, `admin${section}`);
        }
      });
    });

    test.describe("axe: overlays", () => {
      // The pages are scanned above; each overlay is scanned on its own.
      test("menus, slash menu, search, rename, confirm", async ({ page }) => {
        await signIn(page, `/chat/${longChat()}`);
        await page.getByTestId("composer-menu").click();
        await expect(page.getByRole("menu")).toBeVisible();
        await axe(page, "composer menu", '[role="menu"]');
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: "Chat options" }).click();
        await expect(page.getByRole("menu")).toBeVisible();
        await axe(page, "chat options menu", '[role="menu"]');
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await expect(page.getByRole("dialog", { name: "Rename chat" })).toBeVisible();
        await axe(page, "rename dialog", '[role="dialog"]');
        await page.keyboard.press("Escape");

        await page.locator("#message").fill("/");
        await expect(page.getByRole("listbox")).toBeVisible();
        await axe(page, "slash menu", ".composer");
        await page.locator("#message").fill("");

        await page.keyboard.press("Control+k");
        await expect(page.getByRole("dialog", { name: "Search chats" })).toBeVisible();
        await page.getByRole("combobox").fill("message");
        await axe(page, "search dialog", '[role="dialog"]');
        await page.keyboard.press("Escape");

        await signIn(page, "/settings/data");
        await page.getByRole("button", { name: "Delete all", exact: true }).click();
        await expect(page.getByRole("alertdialog")).toBeVisible();
        await axe(page, "confirm dialog", '[role="alertdialog"]');
        await page.keyboard.press("Escape");
      });

      test("source panel and image viewer", async ({ page }) => {
        await signIn(page);
        await chooseModel(page, "mock-vision");
        await page
          .getByTestId("file-input")
          .setInputFiles([{ name: "a11y.png", mimeType: "image/png", buffer: makePng(64, 48) }]);
        await expect(
          page.locator('[data-testid="composer-file"][data-status="ready"]'),
        ).toHaveCount(1);
        await send(page, "look");
        await expect(storedReplies(page)).toHaveCount(1);
        await page.getByTestId("message-attachments").locator("img").first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await axe(page, "image viewer");
        await page.keyboard.press("Escape");

        await page.goto(`${base()}/chat/new`);
        await hydrated(page);
        await chooseModel(page, "mock-chat");
        await send(page, "x\n```txt file=a11y.txt\nhello\n```");
        await storedReplies(page)
          .last()
          .getByRole("button", { name: /a11y\.txt/ })
          .click();
        await expect(page.getByTestId("source-panel")).toBeVisible();
        await axe(page, "source panel");
      });
    });
  });
}

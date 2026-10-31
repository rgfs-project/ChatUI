import { expect, test, type Page } from "@playwright/test";
import { APPEARANCE_COOKIE } from "../../app/lib/appearance.ts";
import { E2E_ADMIN_STATE } from "./global-setup.ts";
import { base, chooseModel, hydrated, longChat, send, signIn, storedReplies } from "./helpers.ts";

/** Phase 18: announcements, layout stability, theme before paint, fonts, keyboard-only use. */

async function cumulativeShift(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          })[])
            if (!entry.hadRecentInput) total += entry.value;
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => {
          resolve(total);
        }, 300);
      }),
  );
}

test("one polite region announces the start and the end of a reply, never its tokens", async ({
  page,
}) => {
  await signIn(page);
  await chooseModel(page, "mock-slow");
  const region = page.getByTestId("stream-status");
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toHaveText("");
  const seen = new Set<string>();
  await page.exposeFunction("__announce", (t: string) => seen.add(t));
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="stream-status"]');
    if (!el) return;
    new MutationObserver(() => {
      (window as unknown as { __announce: (t: string) => void }).__announce(el.textContent);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.locator("#message").fill("announce this");
  await page.locator("#message").press("Enter");
  await expect(region).toHaveText("Assistant is responding");
  // Focus stays where the user is; the region never takes it.
  await expect(page.locator("#message")).toBeFocused();
  await expect(region).toHaveText("Response complete", { timeout: 20_000 });
  expect([...seen].sort()).toEqual(["Assistant is responding", "Response complete"]);

  await chooseModel(page, "mock-500");
  await send(page, "this one fails");
  await expect(region).toHaveText("Response failed", { timeout: 20_000 });
});

test("no layout shift on a cold load of a long chat or while a reply streams", async ({ page }) => {
  await signIn(page, `/chat/${longChat()}`);
  expect(await cumulativeShift(page)).toBeLessThan(0.1);
  await chooseModel(page, "mock-slow");
  await send(page, "stream without shifting");
  await expect(page.getByTestId("content")).toContainText("part5");
  expect(await cumulativeShift(page)).toBeLessThan(0.1);
});

test("the saved theme is painted by the server, before any script, under the real CSP", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: "light" });
  await context.addCookies([
    { name: APPEARANCE_COOKIE, value: "dark.orange.x.x.system", url: base() },
  ]);
  const page = await context.newPage();
  const res = await page.goto(`${base()}/login`);
  expect(res?.headers()["content-security-policy"]).not.toContain("unsafe-inline");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(0, 0, 0)");
  await context.close();
  // "System" follows the browser before any script runs.
  const system = await browser.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
  await system.addCookies([
    { name: APPEARANCE_COOKIE, value: "system.orange.x.x.system", url: base() },
  ]);
  const systemPage = await system.newPage();
  await systemPage.goto(`${base()}/login`);
  await expect
    .poll(() => systemPage.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(0, 0, 0)");
  await system.close();
});

test("no font file is requested: the system stack renders the first chat surface", async ({
  page,
}) => {
  const fonts: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "font") fonts.push(r.url());
  });
  await signIn(page, `/chat/${longChat()}`);
  await expect(page.locator("#message")).toBeVisible();
  expect(fonts).toEqual([]);
});

test.describe("keyboard only", () => {
  test("sign in, send, open the file picker and Settings without a pointer", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${base()}/login?returnTo=%2Fchat%2Fnew`);
    await hydrated(page);
    await page.locator("#username").focus();
    await page.keyboard.type("e2e");
    await page.keyboard.press("Tab");
    await page.keyboard.type("e2e password 1234");
    await page.keyboard.press("Enter");
    await page.waitForURL(`${base()}/chat/new`);
    await hydrated(page);
    // Composer options → a model, from the keyboard.
    await page.getByTestId("composer-menu").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitemradio", { name: /^mock-chat/ }).focus();
    await page.keyboard.press("Enter");
    await page.locator("#message").focus();
    await page.keyboard.type("typed only");
    await page.keyboard.press("Enter");
    await expect(storedReplies(page)).toHaveCount(1);
    await expect(storedReplies(page)).toContainText("Echo: typed only");
    // The file picker opens from the menu item, with Enter.
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("composer-menu").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Add photos and files" })).toBeFocused();
    await page.keyboard.press("Enter");
    await chooser;
    // Settings from the account menu, and back.
    await page.getByRole("button", { name: /^Account:/ }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Settings" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
    await context.close();
  });

  test.describe("admin", () => {
    test.use({ storageState: E2E_ADMIN_STATE });
    test("Administration opens from the account menu and its sections switch by keyboard", async ({
      page,
    }) => {
      await signIn(page);
      await page.getByRole("button", { name: /^Account:/ }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Administration" }).focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/admin/);
      await hydrated(page);
      const nav = page.getByRole("navigation", { name: "Administration sections" });
      await nav.getByRole("button", { name: "Providers" }).focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/admin\/providers/);
      await expect(nav.getByRole("button", { name: "Providers" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      // Every focusable element shows a visible focus outline.
      await page.keyboard.press("Tab");
      const outline = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? getComputedStyle(el).outlineStyle : "none";
      });
      expect(outline).not.toBe("none");
    });
  });
});

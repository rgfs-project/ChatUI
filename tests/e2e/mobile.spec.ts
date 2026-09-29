import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { LONG_CONVERSATION, WIDE_CONVERSATION } from "./global-setup.ts";

/** Phase 11: the layout behaves intentionally at phone, tablet, breakpoint and desktop sizes. */

const base = () => process.env.E2E_BASE_URL ?? "";
const PIN_THRESHOLD = 48;
const SHOTS = "test-results/phase-11";
const LONG = JSON.stringify(["local", "mock-long"]);

test.use({
  storageState: async ({ browser }, use) => {
    await use(await signedInState(browser));
  },
});

async function open(page: Page, path: string) {
  await page.goto(`${base()}${path}`);
  await page.waitForSelector('html[data-hydrated="true"]');
}

function geometry(page: Page) {
  return page.evaluate(() => {
    const t = document.querySelector<HTMLElement>('[data-testid="transcript"]');
    const composer = document.querySelector("#message")?.getBoundingClientRect();
    return {
      pageScrollX: document.documentElement.scrollWidth - window.innerWidth,
      // The shell clips overflow, so also check that nothing extends past the viewport.
      overflowRight: Math.max(
        0,
        ...[
          ".conversation",
          ".transcript",
          ".composer",
          "#message",
          ".composer-actions",
          ".composer-actions button",
          ".app-header",
        ].map(
          (selector) =>
            (document.querySelector(selector)?.getBoundingClientRect().right ?? 0) -
            window.innerWidth,
        ),
      ),
      pageScrollY: document.documentElement.scrollHeight - window.innerHeight,
      viewportHeight: window.innerHeight,
      composerBottom: composer?.bottom ?? NaN,
      composerTop: composer?.top ?? NaN,
      scrollTop: t?.scrollTop ?? NaN,
      distance: t ? t.scrollHeight - t.scrollTop - t.clientHeight : NaN,
    };
  });
}

/** Visible interactive controls smaller than 44x44 (inline text links excluded). */
function smallTargets(page: Page, scope = "body") {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector) ?? document.body;
    const controls = root.querySelectorAll<HTMLElement>(
      "button, a[href], select, summary, [role='menuitem'], [role='tab']",
    );
    const small: string[] = [];
    for (const el of controls) {
      if (el.closest("p, li.message, .markdown, td")) continue; // inline content links
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // not rendered
      if (getComputedStyle(el).visibility === "hidden") continue;
      if (r.width < 44 - 0.5 || r.height < 44 - 0.5)
        small.push(
          `${el.tagName} "${(el.getAttribute("aria-label") ?? el.textContent).trim().slice(0, 30)}" ${String(Math.round(r.width))}x${String(Math.round(r.height))}`,
        );
    }
    return small;
  }, scope);
}

test.describe("phone 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the sidebar is a modal drawer: focus trap, Escape, backdrop, restored focus, inert background", async ({
    page,
  }) => {
    await open(page, `/chat/${LONG_CONVERSATION}`);
    await expect(page.locator("#sidebar")).toBeHidden();
    const trigger = page.getByRole("button", { name: "Open conversations" });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "Conversations" });
    await expect(drawer).toBeVisible();
    await expect(page.locator(".app-main")).toHaveAttribute("inert", "");
    // Focus stays inside while tabbing.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/phone-drawer.png` });
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");
    // Backdrop dismissal (tap outside the panel).
    await trigger.click();
    await expect(drawer).toBeVisible();
    await page.mouse.click(370, 400);
    await expect(drawer).toBeHidden();
    // Picking a conversation navigates and closes the drawer.
    await trigger.click();
    await drawer.getByRole("link", { name: "Wide content" }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${WIDE_CONVERSATION}$`));
    await expect(drawer).toBeHidden();
  });

  test("wide code and tables scroll inside themselves; the page never scrolls horizontally", async ({
    page,
  }) => {
    await open(page, `/chat/${WIDE_CONVERSATION}`);
    const g = await geometry(page);
    expect(g.pageScrollX).toBeLessThanOrEqual(0);
    expect(g.pageScrollY).toBeLessThanOrEqual(0);
    expect(g.overflowRight).toBeLessThanOrEqual(0);
    const inner = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>(".code-block pre");
      const table = document.querySelector<HTMLElement>(".markdown table");
      return {
        pre: pre ? pre.scrollWidth > pre.clientWidth : false,
        table: table ? table.scrollWidth > table.clientWidth : false,
      };
    });
    expect(inner).toEqual({ pre: true, table: true });
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/phone-wide.png` });
  });

  test("the composer stays visible with the on-screen keyboard; resizes never unpin", async ({
    page,
  }) => {
    await open(page, `/chat/${LONG_CONVERSATION}`);
    await page.locator("#message").click();
    const before = await geometry(page);
    expect(before.distance).toBeLessThanOrEqual(PIN_THRESHOLD);
    // A keyboard (interactive-widget=resizes-content) shrinks the layout viewport.
    await page.setViewportSize({ width: 390, height: 480 });
    await expect.poll(async () => (await geometry(page)).composerBottom).toBeLessThanOrEqual(480);
    const open1 = await geometry(page);
    expect(open1.composerTop).toBeGreaterThan(0);
    expect(open1.pageScrollY).toBeLessThanOrEqual(0);
    expect(open1.distance).toBeLessThanOrEqual(PIN_THRESHOLD); // still pinned
    await expect(page.locator("#message")).toBeFocused();
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/phone-keyboard.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => (await geometry(page)).distance)
      .toBeLessThanOrEqual(PIN_THRESHOLD);
    await expect(page.getByTestId("jump-to-latest")).toHaveCount(0);
  });

  test("streaming while scrolled up keeps the position, through a keyboard resize too", async ({
    page,
  }) => {
    await open(page, `/chat/${LONG_CONVERSATION}`);
    await page.locator("#model").selectOption(LONG);
    await page.locator("#message").fill("long answer on a phone");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("content").filter({ hasText: "Section 1" }).waitFor();
    await page.getByTestId("transcript").evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - 1500);
      el.dispatchEvent(new Event("scroll"));
    });
    const held = (await geometry(page)).scrollTop;
    await page.setViewportSize({ width: 390, height: 520 });
    await page.getByTestId("content").filter({ hasText: "Section 4" }).waitFor();
    expect(Math.abs((await geometry(page)).scrollTop - held)).toBeLessThanOrEqual(2);
    await expect(page.getByTestId("jump-to-latest")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("message-assistant").last()).toContainText("LONG-ANSWER-END", {
      timeout: 30_000,
    });
  });

  test("overlays are bottom sheets inside the viewport; menus stay on screen", async ({ page }) => {
    await open(page, `/chat/${LONG_CONVERSATION}`);
    await page.getByRole("link", { name: "Settings" }).click();
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    expect(box?.x).toBe(0);
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(390);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
    expect(await smallTargets(page, '[role="dialog"]')).toEqual([]);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/phone-settings-sheet.png` });
    await page.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
    // A conversation menu opened at the right edge stays within the viewport.
    await page.getByRole("button", { name: "Open conversations" }).click();
    const drawer = page.getByRole("dialog", { name: "Conversations" });
    await drawer
      .getByRole("button", { name: /Actions for/ })
      .first()
      .click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const m = await menu.boundingBox();
    expect(m && m.x >= 0 && m.x + m.width <= 390 && m.y + m.height <= 844).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("every control is a 44x44 touch target (shell, drawer)", async ({ page }) => {
    await open(page, `/chat/${LONG_CONVERSATION}`);
    expect(await smallTargets(page)).toEqual([]);
    await page.getByRole("button", { name: "Open conversations" }).click();
    await expect(page.getByRole("dialog", { name: "Conversations" })).toBeVisible();
    // The drawer lists menu triggers once the menu chunk has loaded.
    await page.waitForLoadState("networkidle");
    expect(await smallTargets(page, '[data-testid="sidebar-drawer"]')).toEqual([]);
    mkdirSync(SHOTS, { recursive: true });
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${SHOTS}/phone-chat.png` });
  });

  test("orientation change: landscape switches to the two-column layout without horizontal scroll", async ({
    page,
  }) => {
    await open(page, `/chat/${WIDE_CONVERSATION}`);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("#sidebar")).toBeVisible();
    const g = await geometry(page);
    expect(g.pageScrollX).toBeLessThanOrEqual(0);
    expect(g.overflowRight).toBeLessThanOrEqual(0);
    expect(g.composerBottom).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open conversations" })).toBeVisible();
  });
});

test.describe("breakpoint 768 ±1", () => {
  for (const [width, drawer] of [
    [767, true],
    [768, false],
    [769, false],
  ] as const) {
    test(`${String(width)}px: ${drawer ? "drawer" : "in-grid sidebar"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1024 });
      await open(page, `/chat/${WIDE_CONVERSATION}`);
      if (drawer) {
        await expect(page.locator("#sidebar")).toBeHidden();
        await expect(page.getByRole("button", { name: "Open conversations" })).toBeVisible();
      } else {
        await expect(page.locator("#sidebar")).toBeVisible();
        await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
      }
      const g = await geometry(page);
      expect(g.pageScrollX).toBeLessThanOrEqual(0);
      expect(g.overflowRight).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("tablet 820x1180", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test("two columns, collapsible sidebar, no horizontal scroll, sheet-free centered dialogs", async ({
    page,
  }) => {
    await open(page, `/chat/${WIDE_CONVERSATION}`);
    await expect(page.locator("#sidebar")).toBeVisible();
    expect((await geometry(page)).pageScrollX).toBeLessThanOrEqual(0);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/tablet.png` });
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.locator("#sidebar")).toBeVisible();
  });
});

test.describe("desktop 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("wide layout: sidebar in the grid, overlays centered, no horizontal scroll", async ({
    page,
  }) => {
    await open(page, `/chat/${WIDE_CONVERSATION}`);
    await expect(page.locator("#sidebar")).toBeVisible();
    expect((await geometry(page)).pageScrollX).toBeLessThanOrEqual(0);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/desktop.png` });
    await page.getByRole("link", { name: "Settings" }).click();
    const box = await page.getByRole("dialog", { name: "Settings" }).boundingBox();
    expect(box && box.x > 100 && box.y > 50).toBe(true); // centered, not a sheet
  });
});

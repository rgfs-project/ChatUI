import { expect, test, type Page } from "@playwright/test";
import { makePng } from "../support/media.ts";
import { base, hydrated, longChat, signIn } from "./helpers.ts";

const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => (document.scrollingElement?.scrollWidth ?? 0) <= window.innerWidth);

/** Every visible control answers a tap anywhere in a 44 × 44 square around its centre. */
async function smallTargets(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const bad: string[] = [];
    const root = document.querySelector(selector);
    if (!root) return [`${selector} missing`];
    for (const el of root.querySelectorAll<HTMLElement>("button, a[href], [role=menuitem]")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const points = [
        [cx - 21, cy],
        [cx + 21, cy],
        [cx, cy - 21],
        [cx, cy + 21],
      ] as const;
      const misses = points.filter(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !hit || !(hit === el || el.contains(hit) || hit.contains(el));
      });
      if (misses.length > 0)
        bad.push(
          `${el.getAttribute("aria-label") ?? el.textContent.trim()} (${String(Math.round(box.width))}×${String(Math.round(box.height))})`,
        );
    }
    return bad;
  }, scope);
}

test.describe("phone (390 × 844)", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: ANDROID,
    isMobile: true,
    hasTouch: true,
  });

  test("device-based phone layout, decided by the server before paint", async ({ page }) => {
    const html = await (
      await page.request.get(`${base()}/chat/new`, { headers: { "User-Agent": ANDROID } })
    ).text();
    expect(html).toMatch(/<html[^>]*data-phone=""/);
    await signIn(page, `/chat/${longChat()}`);
    await expect(page.locator("nav.sidebar")).toBeHidden();
    await expect(page.locator(".header-title")).toBeHidden();
    await expect(page.locator(".composer")).toHaveCSS("display", "grid");
    expect(await noHorizontalScroll(page)).toBe(true);
    // The wide code line scrolls inside its block, never the page.
    const code = page.locator(".code-block pre").filter({ hasText: "a very long line" });
    expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  });

  test("drawer: focus trap, Escape, backdrop, focus return, closes on navigation", async ({
    page,
  }) => {
    await signIn(page, `/chat/${longChat()}`);
    const open = page.getByRole("button", { name: "Open sidebar" });
    await open.click();
    const drawer = page.getByRole("dialog", { name: "Chats" });
    await expect(drawer).toBeVisible();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();
    await open.click();
    await page.mouse.click(370, 400); // the backdrop, right of the 260 px drawer
    await expect(drawer).toBeHidden();
    await open.click();
    await drawer.getByTestId("new-chat").click();
    await page.waitForURL(/\/chat\/new$/);
    await expect(drawer).toBeHidden();
  });

  test("touch targets are at least 44 × 44", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    expect(await smallTargets(page, ".chat-header")).toEqual([]);
    expect(await smallTargets(page, ".composer")).toEqual([]);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    expect(await smallTargets(page, ".drawer")).toEqual([]);
  });

  test("the on-screen keyboard (a shorter viewport) keeps the composer visible and the reader pinned", async ({
    page,
  }) => {
    await signIn(page, `/chat/${longChat()}`);
    await page.locator("#message").focus();
    await page.setViewportSize({ width: 390, height: 460 });
    await page.waitForTimeout(300);
    const box = await page.locator(".composer").boundingBox();
    expect(box && box.y + box.height <= 460).toBe(true);
    const pinned = await page.evaluate(() => {
      const el = document.getElementById("transcript-scroller");
      return el ? el.scrollHeight - el.clientHeight - el.scrollTop : -1;
    });
    expect(pinned).toBeLessThanOrEqual(32);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test("attachments: the picker opens from a tap; files sit above the text and stay visible with the keyboard open", async ({
    page,
  }) => {
    await signIn(page, `/chat/${longChat()}`);
    let chooserOpened = 0;
    page.on("filechooser", () => {
      chooserOpened++;
    });
    await page.locator("#message").tap();
    expect(chooserOpened).toBe(0);
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("composer-menu").tap();
    await page.getByRole("menuitem", { name: "Add photos and files" }).tap();
    await (
      await chooser
    ).setFiles([
      { name: "one.png", mimeType: "image/png", buffer: makePng(30, 20) },
      { name: "two.png", mimeType: "image/png", buffer: makePng(20, 30) },
    ]);
    await expect(page.locator('[data-testid="composer-file"][data-status="ready"]')).toHaveCount(2);
    expect(await smallTargets(page, ".composer")).toEqual([]);
    await page.locator("#message").focus();
    await page.setViewportSize({ width: 390, height: 460 });
    await page.waitForTimeout(300);
    const composer = await page.locator(".composer").boundingBox();
    const files = await page.getByTestId("composer-files").boundingBox();
    const text = await page.locator("#message").boundingBox();
    expect(composer && composer.y >= 0 && composer.y + composer.height <= 460).toBe(true);
    expect(files && text && files.y + files.height <= text.y).toBe(true);
    expect(files && composer && files.y >= composer.y).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test("Library and Profile fit the phone; activity opens at the newest weeks", async ({
    page,
  }) => {
    await signIn(page, "/library");
    await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    const toolbar = await page.getByRole("toolbar", { name: "Library tools" }).boundingBox();
    expect(toolbar && toolbar.x >= 0 && toolbar.x + toolbar.width <= 390).toBe(true);
    expect(await smallTargets(page, ".page-header")).toEqual([]);
    await page.goto(`${base()}/profile`);
    await hydrated(page);
    await expect(page.getByTestId("activity-grid")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    const scroll = await page.locator(".activity-scroll").evaluate((el) => ({
      left: el.scrollLeft,
      max: el.scrollWidth - el.clientWidth,
    }));
    expect(scroll.max).toBeGreaterThan(0);
    expect(scroll.left).toBeGreaterThanOrEqual(scroll.max - 1);
  });

  test("menus fit on screen at the edges", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    await page.getByTestId("composer-menu").click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0).toBe(true);
  });

  test("a file from a reply opens full width with 44 × 44 controls", async ({ page }) => {
    await signIn(page);
    await page.getByTestId("composer-menu").tap();
    await page.getByRole("menuitemradio", { name: /^mock-chat(\s|$)/ }).tap();
    await page.locator("#message").fill("x\n```txt file=phone.txt\nhello phone\n```");
    await page.getByRole("button", { name: "Send" }).tap();
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    await page.getByTestId("artifact-card").last().tap();
    const panel = page.getByTestId("source-panel");
    await expect(panel).toContainText("hello phone");
    const box = await panel.boundingBox();
    expect(box?.width).toBe(390);
    expect(await smallTargets(page, ".source-head")).toEqual([]);
    expect(await noHorizontalScroll(page)).toBe(true);
    await panel.getByRole("button", { name: "Close" }).tap();
    await expect(panel).toHaveCount(0);
  });
});

test.describe("sideways phone (844 × 390)", () => {
  test.use({
    viewport: { width: 844, height: 390 },
    userAgent: ANDROID,
    isMobile: true,
    hasTouch: true,
  });

  test("keeps the phone layout (device, not width)", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    await expect(page.locator("html")).toHaveAttribute("data-phone", "");
    await expect(page.locator("nav.sidebar")).toBeHidden();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

test.describe("tablet (820 × 1180)", () => {
  test.use({ viewport: { width: 820, height: 1180 }, userAgent: IPAD, hasTouch: true });

  test("uses the desktop layout with the sidebar beside the chat", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    expect(await page.locator("html").getAttribute("data-phone")).toBeNull();
    await expect(page.locator("nav.sidebar").first()).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

test.describe("narrow desktop window (breakpoint ±1 px)", () => {
  test("767 px: drawer; 768 px: sidebar beside the chat; never the phone layout", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 767, height: 800 });
    await signIn(page, `/chat/${longChat()}`);
    expect(await page.locator("html").getAttribute("data-phone")).toBeNull();
    await expect(page.locator(".app > nav.sidebar")).toBeHidden();
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(page.getByRole("dialog", { name: "Chats" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 768, height: 800 });
    await expect(page.locator(".app > nav.sidebar")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

test.describe("wide desktop (1440 × 900)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("sidebar inline, title in the header, no horizontal scroll", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    await expect(page.locator(".app > nav.sidebar")).toBeVisible();
    await expect(page.locator(".header-title")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await hydrated(page);
  });
});

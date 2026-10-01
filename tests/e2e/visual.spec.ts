import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import {
  E2E_ADMIN,
  E2E_PASSWORD,
  LONG_CONVERSATION,
  RICH_CONVERSATION,
  WIDE_CONVERSATION,
} from "./global-setup.ts";
import { png } from "../support/media.ts";
import { chooseModel } from "./model.ts";

/**
 * Phase 18: theme before first paint under the production CSP, the reply
 * live region, layout stability (CLS), no blocking font requests, reduced
 * motion, responsive overflow and a keyboard-only walkthrough with a visible
 * focus indicator at every stop.
 */

const base = () => process.env.E2E_BASE_URL ?? "";
const SLOW = JSON.stringify(["local", "mock-slow"]);
const VISION = JSON.stringify(["local", "mock-vision"]);

async function hydrated(page: Page) {
  await page.waitForSelector('html[data-hydrated="true"]');
}

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

const LIGHT_CANVAS = "rgb(255, 255, 255)";
const DARK_CANVAS = "rgb(33, 33, 33)";

/** Collects layout shifts not caused by input, from the first paint on. */
async function trackShifts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number; __shifts: unknown[] };
    w.__cls = 0;
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: { node?: Node | null }[];
      })[]) {
        if (entry.hadRecentInput) continue;
        w.__cls += entry.value;
        w.__shifts.push({
          value: entry.value,
          nodes: (entry.sources ?? []).map((s) =>
            s.node instanceof Element
              ? s.node.className || s.node.tagName
              : (s.node?.nodeName ?? "none"),
          ),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

const cls = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __cls: number; __shifts: unknown[] };
    return { cls: w.__cls, shifts: w.__shifts };
  });

test.describe("signed in", () => {
  test.use({
    storageState: async ({ browser }, use) => {
      await use(await signedInState(browser));
    },
  });

  test("a saved theme is in the server HTML: right before first paint, without JS", async ({
    browser,
  }) => {
    const state = await signedInState(browser);
    for (const [saved, system, expected] of [
      ["dark", "light", DARK_CANVAS],
      ["light", "dark", LIGHT_CANVAS],
      ["system", "dark", DARK_CANVAS],
      ["system", "light", LIGHT_CANVAS],
    ] as const) {
      const context = await browser.newContext({
        storageState: state,
        javaScriptEnabled: false,
        colorScheme: system,
      });
      await context.addCookies([
        { name: "chatui_theme", value: saved, url: base() || "http://localhost:3000" },
      ]);
      const page = await context.newPage();
      const response = await page.goto(`${base()}/chat/${RICH_CONVERSATION}`);
      // The production policy is unchanged: no inline-script allowance.
      const csp = response?.headers()["content-security-policy"] ?? "";
      expect(csp).toContain("script-src 'self' 'nonce-");
      expect(csp).not.toContain("unsafe-inline");
      expect(await background(page), `${saved} theme, ${system} system`).toBe(expected);
      const attr = await page.evaluate(() => document.documentElement.dataset.theme ?? "system");
      expect(attr).toBe(saved);
      await context.close();
    }
  });

  test("changing the theme applies at once, survives reload and hydrates cleanly", async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || /hydrat/i.test(m.text())) problems.push(m.text());
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    expect(await background(page)).toBe(LIGHT_CANVAS);

    await page.getByTestId("signed-in-user").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const select = page.getByRole("combobox", { name: "Theme" });
    await expect(select).toHaveValue("system");
    await select.selectOption("dark");
    expect(await background(page)).toBe(DARK_CANVAS);

    // Settings is URL-backed: the reload reopens it, in the saved theme.
    await page.reload();
    await hydrated(page);
    expect(await background(page)).toBe(DARK_CANVAS);
    await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
    await page.getByRole("combobox", { name: "Theme" }).selectOption("system");
    expect(await background(page)).toBe(LIGHT_CANVAS);
    expect(problems).toEqual([]);
  });

  test("one polite live region announces start and end, never tokens or focus moves", async ({
    page,
  }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    const announcer = page.getByTestId("response-announcer");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
    await expect(announcer).toHaveText("");
    // Every text the region ever holds, in order.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="response-announcer"]');
      const seen: string[] = [];
      (window as unknown as { __announced: string[] }).__announced = seen;
      if (el)
        new MutationObserver(() => {
          seen.push(el.textContent);
        }).observe(el, { childList: true, characterData: true, subtree: true });
    });

    await chooseModel(page, SLOW);
    await page.locator("#message").fill("announce me");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(announcer).toHaveText("Assistant is responding");
    await page.getByTestId("content").filter({ hasText: "part5" }).waitFor();
    const focused = await page.evaluate(() => document.activeElement?.id);
    await expect(announcer).toHaveText("Response complete", { timeout: 20_000 });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(focused);

    const announced = await page.evaluate(
      () => (window as unknown as { __announced: string[] }).__announced,
    );
    expect(announced.filter(Boolean)).toEqual(["Assistant is responding", "Response complete"]);
    // The streaming answer itself is not a live region.
    expect(await page.locator('[aria-live]:not([aria-live="off"])').count()).toBeLessThanOrEqual(2);
    await expect(page.getByTestId("transcript")).not.toHaveAttribute("aria-live", /.+/);
  });

  test("cancelling is announced", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await chooseModel(page, SLOW);
    await page.locator("#message").fill("stop and announce");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("content").filter({ hasText: "part2" }).waitFor();
    await page.getByRole("button", { name: "Stop generating" }).click();
    await expect(page.getByTestId("response-announcer")).toHaveText("Response cancelled");
  });

  test("layout stays put: cold load and streaming (CLS)", async ({ page }) => {
    await trackShifts(page);
    await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
    await hydrated(page);
    await page.waitForLoadState("networkidle");
    const cold = await cls(page);
    expect(cold.cls, JSON.stringify(cold.shifts)).toBeLessThan(0.1);

    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await chooseModel(page, SLOW);
    await page.locator("#message").fill("measure the stream");
    await page.getByRole("button", { name: "Send" }).click();
    // Input-driven shifts (the send) are excluded; streaming must add none.
    await page.waitForTimeout(600);
    const before = (await cls(page)).cls;
    await expect(page.getByTestId("message-assistant").last()).toContainText("part29", {
      timeout: 20_000,
    });
    const after = await cls(page);
    expect(after.cls - before, JSON.stringify(after.shifts)).toBeLessThan(0.1);
  });

  test("no font request on the chat surface's cold load", async ({ page }) => {
    const fonts: string[] = [];
    page.on("request", (r) => {
      if (r.resourceType() === "font") fonts.push(r.url());
    });
    for (const id of [LONG_CONVERSATION, "new"]) {
      await page.goto(`${base()}/chat/${id}`);
      await hydrated(page);
      await page.waitForLoadState("networkidle");
    }
    expect(fonts).toEqual([]);
  });

  test("reduced motion turns animations and transitions off", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await chooseModel(page, SLOW);
    await page.locator("#message").fill("no motion");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByTestId("content").filter({ hasText: "part1" }).waitFor();
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .map((el) => getComputedStyle(el))
        .flatMap((s) => [...s.animationDuration.split(","), ...s.transitionDuration.split(",")])
        .map((d) => parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000))
        .filter((ms) => ms > 1),
    );
    expect(durations).toEqual([]);
    await expect(page.getByTestId("message-assistant").last()).toContainText("part29", {
      timeout: 20_000,
    });
  });

  test("the sidebar's header and account stay put; only the chats scroll", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
    await hydrated(page);
    const sidebar = page.getByRole("navigation", { name: "Conversations" });
    await expect(sidebar.getByTestId("conversation-list").getByRole("link").first()).toBeVisible();
    const fixed = async () =>
      Promise.all(
        [
          sidebar.getByRole("link", { name: "New chat" }),
          sidebar.getByRole("button", { name: /^e2e/ }),
        ].map(async (l) => (await l.boundingBox())?.y),
      );
    const before = await fixed();
    const scroller = sidebar.getByTestId("sidebar-scroll");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await fixed()).toEqual(before);
    // Lists are as tall as their rows: no stretched gap between Pinned and Recents.
    const stretched = await sidebar.locator(".chat-list").evaluateAll(
      (lists) =>
        lists.filter((list) => {
          const rows = [...list.children].reduce(
            (h, li) => h + li.getBoundingClientRect().height,
            0,
          );
          return list.getBoundingClientRect().height - rows > 2 * list.children.length + 1;
        }).length,
    );
    expect(stretched).toBe(0);
  });

  test("the top bar keeps one geometry with the sidebar open and closed", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
    await hydrated(page);
    const geometry = () =>
      page.evaluate(() => {
        const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;
        const textBox = (el: Element | null) => {
          if (!el) return null;
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect();
        };
        const center = (r: DOMRect | null) => (r ? r.y + r.height / 2 : NaN);
        const sidebarOpen = !!document.querySelector(".app-shell > .sidebar:not([hidden])");
        const lead = sidebarOpen
          ? textBox(document.querySelector(".brand"))
          : box(document.querySelector(".header-nav .icon-btn svg"));
        const before = sidebarOpen
          ? box(document.querySelector(".app-shell > .sidebar"))
          : box(document.querySelector(".header-nav a svg"));
        const title = textBox(document.querySelector(".title-text"));
        const controls = [
          ...document.querySelectorAll(".sidebar-top .icon-btn, .header-nav .icon-btn"),
        ]
          .map((el) => box(el))
          .filter((r) => r !== null && r.width > 0)
          .map((r) => center(r));
        return {
          leadX: lead?.x ?? NaN,
          titleGap: (title?.x ?? NaN) - ((before?.x ?? 0) + (before?.width ?? 0)),
          centers: [center(lead), center(title), ...controls],
        };
      });
    const open = await geometry();
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    const closed = await geometry();
    // The first thing in the bar starts at the same x, in line with the
    // sidebar's row icons; everything shares one vertical center.
    expect(Math.abs(open.leadX - closed.leadX)).toBeLessThanOrEqual(1);
    for (const c of [...open.centers, ...closed.centers])
      expect(Math.abs(c - 28)).toBeLessThanOrEqual(1);
    // The title sits the same distance after whatever precedes it.
    expect(Math.abs(open.titleGap - closed.titleGap)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Show sidebar" }).click();
  });

  test("Pinned and Recents collapse, and stay collapsed after a reload", async ({ page }) => {
    await page.goto(`${base()}/chat/${LONG_CONVERSATION}`);
    await hydrated(page);
    const sidebar = page.getByRole("navigation", { name: "Conversations" });
    const recents = sidebar.getByRole("button", { name: "Recents" });
    await expect(recents).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar.getByTestId("conversation-list")).toBeVisible();
    await recents.click();
    await expect(recents).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.getByTestId("conversation-list")).toBeHidden();
    // The server renders it collapsed (no shift after hydration).
    const html = await (await page.request.get(`${base()}/chat/${LONG_CONVERSATION}`)).text();
    expect(html).toMatch(/aria-expanded="false"[^>]*>Recents/);
    await page.reload();
    await hydrated(page);
    await expect(recents).toHaveAttribute("aria-expanded", "false");
    await recents.click();
    await expect(sidebar.getByTestId("conversation-list")).toBeVisible();
  });

  test("a new sitting starts with its time; the server reserves the row", async ({ page }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await page.locator("#message").fill("what time is it?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("message-assistant").last()).toBeVisible({ timeout: 20_000 });
    const separator = page.getByTestId("time-separator");
    await expect(separator).toHaveCount(1);
    await expect(separator.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/);
    await expect(separator).toHaveText(/^\w{3}, \w{3} \d{1,2} at \d{1,2}:\d\d/);
    // Server HTML: the row is there (empty), so filling it in shifts nothing.
    const html = await (await page.request.get(page.url())).text();
    expect(html).toMatch(/data-testid="time-separator"><time dateTime="[^"]+"><\/time>/);
  });

  test("select-all takes the messages, not the interface", async ({ page }) => {
    await page.goto(`${base()}/chat/${RICH_CONVERSATION}`);
    await hydrated(page);
    await page.getByTestId("transcript").focus();
    await page.keyboard.press("ControlOrMeta+a");
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    const reply =
      (await page
        .getByTestId("message-assistant")
        .first()
        .locator(".markdown p")
        .first()
        .textContent()) ?? "";
    expect(selected).toContain(reply.trim().slice(0, 20));
    for (const chrome of ["New chat", "Search chats", "Recents", "Thought process", "ChatUI"])
      expect(selected, chrome).not.toContain(chrome);
  });

  test("Show thought process off hides reasoning, from the first paint after reload", async ({
    page,
  }) => {
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await page.locator("#message").fill("think out loud");
    await page.getByRole("button", { name: "Send" }).click();
    const reply = page.getByTestId("message-assistant").last();
    await expect(reply.getByText("Thought process")).toBeVisible({ timeout: 20_000 });
    const url = page.url();

    await page.getByTestId("signed-in-user").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const toggle = page.getByRole("switch", { name: "Show thought process" });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.keyboard.press("Escape");
    await expect(reply.getByText("Thought process")).toBeHidden();

    const html = await (await page.request.get(url)).text();
    expect(html).toMatch(/<html[^>]*data-reasoning="hidden"/);
    await page.reload();
    await hydrated(page);
    await expect(
      page.getByTestId("message-assistant").last().getByText("Thought process"),
    ).toBeHidden();

    await page.getByTestId("signed-in-user").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("switch", { name: "Show thought process" }).check();
    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("message-assistant").last().getByText("Thought process"),
    ).toBeVisible();
  });

  for (const width of [320, 390, 768, 1024, 1440])
    test(`no horizontal page overflow at ${String(width)} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      for (const url of [
        `/chat/${WIDE_CONVERSATION}`,
        `/chat/${RICH_CONVERSATION}`,
        `/chat/${LONG_CONVERSATION}`,
        "/settings",
      ]) {
        await page.goto(`${base()}${url}`);
        await hydrated(page);
        const overflow = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: document.body.scrollWidth - document.body.clientWidth,
        }));
        expect(overflow, `${url} at ${String(width)}`).toEqual({ page: 0, body: 0 });
      }
    });
});

/** Tabs (or Shift+Tabs) until `match` holds for the focused element. */
async function tabTo(page: Page, match: string, back = false) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, match)) return;
  }
  throw new Error(`could not reach ${match} with the keyboard`);
}

/** Visits `stops` focus stops and requires a visible indicator on each. */
async function focusIsAlwaysVisible(page: Page, stops: number) {
  const missing: string[] = [];
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1;
      // Text fields show focus with their caret (owner's request: no frame).
      const textField = el.matches(
        'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"])',
      );
      const shadow = s.boxShadow !== "none";
      // Fields drawn with a parent frame show focus on the frame (composer, search).
      const frame = el.closest(".composer-box, .search-field, .skills-search, .skill-name-field");
      const framed = frame ? getComputedStyle(frame).boxShadow !== "none" : false;
      return {
        ok: ring || shadow || framed || textField,
        what: `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 30)}`,
      };
    });
    if (info && !info.ok) missing.push(info.what);
  }
  expect(missing).toEqual([]);
}

test.describe("keyboard only", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("login → chat → attachments → admin, with focus always visible", async ({ page }) => {
    await page.goto(`${base()}/login`);
    await hydrated(page);
    await tabTo(page, "#username");
    await page.keyboard.type(E2E_ADMIN);
    await page.keyboard.press("Tab");
    await page.keyboard.type(E2E_PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/new$/);
    await hydrated(page);

    // Chat: the composer is reachable and Enter sends.
    await focusIsAlwaysVisible(page, 12);
    // Containers are not Tab stops of their own: the transcript is reached
    // through its controls (and scrolled from them).
    await expect(page.getByTestId("transcript")).toHaveAttribute("tabindex", "-1");
    await tabTo(page, "#message");
    await page.keyboard.type("hello from the keyboard");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-assistant").last()).toBeVisible({ timeout: 20_000 });

    // Attachments: the native model select is chosen by the browser's own
    // select keyboard handling; the picker opens from the "+" button.
    await chooseModel(page, VISION);
    await tabTo(page, 'button[aria-label="Attach files"]', true);
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (
      await chooser
    ).setFiles([{ name: "keys.png", mimeType: "image/png", buffer: png(64, 64) }]);
    await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
    await tabTo(page, "#message");
    await page.keyboard.type("what is this?");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("attachment-thumbnail").last()).toBeVisible({
      timeout: 20_000,
    });

    // Administration through the account menu.
    await tabTo(page, 'button:has([data-testid="signed-in-user"])');
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    for (let i = 0; i < 6; i++) {
      if (await page.evaluate(() => document.activeElement?.textContent.includes("Administration")))
        break;
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("admin-users")).toBeVisible();
    await focusIsAlwaysVisible(page, 20);
  });
});

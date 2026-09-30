import { readFileSync } from "node:fs";
import { expect, test, type Page, type Request } from "@playwright/test";
import { signedInState } from "./auth.ts";
import {
  PLAIN_CONVERSATION,
  MALFORMED_TEX,
  RICH_CONVERSATION,
  STREAM_CONVERSATION,
  WIDE_CONVERSATION,
} from "./global-setup.ts";

/**
 * Phase 14 in a real browser (production build): server-rendered MathML,
 * on-demand first-party renderer chunks, the strict CSP, code actions,
 * selection/scroll/DOM stability while a reply streams into a 200-message
 * conversation.
 */

const base = () => process.env.E2E_BASE_URL ?? "";
const RICH = JSON.stringify(["local", "mock-rich"]);

test.use({
  storageState: async ({ browser }, use) => {
    await use(await signedInState(browser));
  },
});

async function hydrated(page: Page) {
  await page.waitForSelector('html[data-hydrated="true"]');
}

/** Records every request and every CSP or other console error of a page. */
function watch(page: Page) {
  const requests: Request[] = [];
  const errors: string[] = [];
  page.on("request", (request) => requests.push(request));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return { requests, errors };
}

const renderer =
  /\/assets\/(MathView|highlight|math|python|rust|typescript|bash)-[\w-]+\.(js|css)$/;

test("server HTML carries rendered MathML; the math chunk and styles are first-party", async ({
  page,
}) => {
  const html = await (await page.request.get(`${base()}/chat/${RICH_CONVERSATION}`)).text();
  expect(html).toContain("<math");
  expect(html).toContain('<annotation encoding="application/x-tex">');
  expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/math-[\w-]+\.css"/);
  // The strict CSP blocks style attributes: math markup has none.
  const transcript = html.slice(html.indexOf("<main"));
  expect(transcript).not.toMatch(/<m[a-z]+[^>]*\sstyle=/);
  // The malformed formula is inert source, not an error page.
  expect(html).toContain(MALFORMED_TEX);
  expect(html).toContain("Couldn’t render this formula");

  const seen = watch(page);
  await page.goto(`${base()}/chat/${RICH_CONVERSATION}`);
  await hydrated(page);
  const reply = page.getByTestId("message-assistant").last();
  await expect(reply.getByRole("math").first()).toBeVisible();
  expect(await reply.locator("math").count()).toBeGreaterThanOrEqual(15);
  // Matrix cell padding is applied through the CSSOM (no inline style attribute).
  await expect
    .poll(() =>
      reply
        .locator("mtd")
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingRight)),
    )
    .toBeGreaterThan(0);
  await expect(reply.locator(".hljs-keyword").first()).toBeVisible();
  const origin = new URL(page.url()).origin;
  for (const request of seen.requests) expect(new URL(request.url()).origin).toBe(origin);
  const loaded = seen.requests.map((r) => new URL(r.url()).pathname);
  expect(loaded.some((p) => p.includes("/assets/MathView-"))).toBe(true);
  expect(loaded.some((p) => p.includes("/assets/python-"))).toBe(true);
  expect(seen.errors).toEqual([]);
});

test("a chat without math or code loads no renderer chunk", async ({ page }) => {
  const seen = watch(page);
  await page.goto(`${base()}/chat/${PLAIN_CONVERSATION}`);
  await hydrated(page);
  await expect(page.getByTestId("message-assistant").last()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const loaded = seen.requests.map((r) => new URL(r.url()).pathname);
  expect(loaded.filter((p) => renderer.test(p))).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("code blocks: highlight, plain fallback, copy, download and keyboard scrolling", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base()}/chat/${RICH_CONVERSATION}`);
  await hydrated(page);
  const reply = page.getByTestId("message-assistant").last();
  const python = reply.getByTestId("code-block").filter({ hasText: "def square" });
  await expect(python.locator(".hljs-keyword").first()).toBeVisible();
  const unknown = reply.getByTestId("code-block").filter({ hasText: "unknownlang" });
  await expect(unknown.locator("pre code")).toHaveText("plain <b>text</b> here");
  expect(await unknown.locator("pre code span").count()).toBe(0);

  const source = 'def square(x):\n    return x * x  # "quoted"';
  await python.getByRole("button", { name: "Copy code" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    python.getByRole("button", { name: "Download code" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("snippet.py");
  expect(readFileSync(await download.path(), "utf8")).toBe(source);

  await reply.locator("div.math-block").first().hover();
  await reply.getByRole("button", { name: "Copy LaTeX" }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  );

  // A wide block scrolls horizontally from the keyboard.
  await page.goto(`${base()}/chat/${WIDE_CONVERSATION}`);
  await hydrated(page);
  const pre = page.getByTestId("code-block").locator("pre").first();
  await pre.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => pre.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});

test("reduced motion: the rendered answer runs no animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${base()}/chat/${RICH_CONVERSATION}`);
  await hydrated(page);
  await expect(
    page.getByTestId("message-assistant").last().getByRole("math").first(),
  ).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("streaming into a 200-message chat keeps selection, scroll position and unrelated DOM", async ({
  page,
}) => {
  const seen = watch(page);
  await page.goto(`${base()}/chat/${STREAM_CONVERSATION}`);
  await hydrated(page);
  await expect(page.getByTestId("message-assistant")).toHaveCount(100);
  // Tag stored messages' DOM nodes: they must survive the whole stream.
  await page.evaluate(() => {
    for (const li of document.querySelectorAll("[data-testid^=message-]"))
      (li as HTMLElement & { __kept?: boolean }).__kept = true;
  });
  await page.evaluate(() => {
    new PerformanceObserver((list) => {
      const w = window as unknown as { __longTasks?: number[] };
      w.__longTasks ??= [];
      for (const entry of list.getEntries()) w.__longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
  });

  await page.locator("#model").selectOption(RICH);
  await page.locator("#message").fill("math and code please");
  await page.getByRole("button", { name: "Send" }).click();
  const live = page.getByTestId("content");
  await expect(live).toContainText("to print.", { timeout: 20_000 });

  // Select words in the finished first paragraph.
  const selected = await page.evaluate(() => {
    const p = document.querySelector("[data-testid=content] p");
    const text = p?.firstChild;
    if (!text) return "";
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 10);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    (window as unknown as { __anchor?: Node }).__anchor = text;
    return getSelection()?.toString() ?? "";
  });
  expect(selected).toBe("RICH-FIRST");

  // Leave the bottom: the reading position must hold while text arrives.
  const transcript = page.getByTestId("transcript");
  await transcript.hover();
  await page.mouse.wheel(0, -600);
  const top = await transcript.evaluate((el) => el.scrollTop);
  await expect(live).toContainText("Paragraph 3", { timeout: 20_000 });
  expect(Math.abs((await transcript.evaluate((el) => el.scrollTop)) - top)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("RICH-FIRST");
  expect(
    await page.evaluate(
      () => (window as unknown as { __anchor?: Node }).__anchor?.isConnected ?? false,
    ),
  ).toBe(true);
  await expect(live.getByRole("math").first()).toBeVisible();

  // Back to the bottom: pinned again, following the rest of the reply.
  await page.getByRole("button", { name: "Jump to latest" }).click();
  const stored = page.getByTestId("message-assistant").last();
  await expect(stored).toContainText("RICH-ANSWER-END", { timeout: 30_000 });
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThanOrEqual(48);
  expect(
    await page.evaluate(
      () =>
        [...document.querySelectorAll("[data-testid^=message-]")].filter(
          (li) => (li as HTMLElement & { __kept?: boolean }).__kept,
        ).length,
    ),
  ).toBe(200);
  expect(await stored.locator("math").count()).toBeGreaterThanOrEqual(15);
  const longTasks = await page.evaluate(
    () => (window as unknown as { __longTasks?: number[] }).__longTasks ?? [],
  );
  test.info().annotations.push({
    type: "long tasks while streaming",
    description: `${String(longTasks.length)} tasks, max ${String(Math.round(Math.max(0, ...longTasks)))} ms`,
  });
  expect(seen.errors).toEqual([]);
});

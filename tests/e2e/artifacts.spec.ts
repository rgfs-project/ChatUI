import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_FILES_USER } from "./global-setup.ts";
import { chooseModel } from "./model.ts";

/** Phase 13c: captured source files, the inert source panel and Settings → Files. */

const base = () => process.env.E2E_BASE_URL ?? "";
const CHAT = JSON.stringify(["local", "mock-chat"]);
const SHOTS = path.resolve(import.meta.dirname, "../../docs/phase-reports/phase-13c");
const XSS = '<script>alert("xss")</script><img src=x onerror="alert(1)">';

async function hydrated(page: Page) {
  await page.waitForSelector('html[data-hydrated="true"]');
}

/** Sends a message whose echoed reply contains a labelled fence. */
async function sendFile(page: Page, name: string, body: string) {
  await page.goto(`${base()}/chat/new`);
  await hydrated(page);
  await chooseModel(page, CHAT);
  await page
    .locator("#message")
    .fill(`Here\n\`\`\`${name.split(".").pop() ?? ""} file=${name}\n${body}\n\`\`\``);
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByTestId("artifact-card").filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

test.describe("source files (INV-40, INV-41)", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_FILES_USER)).cookies);
  });

  test("a card opens the lazy panel from the keyboard; Escape returns focus", async ({ page }) => {
    const card = await sendFile(page, "hello.py", "print('hi')");
    await card.focus();
    const started = Date.now();
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("artifact-panel");
    await expect(panel.getByTestId("artifact-source")).toHaveText("print('hi')\n");
    // On-demand cost (chunk + source request), recorded in the phase report.
    const openMs = Date.now() - started;
    test.info().annotations.push({ type: "artifact-panel-open-ms", description: String(openMs) });
    expect(openMs).toBeLessThan(2_000);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, "panel.png") });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(card).toBeFocused();
  });

  test("HTML never runs: not in the panel, not when its source URL is opened", async ({ page }) => {
    page.on("dialog", (dialog) => {
      throw new Error(`a dialog opened: ${dialog.message()}`);
    });
    const card = await sendFile(page, "page.html", XSS);
    await card.click();
    const source = page.getByTestId("artifact-source");
    await expect(source).toHaveText(`${XSS}\n`);
    expect(await page.getByTestId("artifact-panel").locator("script, img").count()).toBe(0);
    const href = await page.getByRole("link", { name: "Download" }).getAttribute("href");
    const url = `${base()}${(href ?? "").replace("?download=1", "")}`;
    const response = await page.goto(url);
    expect(response?.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response?.headers()["content-security-policy"]).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    expect(await page.locator("script, img").count()).toBe(0);
    await expect(page.locator("body")).toContainText('<script>alert("xss")</script>');
  });

  test("Settings → Files lists files; deleting the chat leaves the file with a dead backlink", async ({
    page,
  }) => {
    await sendFile(page, "notes.md", "# Notes");
    const title = await page.getByRole("heading", { level: 1 }).textContent();
    await page.goto(`${base()}/settings`);
    await hydrated(page);
    await page.getByRole("button", { name: "Files" }).click();
    const row = page.getByTestId("artifact-row").filter({ hasText: "notes.md" }).first();
    await expect(row.getByRole("link", { name: "Open chat" })).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "files.png") });
    // Delete the originating chat.
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await page
      .getByRole("button", { name: `Actions for ${title ?? ""}` })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await page.goto(`${base()}/settings`);
    await hydrated(page);
    await page.getByRole("button", { name: "Files" }).click();
    await expect(
      page.getByTestId("artifact-row").filter({ hasText: "notes.md" }).first(),
    ).toContainText("Chat deleted");
  });
});

test.describe("source files on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_FILES_USER)).cookies);
  });

  test("the panel fills the screen, scrolls inside itself and has 44 px controls", async ({
    page,
  }) => {
    const long = Array.from({ length: 200 }, (_, i) => `line-${String(i)}-${"x".repeat(120)}`).join(
      "\n",
    );
    const card = await sendFile(page, "long.txt", long);
    await card.click();
    const panel = page.getByTestId("artifact-panel");
    await expect(panel.getByTestId("artifact-source")).toContainText("line-199-");
    const box = await panel.boundingBox();
    expect(box?.width).toBe(390);
    for (const name of ["Close", "Download", "Delete file"]) {
      const control = await panel
        .getByRole(name === "Download" ? "link" : "button", { name })
        .boundingBox();
      expect(control && control.width >= 44 && control.height >= 44, name).toBe(true);
    }
    // The page never scrolls sideways; the source does.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
});

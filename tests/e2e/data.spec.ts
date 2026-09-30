import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_OTHER_USER } from "./global-setup.ts";

/** Phase 13d: exact chat export, export everything, and restoring from the archive. */

const base = () => process.env.E2E_BASE_URL ?? "";
const CHAT = JSON.stringify(["local", "mock-chat"]);
const SHOTS = path.resolve(import.meta.dirname, "../../docs/phase-reports/phase-13d");

async function hydrated(page: Page) {
  await page.waitForSelector('html[data-hydrated="true"]');
}

async function sendMessage(page: Page, text: string) {
  await page.goto(`${base()}/chat/new`);
  await hydrated(page);
  await page.locator("#model").selectOption(CHAT);
  await page.locator("#message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant").last()).toContainText(`Echo: ${text}`, {
    timeout: 20_000,
  });
}

async function openData(page: Page) {
  await page.goto(`${base()}/settings`);
  await hydrated(page);
  await page.getByRole("button", { name: "Data" }).click();
  await expect(page.getByRole("heading", { name: "Data", level: 2 })).toBeVisible();
}

test.describe("export and import (INV-42, INV-43)", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_OTHER_USER)).cookies);
  });

  test("a chat exports as its exact Markdown from the title menu", async ({ page }) => {
    await sendMessage(page, "export me");
    await page.locator(".chat-title .title-trigger").click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: "Export as Markdown" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("export me.md");
    const text = readFileSync(await download.path(), "utf8");
    expect(text).toMatch(/^---\nformatVersion: 1\n/);
    expect(text).toContain("Echo: export me");
  });

  test("export everything, delete a chat, then restore it from the archive", async ({ page }) => {
    await sendMessage(page, "keep this chat");
    await openData(page);
    const started = Date.now();
    await page.getByRole("button", { name: /Export all data/ }).click();
    const link = page.getByTestId("export-download");
    await expect(link).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    test.info().annotations.push({ type: "export-ms", description: String(Date.now() - started) });
    const archive = await download.path();
    expect(download.suggestedFilename()).toMatch(/^chatui-export-\d{4}-\d{2}-\d{2}\.zip$/);

    // Delete the chat.
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await page.getByRole("button", { name: "Actions for keep this chat" }).first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("link", { name: "keep this chat" })).toHaveCount(0);

    // Import the archive: preview, confirm, report.
    await openData(page);
    const previewStarted = Date.now();
    await page.getByLabel("Choose file…").setInputFiles(archive);
    const preview = page.getByTestId("import-preview");
    await expect(preview).toBeVisible();
    const previewMs = Date.now() - previewStarted;
    test.info().annotations.push({ type: "import-preview-ms", description: String(previewMs) });
    expect(previewMs).toBeLessThan(5_000);
    await expect(preview.getByRole("table")).toContainText("Chats");
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, "preview.png") });
    await preview.getByRole("button", { name: "Import" }).click();
    const report = page.getByTestId("import-report");
    await expect(report).toContainText("Import complete", { timeout: 20_000 });
    await expect(report).toContainText(/[1-9]\d* items? imported/);
    await page.goto(`${base()}/chat/new`);
    await hydrated(page);
    await expect(page.getByRole("link", { name: "keep this chat" }).first()).toBeVisible();
  });
});

test.describe("import on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_OTHER_USER)).cookies);
  });

  test("the preview fits the screen and its controls are 44 px targets", async ({ page }) => {
    await sendMessage(page, "phone data");
    await openData(page);
    await page.getByRole("button", { name: /Export all data/ }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-download").click(),
    ]);
    await page.getByLabel("Choose file…").setInputFiles(await download.path());
    const preview = page.getByTestId("import-preview");
    await expect(preview).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    for (const name of ["Cancel", "Import"]) {
      const box = await preview.getByRole("button", { name }).boundingBox();
      expect(box && box.height >= 44, name).toBe(true);
    }
    await preview.getByRole("button", { name: "Cancel" }).click();
    await expect(preview).toBeHidden();
  });
});

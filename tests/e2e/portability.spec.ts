import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { base, chooseModel, send, signIn, storedReplies } from "./helpers.ts";

test.describe("Phase 13d: export and import", () => {
  test("Share downloads the chat's exact Markdown", async ({ page }) => {
    const title = `share ${String(Date.now())}`;
    await signIn(page);
    await chooseModel(page, "mock-chat");
    await send(page, title);
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(storedReplies(page).last()).toContainText(`Echo: ${title}`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download as Markdown" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`${title}.md`);
    const text = readFileSync(await file.path(), "utf8");
    expect(text).toMatch(/^---\nformatVersion: 1\n/);
    expect(text).toContain(`Echo: ${title}`);
  });

  test("export everything, delete a chat, and restore it from the archive after a preview", async ({
    page,
  }) => {
    const title = `restore ${String(Date.now())}`;
    await signIn(page);
    await chooseModel(page, "mock-chat");
    await send(page, title);
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(storedReplies(page).last()).toContainText(`Echo: ${title}`);
    const chatUrl = page.url();

    await page.goto(`${base()}/settings/data`);
    const download = page.waitForEvent("download");
    await page.getByTestId("export-all").click();
    const archive = await (await download).path();
    expect(readFileSync(archive).subarray(0, 2).toString()).toBe("PK");

    await page.goto(chatUrl);
    await page.getByRole("button", { name: "Chat options" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/\/chat\/new$/);
    await expect(
      page.getByTestId("conversation-list").getByRole("link", { name: title }),
    ).toHaveCount(0);

    await page.goto(`${base()}/settings/data`);
    const started = Date.now();
    await page.getByTestId("import-file-input").setInputFiles(archive);
    const preview = page.getByTestId("import-preview");
    await expect(preview).toContainText("1 new chat");
    const ms = Date.now() - started;
    // On-demand import preview (Phase 9 style budget): chunk, upload, validation.
    expect(ms).toBeLessThan(5_000);
    test.info().annotations.push({ type: "import-preview", description: `${String(ms)} ms` });
    await expect(preview).toContainText("already here");
    // Keyboard: the confirm button is reachable and labelled.
    const confirm = preview.getByRole("button", { name: "Import" });
    await confirm.focus();
    await page.keyboard.press("Enter");
    const report = page.getByTestId("import-report");
    await expect(report).toContainText("Imported 1 chat");
    await report.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(
      page.getByTestId("conversation-list").getByRole("link", { name: title }),
    ).toBeVisible();
  });

  test("cancelling a preview imports nothing", async ({ page }) => {
    await signIn(page, "/settings/data");
    const download = page.waitForEvent("download");
    await page.getByTestId("export-all").click();
    const archive = await (await download).path();
    await page.getByTestId("import-file-input").setInputFiles(archive);
    const preview = page.getByTestId("import-preview");
    await expect(preview).toContainText("already here");
    await preview.getByRole("button", { name: "Cancel" }).click();
    await expect(preview).toHaveCount(0);
  });
});

test.describe("Phase 13d on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("Data controls fit the phone and the import preview opens", async ({ page }) => {
    await signIn(page, "/settings/data");
    const exportLink = page.getByTestId("export-all");
    await expect(exportLink).toBeVisible();
    const box = await exportLink.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    const download = page.waitForEvent("download");
    await exportLink.tap();
    const archive = await (await download).path();
    await page.getByTestId("import-file-input").setInputFiles(archive);
    await expect(page.getByTestId("import-preview")).toBeVisible();
    expect(
      await page.evaluate(() => (document.scrollingElement?.scrollWidth ?? 0) <= window.innerWidth),
    ).toBe(true);
    await page.getByTestId("import-preview").getByRole("button", { name: "Cancel" }).tap();
  });
});

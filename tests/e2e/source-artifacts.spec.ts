import { expect, test } from "@playwright/test";
import { base, chooseModel, send, signIn, storedReplies } from "./helpers.ts";

test.describe("Phase 13c: files from replies", () => {
  test("a captured file opens as inert source, downloads, and is listed and deleted in the Library", async ({
    page,
  }) => {
    const name = `page-${String(Date.now())}.html`;
    const payload = '<h1 id="pwned">rendered</h1><script>document.title="pwned"</script>';
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    await signIn(page);
    await chooseModel(page, "mock-chat");
    await send(page, `Here:\n\`\`\`html file=${name}\n${payload}\n\`\`\``);
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    const card = storedReplies(page).last().getByTestId("artifact-card");
    await expect(card).toContainText(name);

    // Keyboard: the card opens the panel; Escape closes it and focus returns.
    await card.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("source-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name })).toBeVisible();
    // Shown as text: the markup is visible, nothing ran or rendered (INV-41).
    await expect(panel).toContainText('<h1 id="pwned">rendered</h1>');
    await expect(page.locator("#pwned")).toHaveCount(0);
    expect(await page.title()).not.toBe("pwned");
    expect(dialogs).toBe(0);
    await expect(panel.getByRole("link", { name: "Download file" })).toHaveAttribute(
      "href",
      /\/api\/artifacts\/[0-9a-f-]{36}\/source\?download=1$/,
    );
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(card).toBeFocused();

    await page.goto(`${base()}/library?type=created`);
    const row = page.getByTestId("library-row").filter({ hasText: name });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name, exact: true }).click();
    await expect(page.getByTestId("source-panel")).toContainText("<script>");
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: `Options for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog", { name: "Delete this file?" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(row).toHaveCount(0);
  });

  test("create_file shows its chip and card", async ({ page }) => {
    await signIn(page);
    await chooseModel(page, "mock-tools");
    await send(page, "file plan.md: # Plan");
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    const reply = storedReplies(page).last();
    await expect(reply.getByTestId("tool-chips")).toContainText("Created a file");
    await expect(reply.getByTestId("artifact-card")).toContainText("plan.md");
  });
});

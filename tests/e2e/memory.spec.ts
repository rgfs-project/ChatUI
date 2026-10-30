import { expect, test } from "@playwright/test";
import { base, chooseModel, send, signIn, storedReplies } from "./helpers.ts";

test.describe("Phase 13b: tools and memory", () => {
  test("a reply shows the tools it used; a memory suggestion is saved only when the user chooses Save", async ({
    page,
  }) => {
    const name = `Pet ${String(Date.now())}`;
    await signIn(page);
    await chooseModel(page, "mock-tools");
    await send(page, `say On it.; calc 6*7; remember ${name}: Has a cat named Miso`);
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    const reply = storedReplies(page).last();
    await expect(reply).toContainText("On it.");
    await expect(reply).toContainText("Done: 42");
    const chips = reply.getByTestId("tool-chips");
    await expect(chips).toContainText("Calculated");
    await expect(chips).toContainText("Suggested a memory");

    const card = reply.getByTestId("proposal");
    await expect(card).toContainText(`Remember “${name}”`);
    await expect(card).toContainText("Has a cat named Miso");
    // Nothing is saved yet.
    await page.goto(`${base()}/settings/memory`);
    await expect(page.getByTestId("memory").filter({ hasText: name })).toHaveCount(0);
    await page.goBack();
    await storedReplies(page).last().getByRole("button", { name: "Save" }).click();
    await expect(storedReplies(page).last().getByTestId("proposal")).toContainText(
      "Saved to memory",
    );

    await page.goto(`${base()}/settings/memory`);
    const saved = page.getByTestId("memory").filter({ hasText: name });
    await expect(saved).toContainText("Has a cat named Miso");

    // Edit, then delete with confirmation.
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    const form = page.getByRole("form", { name: "Save changes" });
    await form.getByRole("textbox", { name: "Memory" }).fill("Has two cats");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(saved).toContainText("Has two cats");
    await page.getByRole("button", { name: `Delete ${name}` }).click();
    await page
      .getByRole("alertdialog", { name: "Delete this memory?" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(saved).toHaveCount(0);
  });

  test("Dismiss rejects a suggestion; added memories reach later replies", async ({ page }) => {
    const name = `Home ${String(Date.now())}`;
    await signIn(page, "/settings/memory");
    await page.getByRole("button", { name: "Add" }).click();
    const form = page.getByRole("form", { name: "Save memory" });
    await form.getByRole("textbox", { name: "Name" }).fill(name);
    await form.getByRole("textbox", { name: "Memory" }).fill("Lives in Lisbon");
    await form.getByRole("button", { name: "Save memory" }).click();
    await expect(page.getByTestId("memory").filter({ hasText: name })).toBeVisible();

    await page.goto(`${base()}/chat/new`);
    await chooseModel(page, "mock-tools");
    await send(page, `update ${name}: Lives in Porto`);
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    const card = storedReplies(page).last().getByTestId("proposal");
    await expect(card).toContainText(`Update “${name}”`);
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toContainText("Dismissed");
    await page.reload();
    await expect(storedReplies(page).last().getByTestId("proposal")).toContainText("Dismissed");
  });
});

import { expect, test, type Page } from "@playwright/test";
import { E2E_OTHER_USER } from "./global-setup.ts";
import { base, chooseModel, send, signIn, signInWithForm, storedReplies } from "./helpers.ts";

/** Starts a chat with the echo model and waits for the stored reply. */
async function chat(page: Page, first: string): Promise<string> {
  await signIn(page);
  await chooseModel(page, "mock-chat");
  await send(page, first);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(storedReplies(page).last()).toContainText(`Echo: ${first}`);
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

const users = (page: Page) => page.getByTestId("message-user");

test.describe("Phase 13a: message actions", () => {
  test("edit in place: Cancel keeps the text; Send replaces the turn and regenerates its reply", async ({
    page,
  }) => {
    const stamp = String(Date.now());
    await chat(page, `first ${stamp}`);
    await send(page, `second ${stamp}`);
    await expect(storedReplies(page)).toHaveCount(2);
    await expect(storedReplies(page).last()).toContainText(`Echo: second ${stamp}`);

    const firstTurn = users(page).first();
    await firstTurn.hover();
    await firstTurn.getByRole("button", { name: "Edit message" }).click();
    const editor = page.getByRole("form", { name: "Edit message" });
    const field = editor.getByRole("textbox", { name: "Edited message" });
    await expect(field).toBeFocused();
    await field.fill("changed");
    await editor.getByRole("button", { name: "Cancel" }).click();
    await expect(editor).toHaveCount(0);
    await expect(firstTurn).toContainText(`first ${stamp}`);

    await firstTurn.hover();
    await firstTurn.getByRole("button", { name: "Edit message" }).click();
    // Send stays disabled until the text changes.
    await expect(editor.getByRole("button", { name: "Send" })).toBeDisabled();
    await field.fill(`edited ${stamp}`);
    await field.press("Enter");
    await expect(editor).toHaveCount(0);
    // The later exchange is gone and the edited turn has a fresh reply.
    await expect(users(page)).toHaveCount(1);
    await expect(users(page).first()).toContainText(`edited ${stamp}`);
    await expect(storedReplies(page)).toHaveCount(1);
    await expect(storedReplies(page).first()).toContainText(`Echo: edited ${stamp}`);
    await page.reload();
    await expect(storedReplies(page).first()).toContainText(`Echo: edited ${stamp}`);
    await expect(users(page)).toHaveCount(1);
  });

  test("regenerate asks first and replaces the reply; delete removes one exchange", async ({
    page,
  }) => {
    const stamp = String(Date.now());
    await chat(page, `one ${stamp}`);
    await send(page, `two ${stamp}`);
    await expect(storedReplies(page)).toHaveCount(2);
    const firstId = await storedReplies(page).first().getAttribute("data-message-id");

    await storedReplies(page).first().hover();
    await storedReplies(page).first().getByRole("button", { name: "Regenerate" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Regenerate this reply?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(storedReplies(page)).toHaveCount(2);

    await storedReplies(page).first().hover();
    await storedReplies(page).first().getByRole("button", { name: "Regenerate" }).click();
    await confirm.getByRole("button", { name: "Regenerate" }).click();
    // Later messages go with the replaced reply (contracts §4.2).
    await expect(storedReplies(page)).toHaveCount(1);
    await expect(users(page)).toHaveCount(1);
    await expect(storedReplies(page).first()).toContainText(`Echo: one ${stamp}`);
    await expect(storedReplies(page).first()).not.toHaveAttribute("data-message-id", firstId ?? "");

    await send(page, `three ${stamp}`);
    await expect(storedReplies(page)).toHaveCount(2);
    const firstTurn = users(page).first();
    await firstTurn.hover();
    await firstTurn.getByRole("button", { name: "Delete message" }).click();
    await page
      .getByRole("alertdialog", { name: "Delete this message?" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(users(page)).toHaveCount(1);
    await expect(users(page).first()).toContainText(`three ${stamp}`);
    await expect(storedReplies(page)).toHaveCount(1);
    await page.reload();
    await expect(users(page)).toHaveCount(1);
  });

  test("actions that change history hide while a reply streams", async ({ page }) => {
    await chat(page, `idle ${String(Date.now())}`);
    await chooseModel(page, "mock-slow");
    await send(page, "slow one");
    await page.getByTestId("live-reply").waitFor();
    const firstTurn = users(page).first();
    await firstTurn.hover();
    await expect(firstTurn.getByRole("button", { name: "Edit message" })).toBeHidden();
    await expect(firstTurn.getByRole("button", { name: "Copy message" })).toBeVisible();
    await page.getByRole("button", { name: "Stop generating" }).click();
    await expect(page.getByTestId("live-reply")).toHaveCount(0);
    await firstTurn.hover();
    await expect(firstTurn.getByRole("button", { name: "Edit message" })).toBeVisible();
  });
});

test.describe("Phase 13a: search and pins", () => {
  test("search finds a message, opens the chat at it and marks the match", async ({ page }) => {
    const word = `zebra${String(Date.now())}`;
    const id = await chat(page, `the ${word} crossed`);
    await page.goto(`${base()}/chat/new`);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Search chats" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("combobox", { name: "Search chats and files" });
    await expect(input).toBeFocused();
    await input.fill(word);
    const option = dialog.getByRole("option").first();
    await expect(option).toContainText(word);
    await expect(option.locator("mark")).toHaveText(word);
    await input.press("Enter");
    await page.waitForURL(new RegExp(`/chat/${id}$`));
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const h = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights;
          return h?.get("chatui-search")?.size ?? 0;
        }),
      )
      .toBeGreaterThan(0);

    // The sidebar button opens it too; no results is a status, not an error.
    await page.getByRole("button", { name: "Search chats (Ctrl+K)" }).click();
    await dialog.getByRole("combobox").fill(`nothing-${word}-nothing`);
    await expect(dialog.getByRole("status")).toContainText("No results");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("pinning moves a chat into Pinned and survives a reload; unpin returns it", async ({
    page,
  }) => {
    const title = `pin me ${String(Date.now())}`;
    await chat(page, title);
    const pinned = page.getByTestId("pinned-list");
    await expect(pinned).toHaveCount(0);
    await page.getByRole("button", { name: "Chat options" }).click();
    await page.getByRole("menuitem", { name: "Pin" }).click();
    await expect(pinned.getByRole("link", { name: title })).toBeVisible();
    await expect(
      page.getByTestId("conversation-list").getByRole("link", { name: title }),
    ).toHaveCount(0);
    await page.reload();
    await expect(pinned.getByRole("link", { name: title })).toBeVisible();

    // Pinned folds like Recents.
    await page.getByRole("button", { name: "Pinned" }).click();
    await expect(pinned).toBeHidden();
    await page.getByRole("button", { name: "Pinned" }).click();

    await page.getByRole("button", { name: `Options for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Unpin" }).click();
    await expect(pinned).toHaveCount(0);
    await expect(
      page.getByTestId("conversation-list").getByRole("link", { name: title }),
    ).toBeVisible();
  });
});

test.describe("Phase 13a: clear history", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Delete all chats removes every chat and keeps settings", async ({ page }) => {
    await signInWithForm(page, "/chat/new", E2E_OTHER_USER);
    await chooseModel(page, "mock-chat");
    await send(page, "to be cleared");
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(storedReplies(page).last()).toContainText("Echo: to be cleared");
    await page.goto(`${base()}/settings/data`);
    await page.getByRole("button", { name: "Delete all", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Delete all chats?" })
      .getByRole("button", { name: "Delete all" })
      .click();
    await page.waitForURL(/\/chat\/new$/);
    await expect(page.getByTestId("conversation-list").getByRole("link")).toHaveCount(0);
  });
});

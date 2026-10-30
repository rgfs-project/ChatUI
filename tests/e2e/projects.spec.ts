import { expect, test } from "@playwright/test";
import { chooseModel, send, signIn, storedReplies } from "./helpers.ts";

test("projects: create, move a chat in from its menu and the slash menu, rename, delete", async ({
  page,
}) => {
  const stamp = String(Date.now());
  const title = `project chat ${stamp}`;
  await signIn(page);
  await chooseModel(page, "mock-chat");
  await send(page, title);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(storedReplies(page).last()).toContainText(`Echo: ${title}`);

  // New project from the sidebar.
  await page.getByTestId("project-list").getByRole("button", { name: "New project" }).click();
  const nameDialog = page.getByRole("dialog", { name: "New project" });
  await nameDialog.getByRole("textbox", { name: "Project name" }).fill(`Trip ${stamp}`);
  await nameDialog.getByRole("button", { name: "Create" }).click();
  const project = page.getByTestId("project").filter({ hasText: `Trip ${stamp}` });
  await expect(project).toBeVisible();

  // Move the chat in from its row menu.
  await page
    .getByRole("button", { name: `Options for ${title}` })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Move to project…" }).click();
  await page
    .getByRole("dialog", { name: "Move to project" })
    .getByRole("button", { name: `Trip ${stamp}` })
    .click();
  // It lives under the project (unfolded: it is the open chat), not in Recents.
  await expect(project.getByRole("link", { name: title })).toBeVisible();
  await expect(
    page.getByTestId("conversation-list").getByRole("link", { name: title }),
  ).toHaveCount(0);
  await page.reload();
  await expect(project.getByRole("link", { name: title })).toBeVisible();

  // The slash menu offers it too: move it out.
  await page.locator("#message").fill("/move");
  await page.getByRole("option", { name: /Move to project/ }).click();
  const move = page.getByRole("dialog", { name: "Move to project" });
  await move.getByRole("button", { name: "Remove from project" }).click();
  await expect(
    page.getByTestId("conversation-list").getByRole("link", { name: title }),
  ).toBeVisible();

  // Rename, then delete the project: chats stay.
  await project.locator(".project-row").hover();
  await page.getByRole("button", { name: `Options for project Trip ${stamp}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename project" });
  await rename.getByRole("textbox", { name: "Project name" }).fill(`Rome ${stamp}`);
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByTestId("project").filter({ hasText: `Rome ${stamp}` })).toBeVisible();
  const renamed = page.getByTestId("project").filter({ hasText: `Rome ${stamp}` });
  await renamed.locator(".project-row").hover();
  await page.getByRole("button", { name: `Options for project Rome ${stamp}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete this project?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByTestId("project").filter({ hasText: `Rome ${stamp}` })).toHaveCount(0);
  await expect(
    page.getByTestId("conversation-list").getByRole("link", { name: title }),
  ).toBeVisible();
});

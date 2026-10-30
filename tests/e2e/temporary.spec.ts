import { expect, test } from "@playwright/test";
import { base, chooseModel, send, signIn, storedReplies } from "./helpers.ts";

test("a temporary chat is not listed, says so, and is gone once you leave it", async ({ page }) => {
  const words = `temporary ${String(Date.now())}`;
  await signIn(page);
  const toggle = page.getByRole("button", { name: "Temporary chat" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("temporary-intro")).toContainText("deleted when you leave it");
  await chooseModel(page, "mock-chat");
  await send(page, words);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(storedReplies(page).last()).toContainText(`Echo: ${words}`);
  const url = page.url();
  await expect(page.getByTestId("temporary-badge")).toBeVisible();
  await expect(
    page.getByTestId("conversation-list").getByRole("link", { name: words }),
  ).toHaveCount(0);
  // Its menu has no Pin.
  await page.getByRole("button", { name: "Chat options" }).click();
  await expect(page.getByRole("menuitem", { name: "Pin" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Leaving deletes it.
  const deleted = page.waitForResponse(
    (res) => res.request().method() === "DELETE" && res.url().includes("/api/conversations/"),
  );
  await page.getByTestId("new-chat").click();
  await page.waitForURL(/\/chat\/new$/);
  expect((await deleted).status()).toBe(200);
  // The next new chat is a normal one again.
  await expect(page.getByRole("button", { name: "Temporary chat" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.goto(url);
  await expect(page.getByText("This conversation does not exist.")).toBeVisible();
  expect(new URL(url).origin).toBe(new URL(base() || url).origin);
});

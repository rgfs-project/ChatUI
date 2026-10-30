import { expect, test, type Page } from "@playwright/test";
import { chooseModel, hydrated, signIn, storedReplies } from "./helpers.ts";

/** Phase 15, INV-48: the native composer under real browser input. */

async function pasteData(page: Page, data: Record<string, string>) {
  await page.evaluate((entries) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(entries)) transfer.setData(type, value);
    document
      .getElementById("message")
      ?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
  }, data);
}

test("rapid Enter and Send clicks store one message", async ({ page }) => {
  await signIn(page);
  await chooseModel(page, "mock-chat");
  const message = page.locator("#message");
  await message.fill("only once please");
  // Two Enters and a click in one task, before React can re-render.
  await message.evaluate((el) => {
    for (let i = 0; i < 2; i++)
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click();
  });
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(storedReplies(page)).toHaveCount(1);
  await page.reload();
  await hydrated(page);
  await expect(page.getByTestId("message-user")).toHaveCount(1);
  await expect(page.getByTestId("message-user")).toContainText("only once please");
});

test("focus stays in the composer while a reply streams and after it ends", async ({ page }) => {
  await signIn(page);
  await chooseModel(page, "mock-slow");
  const message = page.locator("#message");
  await message.fill("stream for me");
  await message.press("Enter");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await expect(message).toBeFocused();
  // Typing the next message during the stream is kept.
  await page.keyboard.type("next ");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
  await expect(message).toBeFocused();
  await expect(message).toHaveValue("next ");
});

test("rich text pastes as Markdown and can be undone; plain text pastes as is", async ({
  page,
}) => {
  await signIn(page);
  const message = page.locator("#message");
  await message.focus();
  await pasteData(page, {
    "text/html":
      "<h3>Steps</h3><ol><li>Open <b>Settings</b></li><li>See <a href='https://example.com'>docs</a></li></ol><script>window.pwned=1</script>",
    "text/plain": "Steps Open Settings See docs",
  });
  await expect(message).toHaveValue(
    "### Steps\n\n1. Open **Settings**\n2. See [docs](https://example.com)",
  );
  expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
  // Inserted through the editing commands, so the browser's undo removes it.
  await page.keyboard.press("Control+z");
  await expect(message).toHaveValue("");
  // Plain text is left to the browser: the event is not cancelled.
  const cancelled = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "plain");
    const event = new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    document.getElementById("message")?.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(cancelled).toBe(false);
});

test("the composer's controls have names and roles (screen-reader smoke)", async ({ page }) => {
  await signIn(page);
  const form = page.getByRole("form", { name: "Message composer" });
  const snapshot = await form.ariaSnapshot();
  expect(snapshot).toContain('button "Composer options"');
  expect(snapshot).toContain('textbox "Message"');
  expect(snapshot).toContain('button "Send" [disabled]');
  // Chromium has speech recognition: dictation is a toggle button.
  await expect(page.getByRole("button", { name: "Dictate" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("Enter that ends an IME composition does not send", async ({ page }) => {
  await signIn(page);
  await chooseModel(page, "mock-chat");
  const message = page.locator("#message");
  await message.focus();
  await message.evaluate((el) => {
    const seen: { key: string; composing: boolean }[] = [];
    (window as { imeKeys?: typeof seen }).imeKeys = seen;
    el.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      seen.push({ key: e.key, composing: e.isComposing });
    });
  });
  // A real composition in Chromium's input pipeline, then Enter to commit it.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
  });
  await cdp.send("Input.insertText", { text: "にほん" });
  const keys = await page.evaluate(
    () => (window as { imeKeys?: { key: string; composing: boolean }[] }).imeKeys ?? [],
  );
  expect(keys).toContainEqual({ key: "Enter", composing: true });
  await expect(message).toHaveValue("にほん");
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe("/chat/new");
  await expect(page.getByTestId("message-user")).toHaveCount(0);
  // A plain Enter afterwards sends.
  await message.press("Enter");
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
});

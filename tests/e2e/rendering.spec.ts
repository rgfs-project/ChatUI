import { expect, test } from "@playwright/test";
import { longChat, signIn, storedReplies } from "./helpers.ts";

test("replies render math as MathML, highlight code, and offer table and speech tools", async ({
  page,
}) => {
  const lazy: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/assets/")) lazy.push(request.url());
  });
  await signIn(page, `/chat/${longChat()}`);
  const reply = storedReplies(page).filter({ hasText: "Inline" }).last();
  // MathML (native rendering, no KaTeX fonts or stylesheet requested).
  await expect(reply.locator("math")).toHaveCount(2);
  expect(lazy.some((url) => /katex.*\.(css|woff2?)$/i.test(url))).toBe(false);
  await expect(reply).toContainText("$5 and $10");
  await expect(reply.getByRole("button", { name: "Copy LaTeX" })).toBeVisible();
  // Highlighting arrived lazily.
  await expect(reply.locator(".hljs-keyword").first()).toHaveText("const");
  // Table tools on hover, Expand opens the table in a dialog.
  await reply.locator(".table-block").hover();
  await reply.getByRole("button", { name: "Expand table" }).click();
  const dialog = page.getByRole("dialog", { name: "Table" });
  await expect(dialog.locator("table")).toBeVisible();
  await page.keyboard.press("Escape");
  // Read aloud is offered (Chromium has speech synthesis).
  await reply.hover();
  await expect(reply.getByRole("button", { name: "Read aloud" })).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { longChat, signIn, storedReplies } from "./helpers.ts";

test("replies render math as MathML, highlight code, and offer speech", async ({ page }) => {
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
  // Tables are plain: no copy or expand buttons.
  await expect(reply.locator("table")).toBeVisible();
  await expect(reply.getByRole("button", { name: /table/i })).toHaveCount(0);
  // Read aloud is offered (Chromium has speech synthesis).
  await reply.hover();
  await expect(reply.getByRole("button", { name: "Read aloud" })).toBeVisible();
});

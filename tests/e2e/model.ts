import type { Page } from "@playwright/test";

/** Chooses a model in the composer's model menu (`value`: the JSON provider/model pair). */
export async function chooseModel(page: Page, value: string) {
  await page.getByRole("button", { name: /^Model: / }).click();
  const item = page.locator(`[data-model='${value}']`);
  await item.click();
  // Choosing closes the menu.
  await item.waitFor({ state: "detached" });
}

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_MEMORY_USER, TOOLS_PROVIDER } from "./global-setup.ts";
import { chooseModel } from "./model.ts";

/** Phase 13b: memory suggestions and Settings → Memories in the browser. */

const base = () => process.env.E2E_BASE_URL ?? "";
const TOOLS = JSON.stringify([TOOLS_PROVIDER, "mock-tools"]);
const SHOTS = path.resolve(import.meta.dirname, "../../docs/phase-reports/phase-13b");

async function hydrated(page: Page) {
  await page.waitForSelector('html[data-hydrated="true"]');
}

async function sendWithTools(page: Page, text: string) {
  await page.goto(`${base()}/chat/new`);
  await hydrated(page);
  await chooseModel(page, TOOLS);
  await page.locator("#message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

async function openMemories(page: Page) {
  await page.goto(`${base()}/settings`);
  await hydrated(page);
  await page.getByRole("button", { name: "Memories" }).click();
  await expect(page.getByRole("heading", { name: "Memories", level: 2 })).toBeVisible();
}

test.describe("memory suggestions (INV-37)", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_MEMORY_USER)).cookies);
  });

  test("a suggestion is saved only when the user saves it, then appears in Settings", async ({
    page,
  }) => {
    await sendWithTools(page, "I like green tea [[create Drink|Prefers green tea]]");
    const reply = page.getByTestId("message-assistant").last();
    await expect(reply).toContainText("Continued after 1 result(s).", { timeout: 20_000 });
    const card = reply.getByTestId("memory-suggestion");
    await expect(card).toContainText("Remember “Drink”");
    await expect(card).toContainText("Prefers green tea");
    // Nothing is saved yet.
    const before = await page.request.get(`${base()}/api/memories`);
    expect(((await before.json()) as { memories: unknown[] }).memories).toEqual([]);
    mkdirSync(SHOTS, { recursive: true });
    await page.getByTestId("transcript").screenshot({ path: path.join(SHOTS, "suggestion.png") });
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card).toContainText("Saved to memory");
    await openMemories(page);
    const row = page.getByTestId("memory-row").filter({ hasText: "Drink" });
    await expect(row).toContainText("Prefers green tea");
    await page.screenshot({ path: path.join(SHOTS, "settings.png") });
  });

  test("Dismiss works from the keyboard", async ({ page }) => {
    await sendWithTools(page, "[[create Plant|Has a fern]]");
    const card = page.getByTestId("memory-suggestion").last();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Enter");
    await expect(card).toContainText("Dismissed");
    await expect(
      page.getByRole("status").filter({ hasText: "Suggestion dismissed" }),
    ).toBeAttached();
  });

  test("an empty answer says it wasn’t generated and offers regenerate", async ({ page }) => {
    await sendWithTools(page, "[[calls-only]] [[reject-continuation]] [[create Bike|Red]]");
    const note = page.getByTestId("answer-not-generated");
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("memory-suggestion")).toContainText("Remember “Bike”");
    await note.getByRole("button", { name: "Regenerate" }).click();
    await expect(page.getByRole("dialog")).toContainText("The current reply will be replaced.");
  });
});

test.describe("Settings → Memories", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_MEMORY_USER)).cookies);
  });

  test("create, edit and delete a memory", async ({ page }) => {
    await openMemories(page);
    await page.getByRole("button", { name: /^Add a memory$/ }).click();
    await page.getByLabel("Name").fill("Editor");
    await page.getByLabel("Note").fill("Uses Vim");
    await page.getByRole("button", { name: "Save" }).click();
    const row = page.getByTestId("memory-row").filter({ hasText: "Editor" });
    await expect(row).toContainText("Uses Vim");
    await row.getByRole("button", { name: "Edit Editor" }).click();
    await page.getByLabel("Note").fill("Uses Helix");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(row).toContainText("Uses Helix");
    await row.getByRole("button", { name: "Edit Editor" }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("memory-row").filter({ hasText: "Editor" })).toHaveCount(0);
  });
});

test.describe("memory suggestions on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser, E2E_MEMORY_USER)).cookies);
  });

  test("Save and Dismiss are 44 px touch targets", async ({ page }) => {
    await sendWithTools(page, "[[create Phone|Pixel]]");
    const card = page.getByTestId("memory-suggestion").last();
    await expect(card).toBeVisible({ timeout: 20_000 });
    for (const name of ["Save", "Dismiss"]) {
      const box = await card.getByRole("button", { name }).boundingBox();
      expect(box && box.width >= 44 && box.height >= 44, name).toBe(true);
    }
  });
});

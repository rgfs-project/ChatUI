import { expect, test } from "@playwright/test";
import { base, chooseModel, hydrated, send, signIn, storedReplies } from "./helpers.ts";

const BLOCK = [
  "```ui",
  "callout tip Stretch first.",
  "tabs",
  "  tab Easy",
  "    text Walk for ten minutes.",
  "  tab Hard",
  "    text Run for ten minutes.",
  "quiz Two plus two?",
  "  option Three",
  "  option* Four",
  "chart bar Minutes",
  "  Mon = 10",
  "  Tue = 20",
  "```",
].join("\n");

test("a ui block renders without any request, works by keyboard, and turns off in Settings", async ({
  page,
}) => {
  const outside: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(base() || "http://127.0.0.1")) outside.push(request.url());
  });
  await signIn(page);
  await chooseModel(page, "mock-chat");
  await send(page, `Plan:\n${BLOCK}`);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  const reply = storedReplies(page).last();
  const block = reply.getByTestId("ui-block");
  await expect(block).toContainText("Stretch first.");
  await block.getByRole("tab", { name: "Easy" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(block.getByRole("tab", { name: "Hard" })).toBeFocused();
  await expect(block.getByRole("tabpanel")).toHaveText("Run for ten minutes.");
  await block.getByRole("radio", { name: "Four" }).check();
  await block.getByRole("button", { name: "Check" }).click();
  await expect(block.getByRole("status")).toHaveText("Correct.");
  await expect(block.getByRole("img", { name: "Minutes" })).toBeVisible();
  expect(outside).toEqual([]);

  // The reasoning is labelled with its duration; reply actions are there.
  await expect(reply.getByTestId("reasoning").locator("summary")).toHaveText(/^Thought/);
  await reply.hover();
  const good = reply.getByRole("button", { name: "Good response" });
  await good.click();
  await expect(good).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(
    storedReplies(page).last().getByRole("button", { name: "Good response" }),
  ).toHaveAttribute("aria-pressed", "true");
  await storedReplies(page).last().hover();
  await storedReplies(page).last().getByRole("button", { name: "More actions" }).click();
  await expect(page.getByText("Answered by mock-chat")).toBeVisible();
  await page.keyboard.press("Escape");

  // Off: the block is shown as its source.
  const chatUrl = page.url();
  await page.goto(`${base()}/settings/appearance`);
  await hydrated(page);
  await page.getByRole("switch", { name: "Interactive blocks" }).uncheck();
  await page.goto(chatUrl);
  await expect(storedReplies(page).last().getByTestId("ui-block")).toHaveCount(0);
  await expect(storedReplies(page).last()).toContainText("callout tip Stretch first.");
  await page.goto(`${base()}/settings/appearance`);
  await hydrated(page);
  await page.getByRole("switch", { name: "Interactive blocks" }).check();
});

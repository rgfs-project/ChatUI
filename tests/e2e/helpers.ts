import { expect, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_USER } from "./global-setup.ts";

export const base = (): string => process.env.E2E_BASE_URL ?? "";
export const longChat = (): string => process.env.E2E_LONG_CHAT ?? "";

export async function hydrated(page: Page): Promise<void> {
  await page.waitForSelector('html[data-hydrated="true"]');
}

/** Opens a page with the run's shared signed-in session and waits for hydration. */
export async function signIn(page: Page, path = "/chat/new"): Promise<void> {
  await page.goto(`${base()}${path}`);
  expect(new URL(page.url()).pathname).toBe(path);
  await hydrated(page);
}

/** Signs in through the real form (tests that start signed out). */
export async function signInWithForm(
  page: Page,
  returnTo = "/chat/new",
  user = E2E_USER,
): Promise<void> {
  await page.goto(`${base()}/login?returnTo=${encodeURIComponent(returnTo)}`);
  await hydrated(page);
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === returnTo);
  await hydrated(page);
}

/** Picks a model in the header model menu by id. */
export async function chooseModel(page: Page, modelId: string): Promise<void> {
  await page.getByTestId("model-picker").first().click();
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Items may carry a detail ("Not loaded") after the id.
  await page.getByRole("menuitemradio", { name: new RegExp(`^${escaped}(\\s|$)`) }).click();
}

export async function send(page: Page, text: string): Promise<void> {
  await page.locator("#message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

export const storedReplies = (page: Page) => page.getByTestId("message-assistant");

export interface ScrollState {
  top: number;
  max: number;
}

export function scrollState(page: Page): Promise<ScrollState> {
  return page.evaluate(() => {
    const el = document.getElementById("transcript-scroller");
    if (!el) throw new Error("no transcript scroller");
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
}

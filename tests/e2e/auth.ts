import type { Browser, BrowserContext } from "@playwright/test";
import { E2E_PASSWORD, E2E_USER } from "./global-setup.ts";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * One real browser sign-in per account per run, reused through Playwright's
 * storage state: login is rate limited (10 per 15 min per address/username).
 */
const states = new Map<string, StorageState>();

export async function signedInState(browser: Browser, username = E2E_USER): Promise<StorageState> {
  const cached = states.get(username);
  if (cached) return cached;
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`${process.env.E2E_BASE_URL ?? ""}/login?returnTo=%2Fchat`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/chat\/new$/);
  const state = await context.storageState();
  await context.close();
  states.set(username, state);
  return state;
}

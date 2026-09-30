import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext } from "@playwright/test";
import { E2E_PASSWORD, E2E_USER } from "./global-setup.ts";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * One real browser sign-in per account per run, reused through Playwright's
 * storage state: login is rate limited (10 per 15 min per address/username).
 * States are also kept on disk for the run, so a worker restarted after a
 * failure reuses them instead of signing in again.
 */
const states = new Map<string, StorageState>();

function stateFile(username: string): string | null {
  const dir = process.env.E2E_STATE_DIR;
  return dir ? path.join(dir, `${username}.json`) : null;
}

export async function signedInState(browser: Browser, username = E2E_USER): Promise<StorageState> {
  const cached = states.get(username);
  if (cached) return cached;
  const file = stateFile(username);
  if (file && existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as StorageState;
    states.set(username, stored);
    return stored;
  }
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
  if (file) writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  return state;
}

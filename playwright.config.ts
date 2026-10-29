import { defineConfig, devices } from "@playwright/test";
import { E2E_AUTH_STATE } from "./tests/e2e/global-setup.ts";

/** Browser E2E suite (Phase 6): production build, mock provider, temporary DATA_DIR. */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  // Tests start signed in (one login per run); sign-in flows opt out per test.
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure", storageState: E2E_AUTH_STATE },
});

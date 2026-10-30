import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2E_USER } from "./global-setup.ts";
import { chooseModel, hydrated, longChat, send, signIn, storedReplies } from "./helpers.ts";

const SENTINEL = "SENTINEL-PRIVATE-9f2c";

/** A route module's own chunk, from the production build manifest (names can collide). */
function manifestChunk(key: string): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../build/client/.vite/manifest.json", import.meta.url), "utf8"),
  ) as Record<string, { file: string }>;
  const entry = manifest[key];
  if (!entry) throw new Error(`no chunk for ${key}`);
  return `/${entry.file}`;
}

const routeChunk = (route: string) =>
  manifestChunk(`app/routes/${route}.tsx?__react-router-build-client-route`);

test("performance marks fire once, compute ComposerTTI and FirstAssistantEvent, carry no content", async ({
  page,
}) => {
  await signIn(page);
  await chooseModel(page, "mock-chat");
  await send(page, `measure ${SENTINEL}`);
  await expect(storedReplies(page).last()).toContainText(SENTINEL);
  const result = await page.evaluate(() => {
    const entries = performance
      .getEntriesByType("mark")
      .filter((e) => e.name.startsWith("chatui:"))
      .map((e) => ({ name: e.name, detail: (e as PerformanceMark).detail as unknown }));
    const summary = (window as unknown as { __chatuiPerf: () => unknown }).__chatuiPerf();
    return { entries, summary };
  });
  const names = result.entries.map((e) => e.name);
  for (const name of [
    "chatui:navigation-start",
    "chatui:hydration-complete",
    "chatui:composer-interactive",
    "chatui:generation-accepted",
    "chatui:first-assistant-event",
    "chatui:generation-complete",
  ]) {
    expect(names.filter((n) => n === name)).toHaveLength(1);
  }
  const summary = result.summary as {
    composerTTI: number | null;
    firstAssistantEvent: number | null;
  };
  expect(summary.composerTTI).toBeGreaterThan(0);
  expect(summary.firstAssistantEvent).toBeGreaterThanOrEqual(0);
  const serialized = JSON.stringify(result.entries);
  expect(serialized).not.toContain(SENTINEL);
  expect(serialized).not.toContain(E2E_USER);
  expect(serialized).not.toContain("/chat/");
});

test("secondary route chunks load on demand, and a failed chunk recovers", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });
  const settingsChunk = routeChunk("settings");
  await signIn(page, `/chat/${longChat()}`);
  expect(scripts).not.toContain(settingsChunk);
  expect(scripts).not.toContain(routeChunk("admin"));
  // The image viewer (Phase 12) loads only when an image is opened.
  expect(scripts).not.toContain(manifestChunk("app/chat/image-viewer.tsx"));
  // First attempt at the Settings chunk fails: the app still gets there.
  let failed = false;
  await page.route(`**${settingsChunk}`, async (route) => {
    if (!failed) {
      failed = true;
      await route.abort();
      return;
    }
    await route.continue();
  });
  const openSettings = async () => {
    await page.getByRole("button", { name: /^Account:/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
  };
  await openSettings();
  // React Router answers a failed route chunk by reloading the current page:
  // the app is intact (no broken half-navigation) and Settings opens next time.
  await expect.poll(() => failed).toBe(true);
  await page.waitForLoadState("load");
  await hydrated(page);
  if (!(await page.getByRole("dialog", { name: "Settings" }).isVisible())) await openSettings();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(scripts).toContain(settingsChunk);
});

test("hover prefetches one conversation; the click reuses it", async ({ page }) => {
  await signIn(page);
  const gets: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === `/api/conversations/${longChat()}`)
      gets.push(url.pathname);
  });
  const row = page
    .getByTestId("conversation-list")
    .getByRole("link", { name: "Seeded long conversation" });
  await row.hover();
  await expect.poll(() => gets.length).toBe(1);
  await page.waitForTimeout(300);
  await row.click();
  await page.waitForURL(new RegExp(`/chat/${longChat()}$`));
  await hydrated(page);
  await expect(page.getByText("needle-99", { exact: false })).toBeVisible();
  expect(gets).toHaveLength(1);
});

/**
 * Deterministic before/after trace (Phase 9). Starts the production server
 * against the paced mock provider with the seeded 200-message conversation
 * (the E2E fixture), then cold-loads /chat/<long> in Chromium under fixed CPU
 * and network throttling and records, per run:
 *   server TTFB, first contentful paint (the server-rendered shell),
 *   DOMContentLoaded, hydration complete, composer interactive, and the send
 *   path: send → 202 → first assistant event → first painted content.
 * Uses the app's `chatui:*` performance marks when present and DOM
 * observation otherwise (so the same tool measures older builds).
 *
 * Usage: npm run build && node scripts/perf-trace.ts [runs=5]
 */
import { chromium, type BrowserContext } from "@playwright/test";
import globalSetup, {
  E2E_PASSWORD,
  E2E_USER,
  LONG_CONVERSATION,
} from "../tests/e2e/global-setup.ts";

const RUNS = Number(process.argv[2] ?? 5);
const CPU_SLOWDOWN = 4;
const NETWORK = { latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 };

interface Run {
  ttfb: number;
  fcp: number;
  domContentLoaded: number;
  hydrated: number;
  composerInteractive: number;
  jsBytes: number;
  cssBytes: number;
  sendToAccepted: number;
  acceptedToFirstEvent: number;
  firstEventToPaint: number;
  marks: Record<string, number>;
}

const OBSERVER = () => {
  const w = window as unknown as { __trace: Record<string, number> };
  w.__trace = {};
  const note = (name: string) => {
    w.__trace[name] ??= performance.now();
  };
  // The Send button: icon-only with an accessible name, or text in older builds.
  const isSend = (b: HTMLButtonElement) =>
    b.getAttribute("aria-label") === "Send" || b.textContent.trim() === "Send";
  document.addEventListener(
    "click",
    (event) => {
      const button = (event.target as Element | null)?.closest("button");
      if (button && isSend(button)) note("sendClick");
    },
    true,
  );
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === "first-contentful-paint") note("fcp");
  }).observe({ type: "paint", buffered: true });
  const check = () => {
    if (document.documentElement.dataset.hydrated === "true") note("hydrated");
    const send = [...document.querySelectorAll("button")].find(isSend);
    if (w.__trace.hydrated && send && !send.disabled) note("composerInteractive");
    const content = document.querySelector('[data-testid="content"]');
    if (content?.textContent.trim()) note("firstPaintedContent");
  };
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
};

async function signedIn(base: string, browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/login?returnTo=%2Fchat`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.locator("#username").fill(E2E_USER);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/chat\/new$/);
  const state = await context.storageState();
  await context.close();
  return state;
}

async function oneRun(context: BrowserContext, base: string): Promise<Run> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, ...NETWORK });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  await page.addInitScript(OBSERVER);
  await page.goto(`${base}/chat/${LONG_CONVERSATION}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window as unknown as { __trace: Record<string, number> }).__trace.composerInteractive,
    undefined,
    { timeout: 120_000 },
  );
  // The send path, with the throttling removed so only app work is measured.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await page.locator("#model").selectOption(JSON.stringify(["local", "mock-chat"]));
  await page.locator("#message").fill("perf trace message");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(
    () => (window as unknown as { __trace: Record<string, number> }).__trace.firstPaintedContent,
  );
  const result = await page.evaluate(() => {
    const t = (window as unknown as { __trace: Record<string, number> }).__trace;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const bytes = (ext: RegExp) =>
      resources.filter((r) => ext.test(r.name)).reduce((n, r) => n + r.encodedBodySize, 0);
    const marks = Object.fromEntries(
      performance
        .getEntriesByType("mark")
        .filter((m) => m.name.startsWith("chatui:"))
        .map((m) => [m.name, Math.round(m.startTime)]),
    );
    return {
      ttfb: nav.responseStart,
      fcp: t.fcp ?? NaN,
      domContentLoaded: nav.domContentLoadedEventEnd,
      hydrated: t.hydrated ?? NaN,
      composerInteractive: t.composerInteractive ?? NaN,
      firstPaintedContent: t.firstPaintedContent ?? NaN,
      sendClick: t.sendClick ?? NaN,
      accepted:
        (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find((r) =>
          r.name.endsWith("/api/generations"),
        )?.responseEnd ?? NaN,
      jsBytes: bytes(/\.js(\?|$)/),
      cssBytes: bytes(/\.css(\?|$)/),
      marks,
    };
  });
  // First assistant event: the app mark when present, else first painted content.
  const firstEvent = result.marks["chatui:first-assistant-event"] ?? result.firstPaintedContent;
  const acceptedAt = result.accepted;
  const sendAt = result.sendClick;
  await page.close();
  return {
    ttfb: result.ttfb,
    fcp: result.fcp,
    domContentLoaded: result.domContentLoaded,
    hydrated: result.hydrated,
    composerInteractive: result.composerInteractive,
    jsBytes: result.jsBytes,
    cssBytes: result.cssBytes,
    sendToAccepted: acceptedAt - sendAt,
    acceptedToFirstEvent: firstEvent - acceptedAt,
    firstEventToPaint: result.firstPaintedContent - firstEvent,
    marks: result.marks,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? NaN)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const teardown = await globalSetup();
const base = process.env.E2E_BASE_URL ?? "";
const browser = await chromium.launch();
try {
  const state = await signedIn(base, browser);
  const runs: Run[] = [];
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext({ storageState: state });
    runs.push(await oneRun(context, base));
    await context.close();
  }
  const keys = [
    "ttfb",
    "fcp",
    "domContentLoaded",
    "hydrated",
    "composerInteractive",
    "sendToAccepted",
    "acceptedToFirstEvent",
    "firstEventToPaint",
    "jsBytes",
    "cssBytes",
  ] as const;
  const summary = Object.fromEntries(
    keys.map((k) => [k, Math.round(median(runs.map((r) => r[k])))]),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: "200-message conversation, mock provider (mock-chat, 30 ms/chunk)",
        throttling: { cpuSlowdown: CPU_SLOWDOWN, ...NETWORK },
        runs: RUNS,
        medianMs: summary,
        lastRunMarks: runs.at(-1)?.marks ?? {},
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
  await teardown();
}

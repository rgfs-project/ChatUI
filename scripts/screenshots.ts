/**
 * `node scripts/screenshots.ts`: regenerates the README screenshots in
 * docs/screenshots/ from a throwaway demo instance (account "john", the demo's
 * sample chats, the mock model). Needs a production build.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const PORT = "3917";
const ORIGIN = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "chatui-shots-"));

const demo = spawn(process.execPath, ["scripts/demo.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT, DEMO_DATA_DIR: dataDir, DEMO_USER: "john" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise<void>((resolve, reject) => {
  demo.stdout.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("Ctrl+C")) resolve();
  });
  demo.once("exit", () => {
    reject(new Error("the demo exited early"));
  });
});
// The demo prints its banner before the server listens: wait for an answer.
for (let i = 0; ; i++) {
  if (
    await fetch(`${ORIGIN}/login`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  if (i > 100) throw new Error("the demo server did not start");
  await new Promise((r) => setTimeout(r, 200));
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/login`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.locator("#username").fill("john");
  await page.locator("#password").fill("demo password 1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/chat"));
  await page.waitForSelector('html[data-hydrated="true"]');
}

async function openChat(page: Page, title: string): Promise<void> {
  await page.getByRole("link", { name: title }).first().click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await page.waitForTimeout(800);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await signIn(page);
    if (scheme === "dark") {
      await page.goto(`${ORIGIN}/settings/appearance`);
      await page.waitForSelector('html[data-hydrated="true"]');
      await page.locator('input[name="theme"][value="dark"]').check({ force: true });
      await page.goto(`${ORIGIN}/chat/new`);
      await page.waitForSelector('html[data-hydrated="true"]');
    }
    await openChat(page, "Plan a Sunday roast for friends");
    await page.screenshot({ path: path.join(OUT, `chat-${scheme}.png`) });
    if (scheme === "light") {
      await openChat(page, "Here is a Python greeting script");
      await page.screenshot({ path: path.join(OUT, "code.png") });
    }
    await context.close();
  }
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
  });
  const page = await phone.newPage();
  await signIn(page);
  await page.goto(`${ORIGIN}/chat/new`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await page
    .getByRole("button", { name: /menu|chats|sidebar/i })
    .first()
    .click();
  await page.getByRole("link", { name: "Help me pack for a weekend hiking trip" }).first().click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  // A fresh load leaves no focus ring or tooltip on the sidebar button.
  await page.reload();
  await page.waitForSelector('html[data-hydrated="true"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "phone.png") });
  await phone.close();
} finally {
  await browser.close();
  demo.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
}
process.stdout.write(`screenshots written to ${path.relative(ROOT, OUT)}/\n`);

import { expect, test } from "@playwright/test";
import { makePng } from "../support/media.ts";
import { base, chooseModel, hydrated, send, signIn, storedReplies } from "./helpers.ts";

/** Phase 16: what the browser can observe. */

test("performance marks and diagnostics carry no message text, file names, users or tokens", async ({
  page,
}) => {
  const SENTINEL_TEXT = "sentinel-perf-text-5c2e";
  const SENTINEL_FILE = "sentinel-perf-file-91aa.png";
  const consoleLines: string[] = [];
  page.on("console", (message) => consoleLines.push(message.text()));
  await signIn(page);
  await chooseModel(page, "mock-vision");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: SENTINEL_FILE, mimeType: "image/png", buffer: makePng(16, 16) }]);
  await expect(page.locator('[data-testid="composer-file"][data-status="ready"]')).toHaveCount(1);
  await send(page, SENTINEL_TEXT);
  await expect(storedReplies(page)).toHaveCount(1);
  await expect(storedReplies(page)).toContainText("Echo");
  const observed = await page.evaluate(() => {
    const entries = performance
      .getEntries()
      .filter((e) => e.entryType === "mark" || e.entryType === "measure")
      .map((e) => ({ name: e.name, detail: (e as PerformanceMark).detail as unknown }));
    const summary = (window as { __chatuiPerf?: () => unknown }).__chatuiPerf?.();
    return JSON.stringify({ entries, summary });
  });
  expect(observed).toContain("chatui:");
  const session = await page.request.get(`${base()}/api/auth/session`);
  const { csrfToken, user } = (await session.json()) as {
    csrfToken: string;
    user: { username: string };
  };
  for (const secret of [SENTINEL_TEXT, SENTINEL_FILE, csrfToken, `"${user.username}"`])
    expect(observed, secret).not.toContain(secret);
  const cookies = await page.context().cookies();
  for (const cookie of cookies) expect(observed).not.toContain(cookie.value);
  expect(consoleLines.join("\n")).not.toContain(SENTINEL_TEXT);
});

test("the runtime is first-party only and registers no service worker", async ({ page }) => {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol !== "data:" &&
      url.protocol !== "blob:" &&
      url.origin !== new URL(base()).origin
    )
      foreign.push(request.url());
  });
  await signIn(page);
  await page.goto(`${base()}/settings/appearance`);
  await hydrated(page);
  await page.goto(`${base()}/library`);
  await hydrated(page);
  expect(foreign).toEqual([]);
  const workers = await page.evaluate(async () =>
    "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  );
  expect(workers).toBe(0);
});

test("malformed or hostile URLs get an error page or JSON error, never a server error", async ({
  page,
}) => {
  await signIn(page);
  for (const path of [
    "/chat/%E0%A4%A",
    "/%E0%A4%A",
    "/settings/%E0%A4%A",
    "/chat/..%2F..%2Fetc%2Fpasswd",
    "/chat/%3Cscript%3Ealert(1)%3C%2Fscript%3E",
  ]) {
    const res = await page.request.get(`${base()}${path}`, { maxRedirects: 0 });
    expect(res.status(), path).toBeLessThan(500);
    if (path.includes("%E0%A4%A")) expect(res.status(), path).toBe(400);
    const body = await res.text();
    expect(body, path).not.toContain("<script>alert(1)</script>");
    expect(body, path).not.toMatch(/\n\s+at |node_modules|\/home\//);
  }
  for (const path of ["/api/conversations/%E0%A4%A", "/api/attachments/%E0%A4%A/content"]) {
    const res = await page.request.get(`${base()}${path}`);
    expect(res.status(), path).toBe(400);
    expect(res.headers()["content-type"], path).toMatch(/^application\/json/);
  }
});

test("a title with a </script> payload is escaped in the server document and its bootstrap data", async ({
  page,
}) => {
  await signIn(page);
  await chooseModel(page, "mock-chat");
  await send(page, "title probe");
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(storedReplies(page)).toHaveCount(1);
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  const payload = `</script><script>window.pwned=1</script><!--`;
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Chat title" }).fill(payload);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog", { name: "Rename chat" })).toBeHidden();
  const html = await (await page.request.get(`${base()}/chat/${id}`)).text();
  expect(html).not.toContain("<script>window.pwned=1</script>");
  await page.reload();
  await hydrated(page);
  expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
  await expect(page.locator(".chat-header")).toContainText("</script>");
});

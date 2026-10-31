import { expect, test, type Page } from "@playwright/test";
import { base, chooseModel, hydrated, send, signIn, storedReplies } from "./helpers.ts";

/**
 * Phase 19, INV-51: a previewed file runs in an opaque-origin sandbox with no
 * network, no storage, no access to the page, and no way out of its frame.
 */

/** Every escape a hostile file tries; each writes its outcome into the frame's own page. */
const HOSTILE = `<!doctype html><title>attack</title><pre id="out"></pre><script>
const out = [];
const note = (name, fn) => { try { out.push(name + ":" + String(fn())); } catch (e) { out.push(name + ":blocked"); } };
note("cookie", () => document.cookie);
note("localStorage", () => localStorage.setItem("x", "1"));
note("parent", () => parent.document.title);
note("top", () => top.location.href);
note("open", () => window.open("https://example.com") === null ? "null" : "opened");
fetch("/api/conversations").then(() => out.push("fetch:ok"), () => out.push("fetch:blocked"))
  .finally(() => {
    try { parent.postMessage({ type: "chatui:forged", cookie: document.cookie }, "*"); out.push("post:sent"); } catch { out.push("post:blocked"); }
    document.getElementById("out").textContent = out.join("\\n");
  });
</script>`;

const SLIDER = `<!doctype html><title>parabola</title>
<label for="a">a</label><input id="a" type="range" min="1" max="5" value="1">
<output id="v">y = 1x²</output>
<script>
const a = document.getElementById("a"), v = document.getElementById("v");
a.addEventListener("input", () => { v.textContent = "y = " + a.value + "x²"; });
</script>`;

async function enablePreviews(page: Page, on: boolean) {
  await signIn(page, "/settings/appearance");
  const toggle = page.getByRole("switch", { name: "Run file previews" });
  if ((await toggle.isChecked()) !== on) await toggle.click();
  await expect(toggle).toBeChecked({ checked: on });
  // Saved before going on (the switch shows the choice at once).
  await expect
    .poll(async () => {
      const res = await page.request.get(`${base()}/api/preferences`);
      return ((await res.json()) as { previews: boolean | null }).previews === true;
    })
    .toBe(on);
}

async function fileReply(page: Page, filename: string, source: string) {
  await page.goto(`${base()}/chat/new`);
  await hydrated(page);
  await chooseModel(page, "mock-chat");
  await send(page, `x\n\`\`\`html file=${filename}\n${source}\n\`\`\``);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await storedReplies(page)
    .last()
    .getByRole("button", { name: new RegExp(filename) })
    .click();
  return page.getByTestId("source-panel");
}

test("a hostile preview reaches nothing outside its frame", async ({ page, context }) => {
  await enablePreviews(page, true);
  const requests: string[] = [];
  // Requests made by anything inside the preview frame (its own document excluded).
  const fromFrame: string[] = [];
  page.on("request", (r) => {
    requests.push(r.url());
    if (r.frame() !== page.mainFrame() && !r.url().includes("/api/preview/"))
      fromFrame.push(r.url());
  });
  const pages: unknown[] = [];
  context.on("page", (p) => pages.push(p));
  const forged: unknown[] = [];
  await page.exposeFunction("__sawMessage", (data: unknown) => forged.push(data));
  await page.addInitScript(() => {
    window.addEventListener("message", (e) => {
      (window as unknown as { __sawMessage: (d: unknown) => void }).__sawMessage(e.data);
    });
  });
  const panel = await fileReply(page, "attack.html", HOSTILE);
  await panel.getByRole("button", { name: "Run preview" }).click();
  const frame = page.frameLocator('iframe[title^="Preview of attack.html"]');
  const out = frame.locator("#out");
  await expect(out).toContainText("fetch:");
  const text = await out.textContent();
  expect(text).toContain("cookie:blocked");
  expect(text).toContain("localStorage:blocked");
  expect(text).toContain("parent:blocked");
  expect(text).toContain("fetch:blocked");
  expect(text).not.toContain("open:opened");
  // No request left the frame for the API or another origin; no popup opened.
  expect(fromFrame).toEqual([]);
  expect(requests.filter((u) => !u.startsWith(base()))).toEqual([]);
  expect(pages).toEqual([]);
  // A message from the frame carries nothing of the session (it could not read it).
  expect(JSON.stringify(forged)).not.toMatch(/chatui_session|csrf/i);
  // The app still works and never acted on the forged message.
  await expect(page.locator("#message")).toBeVisible();
  expect(page.url()).toMatch(/\/chat\/[0-9a-f-]{36}$/);
  // The frame is sandboxed without same-origin, and the preview response says so too.
  const sandbox = await page
    .locator('iframe[title^="Preview of attack.html"]')
    .getAttribute("sandbox");
  expect(sandbox).toBe("allow-scripts");
  // Closing tears the frame down.
  await panel.getByRole("button", { name: "Show source" }).click();
  await expect(page.locator('iframe[title^="Preview of"]')).toHaveCount(0);
  await expect(panel).toContainText("document.cookie");
});

test("a legitimate preview works by keyboard; previews off means source only", async ({ page }) => {
  await enablePreviews(page, true);
  const panel = await fileReply(page, "parabola.html", SLIDER);
  await panel.getByRole("button", { name: "Run preview" }).click();
  const frame = page.frameLocator('iframe[title^="Preview of parabola.html"]');
  const slider = frame.getByRole("slider", { name: "a" });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(frame.locator("#v")).toHaveText("y = 3x²");
  await page.keyboard.press("Escape");

  await enablePreviews(page, false);
  const again = await fileReply(page, "parabola2.html", SLIDER);
  await expect(again.getByRole("button", { name: "Run preview" })).toHaveCount(0);
  await expect(again).toContainText("addEventListener");
});

test("a preview link is single-use and needs no session", async ({ page, browser }) => {
  await enablePreviews(page, true);
  const panel = await fileReply(page, "once.html", "<p id=ok>ok</p>");
  const id = await panel.getAttribute("data-artifact-id");
  const session = (await (await page.request.get(`${base()}/api/auth/session`)).json()) as {
    csrfToken: string;
    user: { id: string };
  };
  const minted = await page.request.post(`${base()}/api/artifacts/${id ?? ""}/preview`, {
    headers: { "X-CSRF-Token": session.csrfToken, "X-Expected-User": session.user.id },
  });
  expect(minted.status()).toBe(200);
  const { url } = (await minted.json()) as { url: string };
  // A browser with no cookies at all can load it once…
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const first = await anonymous.request.get(`${base()}${url}`);
  expect(first.status()).toBe(200);
  expect(first.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
  expect(first.headers()["content-security-policy"]).toContain("connect-src 'none'");
  // …and never again.
  expect((await anonymous.request.get(`${base()}${url}`)).status()).toBe(404);
  await anonymous.close();
});

test("a preview that spins the CPU can be stopped, and the app recovers", async ({ page }) => {
  await enablePreviews(page, true);
  const SPIN = `<!doctype html><button id="spin">spin</button><script>
document.getElementById("spin").addEventListener("click", () => {
  const until = Date.now() + 3000;
  while (Date.now() < until) {}
});
</script>`;
  const panel = await fileReply(page, "spin.html", SPIN);
  await panel.getByRole("button", { name: "Run preview" }).click();
  const frame = page.frameLocator('iframe[title^="Preview of spin.html"]');
  await frame.locator("#spin").click({ noWaitAfter: true });
  const started = Date.now();
  // The page's own script keeps answering while the frame spins (when the
  // browser isolates sandboxed frames); either way it answers once stopped.
  await page.evaluate(() => document.title);
  const parentLatency = Date.now() - started;
  test.info().annotations.push({
    type: "parent latency during spin (ms)",
    description: String(parentLatency),
  });
  await panel.getByRole("button", { name: "Show source" }).click();
  await expect(page.locator('iframe[title^="Preview of"]')).toHaveCount(0);
  await expect(page.locator("#message")).toBeEditable();
});

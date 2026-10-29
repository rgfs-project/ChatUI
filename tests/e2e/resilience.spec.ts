import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_USER } from "./global-setup.ts";
import { base, hydrated, longChat, signIn, signInWithForm } from "./helpers.ts";

/** CSRF-protected API call through the page's own session cookie. */
async function api(page: Page, method: string, path: string, body?: unknown) {
  const session = (await (await page.request.get(`${base()}/api/auth/session`)).json()) as {
    csrfToken: string;
    user: { id: string };
  };
  return page.request.fetch(`${base()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
      "X-Expected-User": session.user.id,
      Origin: base(),
    },
    ...(body === undefined ? {} : { data: body }),
  });
}

test("rapid switching between chats ends on the last one chosen", async ({ page }) => {
  await signIn(page);
  const titles = ["Switch one", "Switch two", "Switch three"];
  for (const title of titles) await api(page, "POST", "/api/conversations", { title });
  await page.reload();
  await hydrated(page);
  const list = page.getByTestId("conversation-list");
  for (const title of [...titles, "Switch one", "Switch three"]) {
    await list.getByRole("link", { name: title, exact: true }).click({ noWaitAfter: true });
  }
  await expect(page.locator(".header-title")).toHaveText("Switch three");
  await expect(list.getByRole("link", { name: "Switch three", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("slow scripts: the server-rendered composer is usable before hydration", async ({ page }) => {
  await signIn(page);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/**/*.js", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`${base()}/chat/${longChat()}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("needle-99", { exact: false })).toBeVisible();
  await page.locator("#message").fill("typed on a slow network");
  release();
  await hydrated(page);
  await page.unroute("**/assets/**/*.js");
  await expect(page.locator("#message")).toHaveValue("typed on a slow network");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("hard reloads of chat, settings and admin never rewrite /api to HTML", async ({ page }) => {
  await signIn(page);
  const html: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.pathname.startsWith("/api/") &&
      (response.headers()["content-type"] ?? "").includes("text/html")
    )
      html.push(url.pathname);
  });
  for (const path of [`/chat/${longChat()}`, "/settings/general", "/admin"]) {
    await page.goto(`${base()}${path}`);
    await hydrated(page);
    await page.reload();
    await hydrated(page);
  }
  expect(html).toEqual([]);
});

test.describe("session expiry mid-use (contracts §12)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("re-authenticating as the same user restores the draft; another account discards it", async ({
    page,
  }) => {
    await signInWithForm(page, `/chat/${longChat()}`);
    await page.locator("#message").fill("keep this draft");
    expect((await api(page, "POST", "/api/auth/logout")).status()).toBe(200);
    await page.getByRole("button", { name: "Send" }).click();
    const dialog = page.getByRole("dialog", { name: "Session expired" });
    await expect(dialog).toBeVisible();
    // No document navigation happened.
    expect(new URL(page.url()).pathname).toBe(`/chat/${longChat()}`);
    await dialog.getByLabel("Password").fill(E2E_PASSWORD);
    await dialog.getByRole("button", { name: "Sign in" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#message")).toHaveValue("keep this draft");
    // The draft was never written to browser storage.
    const stored = await page.evaluate(() =>
      [localStorage, sessionStorage]
        .flatMap((store) => Object.keys(store).map((k) => store.getItem(k) ?? ""))
        .join("\n"),
    );
    expect(stored).not.toContain("keep this draft");

    // Expire again and choose another account: the draft is gone.
    expect((await api(page, "POST", "/api/auth/logout")).status()).toBe(200);
    await page.getByTestId("composer-menu").click();
    await page.keyboard.press("Escape");
    await page.locator("#message").press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Use another account" }).click();
    await page.waitForURL(/\/login/);
    await hydrated(page);
    await page.locator("#username").fill(E2E_USER);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/chat\/new$/);
    await page.goto(`${base()}/chat/${longChat()}`);
    await hydrated(page);
    await expect(page.locator("#message")).toHaveValue("");
  });
});

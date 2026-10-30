import { expect, test } from "@playwright/test";
import { E2E_OTHER_USER, LONG_CHAT_TITLE } from "./global-setup.ts";
import {
  base,
  chooseModel,
  hydrated,
  longChat,
  send,
  signIn,
  signInWithForm,
  storedReplies,
} from "./helpers.ts";

const MISSING = "00000000-0000-4000-8000-000000000000";

test.describe("INV-53: URL-driven conversations and overlays", () => {
  test("a deep link survives a hard reload", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    await expect(page.getByText("needle-99", { exact: false })).toBeVisible();
    await page.reload();
    await hydrated(page);
    expect(new URL(page.url()).pathname).toBe(`/chat/${longChat()}`);
    await expect(page.getByText("needle-99", { exact: false })).toBeVisible();
  });

  test("the first send replaces the draft URL, so Back skips the empty draft", async ({ page }) => {
    await signIn(page, `/chat/${longChat()}`);
    await page.getByTestId("new-chat").click();
    await page.waitForURL(/\/chat\/new$/);
    await chooseModel(page, "mock-chat");
    await send(page, "first message of a draft");
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
    const created = new URL(page.url()).pathname;
    expect(created).not.toBe(`/chat/${longChat()}`);
    await expect(storedReplies(page).last()).toContainText("Echo: first message of a draft");
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe(`/chat/${longChat()}`);
  });

  test("Settings opens over the conversation; Back closes it, Forward reopens it", async ({
    page,
  }) => {
    await signIn(page, `/chat/${longChat()}`);
    await page.getByRole("button", { name: /^Account:/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.waitForURL(/\/settings$/);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    // The conversation stays behind the overlay.
    await expect(page.getByTestId("transcript")).toContainText("needle-99");
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe(`/chat/${longChat()}`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByTestId("transcript")).toContainText("needle-99");
    await page.keyboard.press("Escape");
    expect(new URL(page.url()).pathname).toBe(`/chat/${longChat()}`);
  });

  test("a direct link to Settings opens safely and closes to the draft", async ({ page }) => {
    await signIn(page, "/settings/account");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.waitForURL(/\/chat\/new$/);
  });

  test("a missing conversation is a data error; an unknown URL is a route error", async ({
    page,
  }) => {
    await signIn(page);
    const count = async () =>
      (
        (await (await page.request.get(`${base()}/api/conversations`)).json()) as {
          conversations: unknown[];
        }
      ).conversations.length;
    const before = await count();
    const missing = await page.goto(`${base()}/chat/${MISSING}`);
    expect(missing?.status()).toBe(404);
    await expect(page.getByText("This conversation does not exist.")).toBeVisible();
    const invalid = await page.goto(`${base()}/chat/not-a-uuid`);
    expect(invalid?.status()).toBe(404);
    await expect(page.getByText("This conversation does not exist.")).toBeVisible();
    const unknown = await page.goto(`${base()}/definitely/not/here`);
    expect(unknown?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    // Neither path created or changed anything.
    expect(await count()).toBe(before);
  });

  test.describe("starting signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("signed out, a deep link returns there after sign-in", async ({ page }) => {
      const response = await page.goto(`${base()}/chat/${longChat()}`);
      expect(response?.ok()).toBe(true);
      expect(new URL(page.url()).pathname).toBe("/login");
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`/chat/${longChat()}`);
      await hydrated(page);
      await page.locator("#username").fill("e2e");
      await page.locator("#password").fill("e2e password 1234");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((url) => url.pathname === `/chat/${longChat()}`);
      await expect(page.getByText("needle-99", { exact: false })).toBeVisible();
    });

    test("signing out and in as another account never shows the previous account's data", async ({
      page,
    }) => {
      // A session of its own: logging out must not end the run's shared one.
      await signInWithForm(page, `/chat/${longChat()}`);
      await expect(page.getByTestId("conversation-list")).toContainText(LONG_CHAT_TITLE);
      await page.getByRole("button", { name: /^Account:/ }).click();
      await page.getByRole("menuitem", { name: "Log out" }).click();
      await page.waitForURL(/\/login/);
      await hydrated(page);
      await page.locator("#username").fill(E2E_OTHER_USER);
      await page.locator("#password").fill("e2e password 1234");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/chat\/new$/);
      await expect(page.getByTestId("signed-in-user")).toHaveText(E2E_OTHER_USER);
      await expect(page.getByText(LONG_CHAT_TITLE)).toHaveCount(0);
      // The other account's chat id is a not-found for this one (INV-15).
      await page.goto(`${base()}/chat/${longChat()}`);
      await expect(page.getByText("This conversation does not exist.")).toBeVisible();
    });
  });
});

test("INV-56: no duplicate fetch of the dehydrated data after hydration", async ({ page }) => {
  await signIn(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(`${request.method()} ${url.pathname}`);
  });
  await page.goto(`${base()}/chat/${longChat()}`);
  await hydrated(page);
  await page.waitForTimeout(1_500);
  const duplicated = requests.filter((r) =>
    /^GET \/api\/(auth\/session|conversations|conversations\/[^/]+|models|preferences)$/.test(r),
  );
  expect(duplicated).toEqual([]);
});

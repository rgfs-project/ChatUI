import { expect, test } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { E2E_ADMIN, E2E_USER } from "./global-setup.ts";

/** Phase 10: the admin UI in the production build, and its absence for users. */

const base = () => process.env.E2E_BASE_URL ?? "";

test.describe("as a normal user", () => {
  test.use({
    storageState: async ({ browser }, use) => {
      await use(await signedInState(browser, E2E_USER));
    },
  });

  test("a chat cold load makes no admin API request and never loads the admin chunk", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(new URL(r.url()).pathname));
    const html = await (await page.request.get(`${base()}/chat/new`)).text();
    expect(html).not.toMatch(/\/assets\/(admin|AdminPanel)-[\w-]+\.js/);
    await page.goto(`${base()}/chat/new`);
    await page.waitForSelector('html[data-hydrated="true"]');
    await page.waitForLoadState("networkidle");
    // Also after opening Settings (which has no admin link for users).
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(requests.filter((p) => p.startsWith("/api/admin"))).toEqual([]);
    expect(requests.filter((p) => /\/assets\/(admin|AdminPanel)-/.test(p))).toEqual([]);
    // The route itself does not exist for a normal user.
    const direct = await page.goto(`${base()}/admin`);
    expect(direct?.status()).toBe(404);
  });
});

test.describe("as an admin", () => {
  test.use({
    storageState: async ({ browser }, use) => {
      await use(await signedInState(browser, E2E_ADMIN));
    },
  });

  test("manage users, models and settings; every change lands in the audit log", async ({
    page,
  }) => {
    await page.goto(`${base()}/chat/new`);
    await page.waitForSelector('html[data-hydrated="true"]');
    await page.getByRole("link", { name: "Settings" }).click();
    const admin = page.getByRole("link", { name: "Administration" });
    await admin.hover(); // intent prefetch of the admin chunk (admins only)
    await admin.click();
    await expect(page).toHaveURL(/\/admin$/);
    const panel = page.getByRole("dialog", { name: "Administration" });
    await expect(panel).toBeVisible();

    // Users: create, then change role; the table reflects the server.
    const users = panel.getByTestId("admin-users");
    await expect(users).toContainText(E2E_USER);
    const create = panel.getByRole("form", { name: "Create user" });
    await create.getByLabel("Username").fill("e2e-created");
    await create.getByLabel("Initial password").fill("created password 123");
    await create.getByRole("button", { name: "Create user" }).click();
    await expect(users).toContainText("e2e-created");
    await panel.getByLabel("Role of e2e-created").selectOption("admin");
    await expect(panel.getByTestId("admin-status").first()).toContainText("Change role: done.");

    // Models: hide one, keyboard-operable tabs (arrow keys move and activate).
    await panel.getByRole("tab", { name: "Users" }).click();
    await page.keyboard.press("ArrowRight");
    await expect(panel.getByRole("tab", { name: "Providers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("ArrowRight");
    await expect(panel.getByRole("tab", { name: "Models" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const models = panel.getByTestId("admin-models");
    await expect(models).toContainText("mock-hang");
    await panel.getByLabel("mock-hang visible to users").uncheck();
    await expect(panel.getByLabel("mock-hang visible to users")).not.toBeChecked();

    // Settings: a validated time zone.
    await panel.getByRole("tab", { name: "Settings" }).click();
    const settings = panel.getByRole("form", { name: "Instance settings" });
    await settings.getByLabel("Time zone (IANA)").fill("Not/AZone");
    await settings.getByRole("button", { name: "Save settings" }).click();
    await expect(panel.getByTestId("admin-status").last()).toContainText("failed");
    await settings.getByLabel("Time zone (IANA)").fill("Europe/Berlin");
    await settings.getByRole("button", { name: "Save settings" }).click();
    await expect(panel.getByTestId("admin-status").last()).toContainText("done");

    // Audit log: actions, never values.
    await panel.getByRole("tab", { name: "Audit log" }).click();
    const audit = panel.getByTestId("admin-audit");
    await expect(audit).toContainText("user.create");
    await expect(audit).toContainText("model.settings");
    await expect(audit).toContainText("settings.update");
    await expect(audit).not.toContainText("created password 123");

    // Back closes the overlay onto the chat.
    await page.goBack();
    await expect(panel).toBeHidden();
  });

  test("a hidden model disappears for users and the admin API rejects them", async ({
    page,
    browser,
  }) => {
    // Self-contained: hide the model through the admin API first.
    const session = (await (await page.request.get(`${base()}/api/auth/session`)).json()) as {
      csrfToken: string;
      user: { id: string };
    };
    const hide = await page.request.put(`${base()}/api/admin/model-settings`, {
      headers: { "X-CSRF-Token": session.csrfToken, "X-Expected-User": session.user.id },
      data: { providerId: "local", modelId: "mock-hang", hidden: true },
    });
    expect(hide.status()).toBe(200);
    const userContext = await browser.newContext({
      storageState: await signedInState(browser, E2E_USER),
    });
    const userPage = await userContext.newPage();
    const models = await (await userPage.request.get(`${base()}/api/models`)).text();
    expect(models).not.toContain('"mock-hang"');
    const forbidden = await userPage.request.get(`${base()}/api/admin/users`);
    expect(forbidden.status()).toBe(403);
    await userContext.close();
    const forAdmin = await (await page.request.get(`${base()}/api/models`)).text();
    expect(forAdmin).toContain('"mock-hang"');
  });
});

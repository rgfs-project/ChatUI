import { expect, test } from "@playwright/test";
import { makePng } from "../support/media.ts";
import { base, chooseModel, hydrated, signIn } from "./helpers.ts";

test("Library: upload, search, filter, sort, grid view in the URL, open, delete", async ({
  page,
}) => {
  await signIn(page, "/library");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  const stamp = String(Date.now());
  await page.getByTestId("library-file-input").setInputFiles([
    { name: `alpha-${stamp}.md`, mimeType: "text/markdown", buffer: Buffer.from("# alpha") },
    { name: `beta-${stamp}.png`, mimeType: "image/png", buffer: makePng(40, 30) },
  ]);
  const search = page.getByRole("searchbox", { name: "Search files" });
  await search.fill(stamp);
  const rows = page.getByTestId("library-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Library");

  await page.getByRole("button", { name: "Images" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`beta-${stamp}.png`);
  await page.getByRole("button", { name: "All" }).click();

  await page.getByRole("button", { name: /^Sort:/ }).click();
  await page.getByRole("menuitemradio", { name: "Name" }).click();
  await expect(rows.first()).toContainText(`alpha-${stamp}.md`);

  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.getByTestId("library-card")).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get("view")).toBe("grid");
  await page.reload();
  await hydrated(page);
  // View, sort and search survive a reload (they live in the URL).
  await expect(page.getByTestId("library-card")).toHaveCount(2);
  await expect(page.getByTestId("library-card").first()).toContainText(`alpha-${stamp}.md`);

  await page.getByRole("button", { name: `Open beta-${stamp}.png` }).click();
  await expect(page.getByTestId("image-viewer")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: `Options for alpha-${stamp}.md` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("library-card")).toHaveCount(1);
});

test("Library: a file sent in a chat links to its chat and can't be deleted on its own", async ({
  page,
}) => {
  await signIn(page);
  await chooseModel(page, "mock-vision");
  const name = `chat-${String(Date.now())}.png`;
  await page
    .getByTestId("file-input")
    .setInputFiles({ name, mimeType: "image/png", buffer: makePng() });
  await expect(page.locator('[data-testid="composer-file"][data-status="ready"]')).toHaveCount(1);
  await page.locator("#message").fill("Keep this picture");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant")).toBeVisible();
  const chatUrl = page.url();

  await page.getByTestId("library-link").click();
  await page.getByRole("searchbox", { name: "Search files" }).fill(name);
  const row = page.getByTestId("library-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("link", { name: "Keep this picture" })).toBeVisible();
  await page.getByRole("button", { name: `Options for ${name}` }).click();
  await expect(page.getByRole("menuitem", { name: /Delete/ })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Go to chat" }).click();
  await expect(page).toHaveURL(chatUrl);
});

test("Profile: photo crop and upload, shape, stats and activity; the photo is server-rendered", async ({
  page,
}) => {
  await signIn(page, "/profile");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByTestId("profile-stats")).toContainText("Messages");
  await expect(page.getByTestId("activity-grid").locator("li")).toHaveCount(53 * 7);

  await page.getByTestId("photo-input").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: makePng(300, 200, [120, 60, 200]),
  });
  const crop = page.getByTestId("photo-crop");
  await expect(crop.locator("img")).toBeVisible();
  // Drag the picture; it never leaves the frame.
  const box = await crop.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 140, box.y + 140);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 140);
    await page.mouse.up();
  }
  await page.getByRole("button", { name: "Save photo" }).click();
  const sidebarPhoto = page.locator(".profile-row .avatar img");
  await expect(sidebarPhoto).toHaveAttribute("src", /\/api\/profile\/photo\?v=[0-9a-f]{16}$/);
  await expect
    .poll(() => sidebarPhoto.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(512);

  await page.getByRole("button", { name: "Change profile photo" }).click();
  await page.getByRole("menuitem", { name: "Cookie" }).click();
  await expect(page.locator(".profile-row .avatar")).toHaveClass(/shape-cookie/);

  // The next document renders the photo and shape on the server.
  const html = await (await page.request.get(`${base()}/chat/new`)).text();
  expect(html).toMatch(/class="avatar shape-cookie has-photo"/);
  expect(html).toContain("/api/profile/photo?v=");

  await page.getByRole("button", { name: "Change profile photo" }).click();
  await page.getByRole("menuitem", { name: "Remove photo" }).click();
  await expect(sidebarPhoto).toHaveCount(0);
  await page.getByRole("button", { name: "Change profile photo" }).click();
  await page.getByRole("menuitem", { name: "Circle" }).click();
  await expect(page.locator(".profile-row .avatar")).toHaveClass(/shape-circle/);
});

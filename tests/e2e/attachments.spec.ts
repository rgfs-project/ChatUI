import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signedInState } from "./auth.ts";
import { ATTACHMENTS_CONVERSATION, SEEDED_IMAGES } from "./global-setup.ts";
import { png, wav } from "../support/media.ts";

/** Phase 12: attachments in the real browser against the production build. */

const VISION = JSON.stringify(["local", "mock-vision"]);
const CHAT = JSON.stringify(["local", "mock-chat"]);
const SHOTS = path.resolve(import.meta.dirname, "../../docs/phase-reports/phase-12");
const base = () => process.env.E2E_BASE_URL ?? "";

async function newChat(page: Page) {
  await page.goto(`${base()}/chat/new`);
  await page.waitForSelector('html[data-hydrated="true"]');
  await expect(page.getByRole("button", { name: "Attach files" })).toBeEnabled();
}

async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files" }).click();
  await (await chooser).setFiles(files);
}

const photo = () => ({ name: "mountain.png", mimeType: "image/png", buffer: png(320, 200) });

test.describe("attachments (desktop)", () => {
  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser)).cookies);
  });

  test("attach → send → reload: the thumbnail is served and visible", async ({ page }) => {
    await newChat(page);
    await page.locator("#model").selectOption(VISION);
    await attach(page, [photo()]);
    const chip = page.getByTestId("attachment-chip");
    await expect(chip).toHaveAttribute("data-status", "ready");
    await page.locator("#message").fill("What is in this picture?");
    mkdirSync(SHOTS, { recursive: true });
    await page.getByRole("form", { name: "Message composer" }).screenshot({
      path: path.join(SHOTS, "composer-image.png"),
    });
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("message-assistant").last()).toContainText("Saw 1 image(s)", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
    await page.reload();
    const thumb = page.getByTestId("attachment-thumbnail").first();
    await expect(thumb).toBeVisible();
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(320);
    await page
      .getByTestId("message-user")
      .last()
      .screenshot({
        path: path.join(SHOTS, "transcript-image.png"),
      });
  });

  test("the viewer opens from a thumbnail, zooms, downloads and closes back to it", async ({
    page,
  }) => {
    await newChat(page);
    await page.locator("#model").selectOption(VISION);
    await attach(page, [
      { name: "big.png", mimeType: "image/png", buffer: png(1800, 1200) },
      photo(),
    ]);
    await expect(page.getByTestId("attachment-chip")).toHaveCount(2);
    await expect(page.locator('[data-testid="attachment-chip"][data-status="ready"]')).toHaveCount(
      2,
    );
    await page.locator("#message").fill("Two pictures");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("message-assistant").last()).toContainText("Saw 2 image(s)", {
      timeout: 20_000,
    });
    const thumb = page.getByRole("button", { name: "View image big.png" });
    await thumb.click();
    const viewer = page.getByTestId("image-viewer");
    await expect(viewer).toBeVisible();
    const level = viewer.getByTestId("zoom-level");
    const fitted = Number((await level.textContent())?.replace("%", ""));
    expect(fitted).toBeLessThan(100);
    await page.screenshot({ path: path.join(SHOTS, "viewer.png") });
    await viewer.getByRole("button", { name: "Zoom in" }).click();
    await expect
      .poll(async () => Number((await level.textContent())?.replace("%", "")))
      .toBeGreaterThan(fitted);
    await viewer.getByRole("button", { name: "Fit to screen" }).click();
    await expect(level).toHaveText(`${String(fitted)}%`);
    await expect(viewer.getByRole("link", { name: "Download image" })).toHaveAttribute(
      "href",
      /\/content\?download=1$/,
    );
    await page.keyboard.press("ArrowRight");
    await expect(viewer.getByRole("img")).toHaveAttribute("alt", "mountain.png");
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(thumb).toBeFocused();
  });

  test("paste an image; drop a text file; remove a chip deletes the pending upload", async ({
    page,
  }) => {
    await newChat(page);
    await page.locator("#message").focus();
    await page.evaluate(
      (bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
        const event = new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        });
        document.querySelector("#message")?.dispatchEvent(event);
      },
      [...png(40, 30)],
    );
    await expect(page.locator('[data-testid="attachment-chip"][data-status="ready"]')).toHaveCount(
      1,
    );
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["hello"], "notes.md", { type: "text/markdown" }));
      const form = document.querySelector("form.composer");
      for (const type of ["dragover", "drop"])
        form?.dispatchEvent(
          new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
        );
    });
    await expect(page.locator('[data-testid="attachment-chip"][data-status="ready"]')).toHaveCount(
      2,
    );
    const deleted = page.waitForRequest(
      (r) => r.method() === "DELETE" && r.url().includes("/api/attachments/"),
    );
    await page.getByRole("button", { name: "Remove notes.md" }).click();
    await deleted;
    await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
  });

  test("an unsupported type is refused with a message; a text-only model warns about images", async ({
    page,
  }) => {
    await newChat(page);
    await attach(page, [
      {
        name: "vector.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      },
    ]);
    const chip = page.getByTestId("attachment-chip");
    await expect(chip).toHaveAttribute("data-status", "error");
    await expect(chip).toContainText("Unsupported file");
    await page.getByRole("button", { name: "Remove vector.svg" }).click();

    await page.locator("#model").selectOption(CHAT);
    await attach(page, [photo()]);
    await expect(page.getByTestId("capability-warning")).toContainText(
      "mock-chat can't read images",
    );
    await page.locator("#message").fill("describe");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.locator("#model").selectOption(VISION);
    await expect(page.getByTestId("capability-warning")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("audio attaches as an accessible chip that loads nothing until played", async ({ page }) => {
    await newChat(page);
    await page.locator("#model").selectOption(VISION);
    await attach(page, [{ name: "clip.wav", mimeType: "audio/wav", buffer: wav(300) }]);
    await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("message-assistant").last()).toContainText("1 audio part(s)", {
      timeout: 20_000,
    });
    const audio = page.getByTestId("attachment-audio").last();
    await expect(audio).toContainText("clip.wav");
    await expect(audio.locator("audio")).toHaveAttribute("preload", "none");
  });

  test("opening a conversation with many historical attachments does not load every byte", async ({
    page,
  }) => {
    const contents: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/attachments\/[^/]+\/content/.test(request.url())) contents.push(request.url());
    });
    await page.goto(`${base()}/chat/${ATTACHMENTS_CONVERSATION}`);
    await page.waitForSelector('html[data-hydrated="true"]');
    // Only thumbnails near what is on screen load: native lazy loading fetches
    // within the browser's distance margin (Chromium: ~1,250-2,500 px), and the
    // pre-hydration view starts at the top before the transcript pins to the end.
    await expect(page.getByTestId("message-assistant").last()).toContainText("Reply 59");
    await page.waitForTimeout(500);
    expect(await page.getByTestId("attachment-thumbnail").count()).toBe(SEEDED_IMAGES);
    expect(contents.length).toBeLessThan(SEEDED_IMAGES / 2);
    // Audio (preload="none") and text (download links) load nothing.
    expect(contents.every((url) => !url.includes("download=1"))).toBe(true);
    const audioSrc = await page
      .getByTestId("attachment-audio")
      .locator("audio")
      .getAttribute("src");
    expect(audioSrc).toMatch(/\/content$/);
    expect(contents.some((url) => url.endsWith(audioSrc ?? "-"))).toBe(false);
    // Scrolling to a middle message loads the thumbnails there on demand.
    const before = contents.length;
    await page
      .getByTestId("attachment-thumbnail")
      .nth(SEEDED_IMAGES / 2)
      .scrollIntoViewIfNeeded();
    await expect.poll(() => contents.length).toBeGreaterThan(before);
  });

  test("attachment endpoints never answer with HTML (production routing)", async ({ page }) => {
    await newChat(page);
    const result = await page.evaluate(async () => {
      const unknown = "00000000-0000-4000-8000-000000000000";
      const out: string[] = [];
      for (const url of [
        `/api/attachments/${unknown}`,
        `/api/attachments/${unknown}/content`,
        "/api/attachments/not-a-uuid/content",
        "/api/attachments/limits",
      ]) {
        const res = await fetch(url);
        out.push(`${String(res.status)} ${res.headers.get("content-type") ?? ""}`);
      }
      return out;
    });
    for (const line of result) expect(line).not.toContain("text/html");
    expect(result[0]).toMatch(/^404 application\/json/);
    expect(result[3]).toMatch(/^200 application\/json/);
  });
});

test.describe("attachments (phone)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test.beforeEach(async ({ browser, context }) => {
    await context.addCookies((await signedInState(browser)).cookies);
  });

  test("the picker opens only from the + button; chips stay above the keyboard", async ({
    page,
  }) => {
    let choosers = 0;
    page.on("filechooser", () => {
      choosers++;
    });
    await newChat(page);
    await page.locator("#message").tap();
    await page.locator("#message").fill("hello");
    await page.waitForTimeout(200);
    expect(choosers).toBe(0);
    await attach(page, [
      photo(),
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
    ]);
    expect(choosers).toBe(1);
    await expect(page.locator('[data-testid="attachment-chip"][data-status="ready"]')).toHaveCount(
      2,
    );
    // A virtual keyboard: the layout viewport shrinks (interactive-widget=resizes-content).
    await page.setViewportSize({ width: 390, height: 480 });
    await page.locator("#message").focus();
    const viewport = page.viewportSize();
    for (const chip of await page.getByTestId("attachment-chip").all()) {
      const box = await chip.boundingBox();
      expect(box).not.toBeNull();
      if (box && viewport) {
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      }
    }
    const remove = await page.getByRole("button", { name: "Remove mountain.png" }).boundingBox();
    expect(remove && remove.width >= 44 && remove.height >= 44).toBe(true);
    const send = await page.getByRole("button", { name: "Send" }).boundingBox();
    expect(send && viewport && send.y + send.height <= viewport.height).toBe(true);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    await page.screenshot({ path: path.join(SHOTS, "phone-keyboard-attachments.png") });
  });
});

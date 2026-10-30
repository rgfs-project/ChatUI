import { expect, test, type Page } from "@playwright/test";
import { makePng } from "../support/media.ts";
import { base, chooseModel, hydrated, signIn } from "./helpers.ts";

const png = (name = "photo.png", width = 64, height = 48) => ({
  name,
  mimeType: "image/png",
  buffer: makePng(width, height),
});

async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId("file-input").setInputFiles(files);
}

async function readyFiles(page: Page, count: number) {
  await expect(page.locator('[data-testid="composer-file"][data-status="ready"]')).toHaveCount(
    count,
  );
}

test("attach an image, send, reload: the thumbnail is in the transcript and opens the viewer", async ({
  page,
}) => {
  await signIn(page);
  await chooseModel(page, "mock-vision");
  // The + menu opens the picker from a genuine click.
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("composer-menu").click();
  await page.getByRole("menuitem", { name: "Add photos and files" }).click();
  await (await chooser).setFiles([png("first.png"), png("second.png", 40, 80)]);
  await readyFiles(page, 2);
  await page.locator("#message").fill("What is in these?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("message-assistant")).toContainText("[images: 2, audio: 0]");
  await expect(page.getByTestId("composer-files")).toHaveCount(0);

  await page.reload();
  await hydrated(page);
  const thumbs = page.getByTestId("message-attachments").locator("img");
  await expect(thumbs).toHaveCount(2);
  // Sized from the stored dimensions, so nothing shifts when the bytes arrive.
  await expect(thumbs.first()).toHaveAttribute("width", "64");
  await expect(thumbs.first()).toHaveAttribute("height", "48");
  await expect
    .poll(() => thumbs.first().evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(64);

  await page.getByRole("button", { name: "Open image first.png" }).click();
  const viewer = page.getByTestId("image-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "first.png" })).toBeVisible();
  await expect(viewer).toContainText("1 of 2");
  await page.keyboard.press("ArrowRight");
  await expect(viewer.getByRole("heading", { name: "second.png" })).toBeVisible();
  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect(viewer.getByRole("button", { name: /^Fit to screen/ })).toHaveText("150%");
  await expect(viewer.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    /\/content\?download=1$/,
  );
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  // Focus returns to the thumbnail that opened it.
  await expect(page.getByRole("button", { name: "Open image first.png" })).toBeFocused();
});

test("pasting an image attaches it", async ({ page }) => {
  await signIn(page);
  await chooseModel(page, "mock-vision");
  const bytes = [...makePng(8, 8)];
  await page.locator("#message").focus();
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "clip.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    document.getElementById("message")?.dispatchEvent(event);
  }, bytes);
  await readyFiles(page, 1);
  await expect(page.getByTestId("composer-file")).toContainText("clip.png");
  // Removing it cancels the attachment (and deletes the unsent upload).
  await page.getByRole("button", { name: "Remove clip.png" }).click();
  await expect(page.getByTestId("composer-files")).toHaveCount(0);
});

test("dropping a file on the chat attaches it", async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["dropped text"], "notes.txt", { type: "text/plain" }));
    const area = document.querySelector(".chat-area");
    for (const type of ["dragenter", "dragover", "drop"]) {
      area?.dispatchEvent(
        new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    }
  });
  await readyFiles(page, 1);
  await expect(page.getByTestId("composer-file")).toContainText("notes.txt");
});

test("unsupported files are refused with a message; a text-only model warns about images", async ({
  page,
}) => {
  await signIn(page);
  await chooseModel(page, "mock-chat");
  await attach(page, [
    {
      name: "drawing.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    },
  ]);
  const failed = page.locator('[data-testid="composer-file"][data-status="error"]');
  await expect(failed).toContainText("not supported");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByRole("button", { name: "Remove drawing.svg" }).click();

  await attach(page, [png()]);
  await readyFiles(page, 1);
  await expect(page.getByTestId("capability-warning")).toContainText("can't view images");
  await page.locator("#message").fill("describe");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  // The model menu marks models without image input.
  await page.getByTestId("composer-menu").click();
  await expect(
    page.getByRole("menuitemradio", { name: /^mock-chat.*Can't view images/ }),
  ).toBeVisible();
  await page.getByRole("menuitemradio", { name: /^mock-vision(\s|$)/ }).click();
  await expect(page.getByTestId("capability-warning")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("a long conversation with many images does not download every image on open", async ({
  page,
}) => {
  await signIn(page);
  const csrf = await page.evaluate(async () => {
    const res = await fetch("/api/auth/session");
    const body = (await res.json()) as { csrfToken: string; user: { id: string } };
    return { token: body.csrfToken, user: body.user.id };
  });
  const headers = { "X-CSRF-Token": csrf.token, "X-Expected-User": csrf.user };
  let conversationId: string | undefined;
  const total = 24;
  for (let i = 0; i < total; i++) {
    const uploaded = await page.request.post(`${base()}/api/attachments`, {
      headers,
      multipart: { file: png(`seed-${String(i)}.png`, 200, 150) },
    });
    const { id } = (await uploaded.json()) as { id: string };
    const sent = await page.request.post(`${base()}/api/generations`, {
      headers,
      data: {
        ...(conversationId ? { conversationId } : {}),
        providerId: "local",
        model: "mock-vision",
        content: `Image ${String(i)}\n\n${"filler line\n".repeat(20)}`,
        attachmentIds: [id],
        operationKey: crypto.randomUUID(),
        operationIssuedAt: new Date().toISOString(),
      },
    });
    const accepted = (await sent.json()) as { conversationId: string; generationId: string };
    conversationId = accepted.conversationId;
    await (
      await page.request.get(`${base()}/api/generations/${accepted.generationId}/stream`)
    ).text();
  }
  const requested = new Set<string>();
  page.on("request", (request) => {
    if (/\/api\/attachments\/[0-9a-f-]+\/content/.test(request.url())) requested.add(request.url());
  });
  await page.goto(`${base()}/chat/${String(conversationId)}`);
  await hydrated(page);
  await expect(page.getByTestId("message-attachments")).toHaveCount(total);
  await page.waitForTimeout(500);
  expect(requested.size).toBeGreaterThan(0);
  expect(requested.size).toBeLessThan(total / 2);
});

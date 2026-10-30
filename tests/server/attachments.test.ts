import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AttachmentConfig } from "../../server/config.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import type { SendHooks } from "../../server/chat/send-service.ts";
import { parseConversation, serializeConversation } from "../../server/storage/markdown.ts";
import {
  makeFlac,
  makeGif,
  makeJpeg,
  makeMp3,
  makePng,
  makePngHeaderOnly,
  makeWav,
  makeWebp,
} from "../support/media.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  attachmentConfig,
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  type TestSession,
} from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4 });
});
afterAll(async () => {
  await llama.close();
});

const servers: { server: Server; chatui: ChatUiApp }[] = [];
afterEach(async () => {
  for (const { server, chatui } of servers.splice(0)) {
    await chatui.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function serve(
  options: {
    dataDir?: string;
    attachments?: Partial<AttachmentConfig>;
    now?: () => Date;
    hooks?: SendHooks;
  } = {},
) {
  const dataDir = options.dataDir ?? tempDataDir();
  const { chatui, logs } = testApp({
    config: {
      dataDir,
      provider: providerConfig({ baseUrl: llama.url }),
      attachments: attachmentConfig(options.attachments),
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.hooks ? { send: { hooks: options.hooks } } : {}),
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    chatui,
    logs,
    dataDir,
  };
}

interface Uploaded {
  id: string;
  filename: string;
  mediaType: string;
  kind: string;
  size: number;
  width: number | null;
  height: number | null;
  status: string;
}

async function upload(
  base: string,
  who: TestSession,
  bytes: Buffer,
  filename: string,
  type = "application/octet-stream",
) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), filename);
  const res = await fetch(`${base}/api/attachments`, {
    method: "POST",
    headers: who.headers(true),
    body: form,
  });
  const text = await res.text();
  return {
    status: res.status,
    json: JSON.parse(text) as Uploaded & { error?: { code: string; message: string } },
  };
}

async function api(base: string, who: TestSession, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...who.headers(method !== "GET"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as ApiJson };
}

async function send(
  base: string,
  who: TestSession,
  input: { content?: string; attachmentIds?: string[]; model?: string; conversationId?: string },
) {
  const res = await api(base, who, "POST", "/api/generations", {
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    providerId: "local",
    model: input.model ?? MOCK_MODELS.vision,
    content: input.content ?? "",
    ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });
  if (res.status === 202) {
    await (
      await fetch(`${base}/api/generations/${String(res.json.generationId)}/stream`, {
        headers: who.headers(),
      })
    ).text();
  }
  return res;
}

interface ApiJson {
  [key: string]: unknown;
  error: { code: string; message: string };
  messages: { attachments: { id: string }[] }[];
  attachments: unknown[];
}

interface PromptBody {
  messages: { role: string; content: string | { type: string; [k: string]: unknown }[] }[];
}
const lastPrompt = () =>
  llama.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body as PromptBody;

const attachmentsDir = (dataDir: string, userId: string) =>
  path.join(dataDir, userId, "attachments");

describe("uploads: sniffing, limits and storage", () => {
  it("accepts each allowed type by its bytes and records the sniffed type and dimensions", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const cases: [Buffer, string, string, string][] = [
      [makePng(4, 3), "a.png", "image/png", "image"],
      [makeJpeg(8, 6), "b.jpeg", "image/jpeg", "image"],
      [makeGif(), "c.gif", "image/gif", "image"],
      [makeWebp(3, 5), "d.webp", "image/webp", "image"],
      [makeWav(), "e.wav", "audio/wav", "audio"],
      [makeMp3(), "f.mp3", "audio/mpeg", "audio"],
      [makeFlac(), "g.flac", "audio/flac", "audio"],
      [Buffer.from("# Notes\n\nhello"), "h.md", "text/markdown", "text"],
      [Buffer.from("a,b\n1,2\n"), "i.csv", "text/csv", "text"],
      [Buffer.from('{"a":1}'), "j.json", "application/json", "text"],
      [Buffer.from("const x = 1;\n"), "k.ts", "text/plain", "text"],
      // No extension: a PNG is still a PNG.
      [makePng(), "pasted image", "image/png", "image"],
    ];
    for (const [bytes, name, mediaType, kind] of cases) {
      const res = await upload(base, alice, bytes, name);
      expect(res.status, name).toBe(201);
      expect(res.json.mediaType, name).toBe(mediaType);
      expect(res.json.kind, name).toBe(kind);
      expect(res.json.status).toBe("pending");
    }
    const png = await upload(base, alice, makePng(4, 3), "dims.png");
    expect([png.json.width, png.json.height]).toEqual([4, 3]);
    const jpeg = await upload(base, alice, makeJpeg(8, 6), "dims.jpg");
    expect([jpeg.json.width, jpeg.json.height]).toEqual([8, 6]);
  });

  it("INV-27: a spoofed extension or Content-Type, SVG, HTML and invalid UTF-8 are rejected", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const rejected: [Buffer, string, string][] = [
      [makePng(), "photo.jpg", "image/jpeg"],
      [makePng(), "photo.png", "image/jpeg"],
      [makeWav(), "song.mp3", "audio/mpeg"],
      [Buffer.from("hello"), "fake.png", "image/png"],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "x.svg", "image/svg+xml"],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "x.txt", "text/plain"],
      [Buffer.from("<!doctype html><script>alert(1)</script>"), "page.html", "text/html"],
      [Buffer.from("<!DOCTYPE html><p>hi</p>"), "page.md", "text/markdown"],
      [Buffer.from([0x66, 0x6f, 0xff, 0xfe, 0x6f]), "bad.txt", "text/plain"],
      [Buffer.from("a\u0000b"), "nul.txt", "text/plain"],
      [Buffer.from("%PDF-1.7\n"), "doc.pdf", "application/pdf"],
      [Buffer.from("MZ\u0090\u0000"), "app.exe", "application/octet-stream"],
    ];
    for (const [bytes, name, type] of rejected) {
      const res = await upload(base, alice, bytes, name, type);
      expect(res.status, name).toBe(415);
      expect(res.json.error?.code, name).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    // Nothing is left behind by rejected uploads.
    expect(readdirSync(attachmentsDir(dataDir, alice.userId))).toEqual([]);
  });

  it("truncated or malformed audio and images are rejected; too many pixels is 413", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const wav = makeWav();
    const cases: [Buffer, string, number][] = [
      [wav.subarray(0, 30), "short.wav", 415],
      [wav.subarray(0, wav.length - 100), "cut.wav", 415],
      [makeMp3(1).subarray(0, 200), "cut.mp3", 415],
      [Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4, 5]), "noise.mp3", 415],
      [makeFlac().subarray(0, 20), "cut.flac", 415],
      [makePng().subarray(0, 40), "cut.png", 415],
      [makePngHeaderOnly(20_000, 20_000), "huge.png", 413],
    ];
    for (const [bytes, name, status] of cases) {
      const res = await upload(base, alice, bytes, name);
      expect(res.status, name).toBe(status);
    }
    expect((await upload(base, alice, Buffer.alloc(0), "empty.txt")).status).toBe(400);
  });

  it("the size limit is enforced while streaming: no oversized temp file is left", async () => {
    const { base, chatui, dataDir } = await serve({ attachments: { maxBytes: 64 * 1024 } });
    const alice = await signIn(base, chatui);
    // Chunked transfer (no Content-Length), so only the byte count can stop it.
    const boundary = "----chatui-test";
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/api/attachments`, {
        method: "POST",
        headers: {
          ...alice.headers(true),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Transfer-Encoding": "chunked",
        },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      );
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < 400) {
          sent++;
          if (!req.write(chunk)) {
            req.once("drain", pump);
            return;
          }
        }
        req.end(`\r\n--${boundary}--\r\n`);
      };
      pump();
    }).catch(() => 413);
    expect(status).toBe(413);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readdirSync(attachmentsDir(dataDir, alice.userId))).toEqual([]);
    // A declared length over the limit is refused before any byte is stored.
    expect((await upload(base, alice, Buffer.alloc(200 * 1024, 0x61), "big.txt")).status).toBe(413);
  });

  it("quota: a full account is refused, and parallel uploads cannot exceed it together", async () => {
    const { base, chatui } = await serve({ attachments: { quotaBytes: 300 * 1024 } });
    const alice = await signIn(base, chatui);
    const file = () => Buffer.alloc(120 * 1024, 0x62);
    const results = await Promise.all([
      upload(base, alice, file(), "a.txt"),
      upload(base, alice, file(), "b.txt"),
      upload(base, alice, file(), "c.txt"),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 413]);
    expect(results.find((r) => r.status === 413)?.json.error?.code).toBe("QUOTA_EXCEEDED");
    const list = await api(base, alice, "GET", "/api/attachments");
    expect(list.json.usedBytes).toBe(240 * 1024);
    // Deleting a pending upload frees its bytes.
    const first = results.find((r) => r.status === 201)?.json.id ?? "";
    expect((await api(base, alice, "DELETE", `/api/attachments/${first}`)).status).toBe(200);
    expect((await upload(base, alice, file(), "d.txt")).status).toBe(201);
  });

  it("INV-28: hostile filenames are display-only; storage paths are server UUIDs", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const res = await upload(base, alice, Buffer.from("x"), '../../etc/pa\u202ess\nw"d.txt');
    expect(res.status).toBe(201);
    expect(res.json.filename).toBe('pass w"d.txt');
    // Raw control characters make the multipart header invalid: rejected, nothing stored.
    expect((await upload(base, alice, Buffer.from("x"), "a\u0007b.txt")).status).toBe(400);
    const unicode = await upload(base, alice, Buffer.from("x"), "résumé 📄.md");
    expect(unicode.json.filename).toBe("résumé 📄.md");
    const entries = readdirSync(attachmentsDir(dataDir, alice.userId));
    expect(entries.sort()).toEqual([res.json.id, unicode.json.id].sort());
    expect(
      readdirSync(path.join(attachmentsDir(dataDir, alice.userId), res.json.id)).sort(),
    ).toEqual(["blob", "meta.json"]);
    const content = await fetch(`${base}/api/attachments/${unicode.json.id}/content`, {
      headers: alice.headers(),
    });
    expect(content.headers.get("content-disposition")).toBe(
      `attachment; filename="r_sum_ __.md"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%F0%9F%93%84.md`,
    );
  });

  it("only one `file` part is accepted, and an interrupted upload leaves nothing behind", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const form = new FormData();
    form.append("note", "hi");
    form.append("file", new Blob(["x"]), "a.txt");
    const res = await fetch(`${base}/api/attachments`, {
      method: "POST",
      headers: alice.headers(true),
      body: form,
    });
    expect(res.status).toBe(400);
    const json = await fetch(`${base}/api/attachments`, {
      method: "POST",
      headers: { ...alice.headers(true), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(400);

    // The client disconnects mid-upload.
    await new Promise<void>((resolve) => {
      const boundary = "----cut";
      const req = httpRequest(`${base}/api/attachments`, {
        method: "POST",
        headers: {
          ...alice.headers(true),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": "100000",
        },
      });
      req.on("error", () => {
        resolve();
      });
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\n\r\n${"a".repeat(5000)}`,
      );
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readdirSync(attachmentsDir(dataDir, alice.userId))).toEqual([]);
    // The reservation and the concurrency slot were released.
    expect((await upload(base, alice, Buffer.from("ok"), "after.txt")).status).toBe(201);
  });
});

describe("serving bytes", () => {
  it("INV-27: sniffed type, nosniff, sandbox CSP, private caching; only raster images inline", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const image = await upload(base, alice, makePng(), "p.png");
    const text = await upload(base, alice, Buffer.from("<b>hi</b>"), "t.txt", "text/html");
    const audio = await upload(base, alice, makeWav(), "a.wav");
    const get = (id: string, query = "") =>
      fetch(`${base}/api/attachments/${id}/content${query}`, { headers: alice.headers() });

    const img = await get(image.json.id);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(img.headers.get("content-disposition")).toMatch(/^inline; /);
    expect(img.headers.get("cache-control")).toBe("private, no-cache");
    expect(Buffer.from(await img.arrayBuffer()).equals(makePng())).toBe(true);
    expect((await get(image.json.id, "?download=1")).headers.get("content-disposition")).toMatch(
      /^attachment; /,
    );

    const txt = await get(text.json.id);
    expect(txt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(txt.headers.get("content-disposition")).toMatch(/^attachment; /);
    const wav = await get(audio.json.id);
    expect(wav.headers.get("content-type")).toBe("audio/wav");
    expect(wav.headers.get("content-disposition")).toMatch(/^attachment; /);
    // Range requests work (audio seeking).
    const range = await fetch(`${base}/api/attachments/${audio.json.id}/content`, {
      headers: { ...alice.headers(), Range: "bytes=0-3" },
    });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer()).toString("latin1")).toBe("RIFF");
    // Bytes are never an HTML document, and unknown ids are the JSON 404.
    const missing = await get("00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("INV-15: another user's attachment is a 404 for read, bytes, delete and send", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const mine = await upload(base, alice, makePng(), "p.png");
    for (const url of [
      `/api/attachments/${mine.json.id}`,
      `/api/attachments/${mine.json.id}/content`,
    ]) {
      const res = await fetch(`${base}${url}`, { headers: bob.headers() });
      expect(res.status, url).toBe(404);
    }
    expect((await api(base, bob, "DELETE", `/api/attachments/${mine.json.id}`)).status).toBe(404);
    const linked = await send(base, bob, { content: "steal", attachmentIds: [mine.json.id] });
    expect(linked.status).toBe(404);
    expect((await api(base, bob, "GET", "/api/attachments")).json.attachments).toEqual([]);
    // Still Alice's and still pending.
    expect((await api(base, alice, "GET", `/api/attachments/${mine.json.id}`)).json.status).toBe(
      "pending",
    );
  });
});

describe("sending with attachments", () => {
  it("links on send, shows metadata with the conversation, and sends typed parts to a capable model", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const image = await upload(base, alice, makePng(), "cat.png");
    const audio = await upload(base, alice, makeMp3(), "voice.mp3");
    const text = await upload(
      base,
      alice,
      Buffer.from("line one\n```\ninner fence\n```"),
      "notes.md",
    );
    const ids = [image.json.id, audio.json.id, text.json.id];
    const res = await send(base, alice, { content: "Look", attachmentIds: ids });
    expect(res.status).toBe(202);
    const conversationId = String(res.json.conversationId);

    const prompt = lastPrompt();
    const parts = prompt.messages.at(-1)?.content as {
      type: string;
      text?: string;
      image_url?: { url: string };
      input_audio?: unknown;
    }[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url", "input_audio"]);
    expect(parts[0]?.text).toContain("Look");
    expect(parts[0]?.text).toContain("Attached file: notes.md\n````md\nline one");
    expect(parts[1]?.image_url?.url).toBe(`data:image/png;base64,${makePng().toString("base64")}`);
    expect(parts[2]?.input_audio).toEqual({ data: makeMp3().toString("base64"), format: "mp3" });

    // Linked to the message; the conversation DTO carries metadata only.
    const meta = await api(base, alice, "GET", `/api/attachments/${image.json.id}`);
    expect(meta.json.status).toBe("linked");
    expect(meta.json.conversationId).toBe(conversationId);
    const conversation = await api(base, alice, "GET", `/api/conversations/${conversationId}`);
    const user = conversation.json.messages[0];
    expect(user?.attachments.map((a: { id: string }) => a.id)).toEqual(ids);
    expect(user?.attachments[0]).toMatchObject({
      missing: false,
      kind: "image",
      width: 4,
      height: 4,
    });
    // Canonical Markdown references them with the existing attribute (format v1).
    const file = readFileSync(
      path.join(dataDir, alice.userId, "chats", `${conversationId}.md`),
      "utf8",
    );
    expect(file).toContain(`attachments="${ids.join(",")}"`);
    const parsed = parseConversation(file);
    expect(parsed.ok && serializeConversation(parsed.conversation)).toBe(file);

    // A linked attachment can't be deleted or sent again.
    expect((await api(base, alice, "DELETE", `/api/attachments/${image.json.id}`)).status).toBe(
      409,
    );
    const again = await send(base, alice, {
      content: "again",
      attachmentIds: [image.json.id],
      conversationId,
    });
    expect(again.status).toBe(409);
  });

  it("INV-44: images or audio for a model without that modality are rejected before anything is stored", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const image = await upload(base, alice, makePng(), "cat.png");
    const audio = await upload(base, alice, makeWav(), "a.wav");
    const before = llama.requests.length;
    for (const id of [image.json.id, audio.json.id]) {
      const res = await send(base, alice, {
        content: "hi",
        attachmentIds: [id],
        model: MOCK_MODELS.chat,
      });
      expect(res.status).toBe(422);
      expect(res.json.error.code).toBe("MODEL_CAPABILITY_UNSUPPORTED");
    }
    expect(llama.requests.slice(before).some((r) => r.path === "/v1/chat/completions")).toBe(false);
    expect((await api(base, alice, "GET", "/api/conversations")).json.conversations).toEqual([]);
    expect((await api(base, alice, "GET", `/api/attachments/${image.json.id}`)).json.status).toBe(
      "pending",
    );
    // Text files work with any model.
    const text = await upload(base, alice, Buffer.from("plain"), "t.txt");
    expect(
      (await send(base, alice, { attachmentIds: [text.json.id], model: MOCK_MODELS.chat })).status,
    ).toBe(202);
  });

  it("an attachment-only message is accepted; the per-message limit is enforced", async () => {
    const { base, chatui } = await serve({ attachments: { maxPerMessage: 2 } });
    const alice = await signIn(base, chatui);
    const ids = [];
    for (let i = 0; i < 3; i++)
      ids.push((await upload(base, alice, makePng(), `${String(i)}.png`)).json.id);
    const tooMany = await send(base, alice, { attachmentIds: ids });
    expect(tooMany.status).toBe(400);
    expect((await send(base, alice, { content: "   " })).status).toBe(400);
    const ok = await send(base, alice, { attachmentIds: ids.slice(0, 2) });
    expect(ok.status).toBe(202);
    const parts = lastPrompt().messages.at(-1)?.content as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(["image_url", "image_url"]);
  });

  it("long text attachments are truncated in the prompt with a visible marker, not in storage", async () => {
    const { base, chatui } = await serve({ attachments: { maxInlineTextBytes: 2_000 } });
    const alice = await signIn(base, chatui);
    // 6,001 bytes; byte 2,000 falls inside a two-byte character.
    const body = `a${"é".repeat(3_000)}`;
    const text = await upload(base, alice, Buffer.from(body), "long.txt");
    await send(base, alice, { content: "summarize", attachmentIds: [text.json.id] });
    const content = lastPrompt().messages.at(-1)?.content as string;
    expect(content).toContain(`Attached file: long.txt\n\`\`\`txt\na${"é".repeat(999)}\n\`\`\`\n`);
    expect(content).toContain("[Truncated: showing the first 2000 of 6001 bytes of long.txt]");
    expect(content).not.toContain("\uFFFD");
    const stored = await fetch(`${base}/api/attachments/${text.json.id}/content`, {
      headers: alice.headers(),
    });
    expect(await stored.text()).toBe(body);
  });

  it("earlier images: historyImages=omit and a text-only model turn them into notes", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const image = await upload(base, alice, makePng(), "first.png");
    const first = await send(base, alice, { content: "one", attachmentIds: [image.json.id] });
    const conversationId = String(first.json.conversationId);

    await send(base, alice, { content: "two", conversationId });
    let history = lastPrompt().messages.find((m) => m.role === "user");
    expect((history?.content as { type: string }[]).some((p) => p.type === "image_url")).toBe(true);

    // A text-only model gets a note instead of the image (switching models still works).
    await send(base, alice, { content: "three", conversationId, model: MOCK_MODELS.chat });
    history = lastPrompt().messages.find((m) => m.role === "user");
    expect(history?.content).toBe(
      "one\n\n[An image (first.png) was attached here; this model cannot view images.]",
    );

    await api(base, alice, "PATCH", "/api/preferences", { historyImages: "omit" });
    await send(base, alice, { content: "four", conversationId });
    history = lastPrompt().messages.find((m) => m.role === "user");
    expect(history?.content).toBe("one\n\n[An earlier image (first.png) is not included again.]");
  });

  it("a missing attachment is a placeholder in the conversation and is skipped by the prompt", async () => {
    const { base, chatui, dataDir, logs } = await serve();
    const alice = await signIn(base, chatui);
    const image = await upload(base, alice, makePng(), "gone.png");
    const first = await send(base, alice, { content: "one", attachmentIds: [image.json.id] });
    const conversationId = String(first.json.conversationId);
    rmSync(path.join(attachmentsDir(dataDir, alice.userId), image.json.id), { recursive: true });

    const conversation = await api(base, alice, "GET", `/api/conversations/${conversationId}`);
    expect(conversation.status).toBe(200);
    expect(conversation.json.messages[0]?.attachments).toEqual([
      { id: image.json.id, missing: true },
    ]);
    expect((await send(base, alice, { content: "two", conversationId })).status).toBe(202);
    expect(lastPrompt().messages.find((m) => m.role === "user")?.content).toBe("one");
    expect(logs.lines().some((l) => l.msg === "prompt skips a missing attachment")).toBe(true);
  });

  it("deleting a conversation removes its attachments after the Markdown", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const image = await upload(base, alice, makePng(), "p.png");
    const keep = await upload(base, alice, makePng(), "keep.png");
    const res = await send(base, alice, { content: "x", attachmentIds: [image.json.id] });
    const conversationId = String(res.json.conversationId);
    expect((await api(base, alice, "DELETE", `/api/conversations/${conversationId}`)).status).toBe(
      200,
    );
    expect(existsSync(path.join(attachmentsDir(dataDir, alice.userId), image.json.id))).toBe(false);
    expect(existsSync(path.join(attachmentsDir(dataDir, alice.userId), keep.json.id))).toBe(true);
  });
});

describe("recovery", () => {
  it("a crash between the Markdown write and the link is reconciled at startup", async () => {
    const dataDir = tempDataDir();
    let crash = true;
    const first = await serve({
      dataDir,
      hooks: {
        afterMarkdownWrite: () => {
          if (crash) throw new Error("simulated crash");
        },
      },
    });
    const alice = await signIn(first.base, first.chatui);
    const image = await upload(first.base, alice, makePng(), "p.png");
    const res = await send(first.base, alice, { content: "x", attachmentIds: [image.json.id] });
    expect(res.status).toBe(500);
    crash = false;
    const meta = () =>
      JSON.parse(
        readFileSync(
          path.join(attachmentsDir(dataDir, alice.userId), image.json.id, "meta.json"),
          "utf8",
        ),
      ) as { messageId: string | null; conversationId: string | null };
    expect(meta().messageId).toBeNull();

    await serve({ dataDir });
    const chats = readdirSync(path.join(dataDir, alice.userId, "chats"));
    expect(chats).toHaveLength(1);
    expect(meta().conversationId).toBe(chats[0]?.replace(/\.md$/, ""));
    expect(meta().messageId).not.toBeNull();
  });

  it("startup removes incomplete uploads, orphans of deleted conversations and expired pending files", async () => {
    const dataDir = tempDataDir();
    const start = Date.now();
    let clock = new Date(start);
    const first = await serve({ dataDir, now: () => clock });
    const alice = await signIn(first.base, first.chatui);
    const old = await upload(first.base, alice, makePng(), "old.png");
    const linked = await upload(first.base, alice, makePng(), "linked.png");
    const res = await send(first.base, alice, { content: "x", attachmentIds: [linked.json.id] });
    clock = new Date(start + 43_200_000);
    const young = await upload(first.base, alice, makePng(), "young.png");
    const dir = attachmentsDir(dataDir, alice.userId);
    // A crash between deleting the Markdown and its attachments leaves an orphan.
    rmSync(path.join(dataDir, alice.userId, "chats", `${String(res.json.conversationId)}.md`));
    // An upload that never wrote meta.json.
    const incomplete = path.join(dir, "11111111-1111-4111-8111-111111111111");
    mkdirSync(incomplete);
    writeFileSync(path.join(incomplete, "blob"), "partial");

    clock = new Date(start + 86_400_000 + 1_000);
    await serve({ dataDir, now: () => clock });
    expect(readdirSync(dir)).toEqual([young.json.id]);
    expect(old.json.id).not.toBe(young.json.id);
  });
});

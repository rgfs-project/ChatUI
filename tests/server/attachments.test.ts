import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttachmentDto } from "../../shared/attachments.ts";
import type { ConversationDto } from "../../shared/conversations.ts";
import type { TestAppOptions } from "./helpers.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { parseConversation, serializeConversation } from "../../server/storage/markdown.ts";
import { MOCK_MODELS, mediaParts, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { flac, gif, jpeg, mp3, png, pngHeaderOnly, wav, webp } from "../support/media.ts";
import {
  localProvider,
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  writeProviders,
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
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

interface Served {
  base: string;
  chatui: ChatUiApp;
  dataDir: string;
  logs: () => Record<string, unknown>[];
}

async function serve(options: TestAppOptions = {}): Promise<Served> {
  const dataDir = options.config?.dataDir ?? tempDataDir();
  if (!existsSync(path.join(dataDir, "_system", "providers.json")))
    writeProviders(dataDir, [localProvider(llama.url, { maxActiveGenerations: 4 })]);
  const { chatui, logs } = testApp({
    ...options,
    config: { provider: providerConfig({ baseUrl: llama.url }), ...options.config, dataDir },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    chatui,
    dataDir,
    logs: logs.lines,
  };
}

async function upload(
  base: string,
  session: TestSession,
  bytes: Buffer,
  filename: string,
  type = "",
): Promise<{ status: number; body: AttachmentDto & { error?: { code: string } } }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), filename);
  const res = await fetch(`${base}/api/attachments`, {
    method: "POST",
    headers: session.headers(true),
    body: form,
  });
  return {
    status: res.status,
    body: (await res.json()) as AttachmentDto & { error?: { code: string } },
  };
}

/** A multipart upload sent with chunked encoding (no Content-Length). */
function chunkedUpload(
  base: string,
  session: TestSession,
  filename: string,
  chunks: Buffer[],
  options: { abortAfter?: number; delayMs?: number } = {},
): Promise<{ status: number; body: string } | "aborted"> {
  const boundary = "----chatui-test-boundary";
  const url = new URL(`${base}/api/attachments`);
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          ...session.headers(true),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", () => {
      resolve("aborted");
    });
    void (async () => {
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      );
      for (let i = 0; i < chunks.length; i++) {
        if (options.abortAfter === i) {
          req.destroy();
          return;
        }
        if (!req.write(chunks[i])) await new Promise((r) => req.once("drain", r));
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      }
      req.end(`\r\n--${boundary}--\r\n`);
    })();
  });
}

function attachmentDirs(dataDir: string, userId: string): string[] {
  const dir = path.join(dataDir, userId, "attachments");
  return existsSync(dir) ? readdirSync(dir) : [];
}

let keySeq = 0;
async function send(
  base: string,
  session: TestSession,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, string> & { error?: { code: string } } }> {
  keySeq++;
  const res = await fetch(`${base}/api/generations`, {
    method: "POST",
    headers: { ...session.headers(true), "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "local",
      model: MOCK_MODELS.chat,
      content: "hello",
      operationKey: `00000000-0000-4000-8000-${String(keySeq).padStart(12, "0")}`,
      operationIssuedAt: new Date().toISOString(),
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function settle(base: string, session: TestSession, generationId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${base}/api/generations/${generationId}`, {
      headers: session.headers(),
    });
    const snap = (await res.json()) as { state: string; revision: string | null; content: string };
    if (["completed", "failed", "cancelled", "timed_out"].includes(snap.state) && snap.revision)
      return snap.content;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("generation did not settle");
}

async function conversation(base: string, session: TestSession, id: string) {
  const res = await fetch(`${base}/api/conversations/${id}`, { headers: session.headers() });
  return (await res.json()) as ConversationDto;
}

function lastChatRequest(): unknown {
  return [...llama.requests].reverse().find((r) => r.path === "/v1/chat/completions")?.body;
}

describe("attachment uploads (Phase 12)", () => {
  it("INV-28: stores bytes and metadata under a server-minted id, never the filename", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const res = await upload(base, alice, png(4, 3), "../../../etc/pass\u202ewd.png");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      mediaType: "image/png",
      kind: "image",
      size: png(4, 3).length,
      width: 4,
      height: 3,
      linked: false,
    });
    // The multipart parser keeps only the base name; control and bidi characters are stripped.
    expect(res.body.filename).toBe("passwd.png");
    expect(attachmentDirs(dataDir, alice.userId)).toEqual([res.body.id]);
    const dir = path.join(dataDir, alice.userId, "attachments", res.body.id);
    expect(readdirSync(dir).sort()).toEqual(["blob", "meta.json"]);
    expect(readFileSync(path.join(dir, "blob")).equals(png(4, 3))).toBe(true);
    const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({
      id: res.body.id,
      ownerId: alice.userId,
      conversationId: null,
      messageId: null,
      mediaType: "image/png",
    });
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32")
      expect(statSync(path.join(dir, "blob")).mode & 0o777).toBe(0o600);
    // A raw NUL in the multipart header itself is refused by the parser.
    const nul = await upload(base, alice, png(4, 3), "bad\u0000name.png");
    expect(nul.status).toBe(400);
    expect(attachmentDirs(dataDir, alice.userId)).toEqual([res.body.id]);
  });

  it("INV-27: accepts each allowlisted type by its bytes", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const cases: [Buffer, string, string][] = [
      [png(), "a.png", "image/png"],
      [jpeg(), "b.jpeg", "image/jpeg"],
      [gif(), "c.gif", "image/gif"],
      [webp(), "d.webp", "image/webp"],
      [wav(), "e.wav", "audio/wav"],
      [mp3(), "f.mp3", "audio/mpeg"],
      [flac(), "g.flac", "audio/flac"],
      [Buffer.from("# Notes\n\nhello\n"), "h.md", "text/markdown"],
      [Buffer.from("a,b\n1,2\n"), "i.csv", "text/csv"],
      [Buffer.from('{"ok":true}'), "j.json", "application/json"],
      [Buffer.from("export const x = 1;\n"), "k.ts", "text/plain"],
      [Buffer.from("all: build\n"), "Makefile", "text/plain"],
    ];
    for (const [bytes, name, type] of cases) {
      const res = await upload(base, alice, bytes, name);
      expect(res.status, `${name} ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.mediaType, name).toBe(type);
    }
  });

  it("INV-27: a spoofed extension or Content-Type is rejected; SVG and HTML are never accepted", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const rejected: [Buffer, string, string?][] = [
      [png(), "photo.jpg"],
      [png(), "photo.png", "image/jpeg"],
      [Buffer.from("just text"), "fake.png"],
      [Buffer.from("just text"), "fake.txt", "image/png"],
      [mp3(), "song.wav"],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "x.svg"],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "x.txt"],
      [Buffer.from("<!doctype html><script>alert(1)</script>"), "page.html"],
      [Buffer.from("<!DOCTYPE html><p>hi</p>"), "page.txt", "text/plain"],
      [Buffer.from("<html><body>x</body></html>"), "notes.md"],
      [Buffer.from("MZ\u0090\u0000binary"), "tool.exe"],
      [Buffer.from("%PDF-1.7\n"), "doc.pdf"],
      [Buffer.from("text"), "x.txt", "image/svg+xml"],
    ];
    for (const [bytes, name, type] of rejected) {
      const res = await upload(base, alice, bytes, name, type);
      expect(res.status, name).toBe(415);
      expect(res.body.error?.code, name).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    const listed = await fetch(`${base}/api/attachments/limits`, { headers: alice.headers() });
    expect(((await listed.json()) as { usedBytes: number }).usedBytes).toBe(0);
  });

  it("rejects invalid UTF-8, NUL bytes, truncated audio and invalid JSON", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const truncatedWav = wav(100).subarray(0, 60);
    const cases: [Buffer, string][] = [
      [Buffer.from([0x68, 0x69, 0xc3, 0x28, 0x0a]), "bad.txt"],
      [Buffer.from("a\u0000b"), "nul.txt"],
      [truncatedWav, "short.wav"],
      [mp3(1).subarray(0, 200), "short.mp3"],
      [Buffer.from("fLaC\u0000\u0000"), "bad.flac"],
      [Buffer.from("{not json"), "data.json"],
      [Buffer.alloc(0), "empty.txt"],
    ];
    for (const [bytes, name] of cases) {
      const res = await upload(base, alice, bytes, name);
      expect(res.status, name).toBe(415);
    }
    expect(attachmentDirs(dataDir, alice.userId)).toEqual([]);
  });

  it("rejects images with too many pixels (413)", async () => {
    const { base, chatui } = await serve({ config: { attachments: { maxImagePixels: 100 } } });
    const alice = await signIn(base, chatui);
    expect((await upload(base, alice, png(10, 10), "ok.png")).status).toBe(201);
    const res = await upload(base, alice, pngHeaderOnly(100_000, 100_000), "huge.png");
    expect(res.status).toBe(413);
    expect(res.body.error?.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("enforces the size limit while streaming and leaves no partial file", async () => {
    const { base, chatui, dataDir } = await serve({
      config: { attachments: { maxFileBytes: 1_024 } },
    });
    const alice = await signIn(base, chatui);
    // Declared too large: refused before streaming.
    const declared = await upload(base, alice, Buffer.alloc(200_000, 0x61), "big.txt");
    expect(declared.status).toBe(413);
    expect(declared.body.error?.code).toBe("PAYLOAD_TOO_LARGE");
    // No Content-Length: the first byte over the limit aborts the upload.
    const streamed = await chunkedUpload(
      base,
      alice,
      "big.txt",
      Array.from({ length: 8 }, () => Buffer.alloc(512, 0x61)),
    );
    expect(streamed).not.toBe("aborted");
    if (streamed !== "aborted") {
      expect(streamed.status).toBe(413);
      expect(streamed.body).toContain("PAYLOAD_TOO_LARGE");
    }
    expect(attachmentDirs(dataDir, alice.userId)).toEqual([]);
    expect(chatui.services.attachments.uploadsInFlight()).toBe(0);
    // Exactly at the limit is fine.
    const exact = await chunkedUpload(base, alice, "ok.txt", [Buffer.alloc(1_024, 0x61)]);
    expect(exact !== "aborted" && exact.status).toBe(201);
  });

  it("QUOTA_EXCEEDED, including parallel uploads that together exceed the quota (INV-62)", async () => {
    const { base, chatui, dataDir } = await serve({
      config: { attachments: { quotaBytes: 5_000, maxFileBytes: 4_000 } },
    });
    const alice = await signIn(base, chatui);
    const file = () => Buffer.alloc(1_400, 0x62);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => upload(base, alice, file(), `p${String(i)}.txt`)),
    );
    const ok = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 413);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.length + refused.length).toBe(4);
    expect(refused.every((r) => r.body.error?.code === "QUOTA_EXCEEDED")).toBe(true);
    const stored = attachmentDirs(dataDir, alice.userId).reduce(
      (n, id) => n + statSync(path.join(dataDir, alice.userId, "attachments", id, "blob")).size,
      0,
    );
    expect(stored).toBeLessThanOrEqual(5_000);
    // Deleting frees space.
    const first = ok[0]?.body.id ?? "";
    await fetch(`${base}/api/attachments/${first}`, {
      method: "DELETE",
      headers: alice.headers(true),
    });
    const limits = (await (
      await fetch(`${base}/api/attachments/limits`, { headers: alice.headers() })
    ).json()) as { usedBytes: number; quotaBytes: number };
    expect(limits).toMatchObject({ quotaBytes: 5_000, usedBytes: (ok.length - 1) * 1_400 });
  });

  it("INV-62: concurrent uploads per user are bounded (RATE_LIMITED)", async () => {
    const { base, chatui } = await serve({ config: { attachments: { maxUploadsPerUser: 1 } } });
    const alice = await signIn(base, chatui);
    const slow = chunkedUpload(
      base,
      alice,
      "slow.txt",
      Array.from({ length: 10 }, () => Buffer.from("x")),
      { delayMs: 30 },
    );
    await new Promise((r) => setTimeout(r, 60));
    const second = await upload(base, alice, Buffer.from("y"), "fast.txt");
    expect(second.status).toBe(429);
    expect(second.body.error?.code).toBe("RATE_LIMITED");
    const first = await slow;
    expect(first !== "aborted" && first.status).toBe(201);
  });

  it("a cancelled upload or a closing account leaves nothing behind", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const aborted = await chunkedUpload(
      base,
      alice,
      "gone.txt",
      Array.from({ length: 10 }, () => Buffer.from("abc")),
      { abortAfter: 3, delayMs: 10 },
    );
    expect(aborted).toBe("aborted");
    // The server notices the abort asynchronously; wait for its cleanup (not a fixed delay).
    await vi.waitFor(
      () => {
        expect(chatui.services.attachments.uploadsInFlight()).toBe(0);
      },
      { timeout: 5_000, interval: 20 },
    );
    expect(attachmentDirs(dataDir, alice.userId)).toEqual([]);
    // Account closure cancels uploads in flight (contracts §6 step 3).
    const pending = chunkedUpload(
      base,
      alice,
      "slow.txt",
      Array.from({ length: 20 }, () => Buffer.from("abc")),
      { delayMs: 20 },
    );
    await new Promise((r) => setTimeout(r, 80));
    chatui.services.attachments.cancelUploads(alice.userId);
    const result = await pending;
    expect(result === "aborted" || result.status >= 400).toBe(true);
    await vi.waitFor(
      () => {
        expect(attachmentDirs(dataDir, alice.userId)).toEqual([]);
      },
      { timeout: 5_000, interval: 20 },
    );
  });

  it("rejects requests that are not a single multipart file", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const json = await fetch(`${base}/api/attachments`, {
      method: "POST",
      headers: { ...alice.headers(true), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(400);
    const two = new FormData();
    two.append("file", new Blob(["a"]), "a.txt");
    two.append("file", new Blob(["b"]), "b.txt");
    const multi = await fetch(`${base}/api/attachments`, {
      method: "POST",
      headers: alice.headers(true),
      body: two,
    });
    expect(multi.status).toBe(400);
    const field = new FormData();
    field.append("note", "hi");
    const none = await fetch(`${base}/api/attachments`, {
      method: "POST",
      headers: alice.headers(true),
      body: field,
    });
    expect(none.status).toBe(400);
  });
});

describe("attachment bytes (INV-27)", () => {
  it("serves sniffed types with nosniff, a sandbox CSP, private caching and safe disposition", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const image = (await upload(base, alice, png(), "photo.png")).body;
    const text = (await upload(base, alice, Buffer.from("héllo"), "naïve; q.txt")).body;
    const audio = (await upload(base, alice, wav(), "clip.wav")).body;

    const img = await fetch(`${base}/api/attachments/${image.id}/content`, {
      headers: alice.headers(),
    });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(img.headers.get("cache-control")).toBe("private, no-cache");
    expect(img.headers.get("content-disposition")).toMatch(/^inline; filename="photo.png"/);
    expect(Buffer.from(await img.arrayBuffer()).equals(png())).toBe(true);

    const download = await fetch(`${base}/api/attachments/${image.id}/content?download=1`, {
      headers: alice.headers(),
    });
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);

    const txt = await fetch(`${base}/api/attachments/${text.id}/content`, {
      headers: alice.headers(),
    });
    expect(txt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(txt.headers.get("content-disposition")).toBe(
      `attachment; filename="na_ve_ q.txt"; filename*=UTF-8''na%C3%AFve%3B%20q.txt`,
    );
    expect(await txt.text()).toBe("héllo");

    const snd = await fetch(`${base}/api/attachments/${audio.id}/content`, {
      headers: { ...alice.headers(), Range: "bytes=0-9" },
    });
    expect(snd.status).toBe(206);
    expect(snd.headers.get("content-type")).toBe("audio/wav");
    expect(snd.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(snd.headers.get("content-range")).toBe(`bytes 0-9/${String(wav().length)}`);
    expect((await snd.arrayBuffer()).byteLength).toBe(10);

    const etag = img.headers.get("etag") ?? "";
    const cached = await fetch(`${base}/api/attachments/${image.id}/content`, {
      headers: { ...alice.headers(), "If-None-Match": etag },
    });
    expect(cached.status).toBe(304);

    const meta = await fetch(`${base}/api/attachments/${image.id}`, { headers: alice.headers() });
    expect(await meta.json()).toMatchObject({ id: image.id, filename: "photo.png" });
  });

  it("cross-user fetch, link and delete are 404 (ownership is never revealed)", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const bob = await signIn(base, chatui, "bob");
    const mine = (await upload(base, alice, png(), "p.png")).body;
    for (const url of [`/api/attachments/${mine.id}`, `/api/attachments/${mine.id}/content`]) {
      const res = await fetch(`${base}${url}`, { headers: bob.headers() });
      expect(res.status, url).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    }
    const del = await fetch(`${base}/api/attachments/${mine.id}`, {
      method: "DELETE",
      headers: bob.headers(true),
    });
    expect(del.status).toBe(404);
    const linked = await send(base, bob, { attachmentIds: [mine.id], model: MOCK_MODELS.vision });
    expect(linked.status).toBe(404);
    expect(linked.body.error?.code).toBe("NOT_FOUND");
    // Still Alice's and still pending.
    const still = await fetch(`${base}/api/attachments/${mine.id}`, { headers: alice.headers() });
    expect(((await still.json()) as AttachmentDto).linked).toBe(false);
  });
});

describe("sending with attachments (contracts §4.1, §7)", () => {
  it("links on send; the Markdown references it and round-trips; an already-linked attachment is refused", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const image = (await upload(base, alice, png(), "p.png")).body;
    const sent = await send(base, alice, {
      model: MOCK_MODELS.vision,
      content: "What is this?",
      attachmentIds: [image.id],
    });
    expect(sent.status).toBe(202);
    const reply = await settle(base, alice, sent.body.generationId ?? "");
    expect(reply).toContain("Saw 1 image(s)");
    const body = lastChatRequest();
    expect(mediaParts(body)).toEqual({ images: 1, audio: 0 });
    const parts = JSON.stringify(body);
    expect(parts).toContain('"type":"image_url"');
    expect(parts).toContain("data:image/png;base64,");

    const conversationId = sent.body.conversationId ?? "";
    const file = readFileSync(
      path.join(dataDir, alice.userId, "chats", `${conversationId}.md`),
      "utf8",
    );
    expect(file).toContain(`attachments="${image.id}"`);
    const parsed = parseConversation(file);
    expect(parsed.ok && serializeConversation(parsed.conversation)).toBe(file);

    const meta = await fetch(`${base}/api/attachments/${image.id}`, { headers: alice.headers() });
    expect(((await meta.json()) as AttachmentDto).linked).toBe(true);
    const dto = await conversation(base, alice, conversationId);
    expect(dto.messages[0]?.attachments).toEqual([
      {
        id: image.id,
        missing: false,
        filename: "p.png",
        mediaType: "image/png",
        kind: "image",
        size: png().length,
        width: 4,
        height: 3,
      },
    ]);

    const again = await send(base, alice, {
      conversationId,
      model: MOCK_MODELS.vision,
      attachmentIds: [image.id],
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("CONFLICT");
    const del = await fetch(`${base}/api/attachments/${image.id}`, {
      method: "DELETE",
      headers: alice.headers(true),
    });
    expect(del.status).toBe(409);
  });

  it("INV-44: images and audio need a server-verified modality; rejection changes nothing", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const image = (await upload(base, alice, png(), "p.png")).body;
    const audio = (await upload(base, alice, wav(), "a.wav")).body;
    for (const id of [image.id, audio.id]) {
      const res = await send(base, alice, { model: MOCK_MODELS.chat, attachmentIds: [id] });
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("MODEL_CAPABILITY_UNSUPPORTED");
    }
    expect(existsSync(path.join(dataDir, alice.userId, "chats"))).toBe(false);
    for (const id of [image.id, audio.id]) {
      const meta = await fetch(`${base}/api/attachments/${id}`, { headers: alice.headers() });
      expect(((await meta.json()) as AttachmentDto).linked).toBe(false);
    }
    // The audio-capable model receives an input_audio part.
    const ok = await send(base, alice, { model: MOCK_MODELS.vision, attachmentIds: [audio.id] });
    expect(ok.status).toBe(202);
    await settle(base, alice, ok.body.generationId ?? "");
    const parts = JSON.stringify(lastChatRequest());
    expect(parts).toContain('"type":"input_audio"');
    expect(parts).toContain('"format":"wav"');
  });

  it("an attachment-only message is accepted; the per-message limit is enforced", async () => {
    const { base, chatui } = await serve({ config: { attachments: { maxPerMessage: 2 } } });
    const alice = await signIn(base, chatui);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (await upload(base, alice, Buffer.from(`note ${String(i)}`), `n${String(i)}.txt`)).body.id,
      );
    const tooMany = await send(base, alice, { attachmentIds: ids });
    expect(tooMany.status).toBe(400);
    const empty = await send(base, alice, { content: "", attachmentIds: ids.slice(0, 1) });
    expect(empty.status).toBe(202);
    await settle(base, alice, empty.body.generationId ?? "");
    const nothing = await send(base, alice, { content: "  " });
    expect(nothing.status).toBe(400);
  });

  it("inlines text attachments as labeled fences, truncated in the prompt only", async () => {
    const { base, chatui } = await serve({ config: { attachments: { textInlineBytes: 256 } } });
    const alice = await signIn(base, chatui);
    const long = `${"line with ``` fence\n".repeat(60)}END-OF-FILE`;
    const text = (await upload(base, alice, Buffer.from(long), "notes.md")).body;
    const sent = await send(base, alice, { content: "Summarize", attachmentIds: [text.id] });
    expect(sent.status).toBe(202);
    await settle(base, alice, sent.body.generationId ?? "");
    const request = lastChatRequest() as { messages: { role: string; content: string }[] };
    const user = request.messages.findLast((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("Summarize");
    expect(user).toContain("Attached file: notes.md\n````\n");
    expect(user).toContain(
      `[Truncated: the first 256 of ${String(long.length)} bytes of notes.md are shown.]`,
    );
    expect(user).not.toContain("END-OF-FILE");
    // Storage keeps the whole file.
    const stored = await fetch(`${base}/api/attachments/${text.id}/content`, {
      headers: alice.headers(),
    });
    expect(await stored.text()).toBe(long);
  });

  it("a text attachment that exceeds the context budget is CONTEXT_TOO_LARGE before any mutation", async () => {
    const { base, chatui, dataDir } = await serve({
      config: {
        provider: providerConfig({ baseUrl: llama.url, maxOutputTokens: 32_000 }),
        attachments: { textInlineBytes: 1_000_000 },
      },
    });
    const alice = await signIn(base, chatui);
    const text = (await upload(base, alice, Buffer.alloc(200_000, 0x61), "big.txt")).body;
    const res = await send(base, alice, { attachmentIds: [text.id] });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("CONTEXT_TOO_LARGE");
    expect(existsSync(path.join(dataDir, alice.userId, "chats"))).toBe(false);
  });

  it("historyImages: earlier images are re-sent by default and omitted when the preference says so", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const first = (await upload(base, alice, png(), "one.png")).body;
    const sent = await send(base, alice, { model: MOCK_MODELS.vision, attachmentIds: [first.id] });
    await settle(base, alice, sent.body.generationId ?? "");
    const conversationId = sent.body.conversationId ?? "";
    const second = (await upload(base, alice, png(2, 2), "two.png")).body;
    const again = await send(base, alice, {
      conversationId,
      model: MOCK_MODELS.vision,
      attachmentIds: [second.id],
    });
    await settle(base, alice, again.body.generationId ?? "");
    expect(mediaParts(lastChatRequest())).toEqual({ images: 2, audio: 0 });

    await fetch(`${base}/api/preferences`, {
      method: "PATCH",
      headers: { ...alice.headers(true), "Content-Type": "application/json" },
      body: JSON.stringify({ historyImages: "omit" }),
    });
    const third = await send(base, alice, { conversationId, model: MOCK_MODELS.vision });
    await settle(base, alice, third.body.generationId ?? "");
    expect(mediaParts(lastChatRequest())).toEqual({ images: 0, audio: 0 });
    expect(JSON.stringify(lastChatRequest())).toContain(
      "Image from an earlier message not included: one.png",
    );
    // A text-only model gets notes instead of the earlier images (INV-44).
    const text = await send(base, alice, { conversationId, model: MOCK_MODELS.chat });
    expect(text.status).toBe(202);
    await settle(base, alice, text.body.generationId ?? "");
    expect(mediaParts(lastChatRequest())).toEqual({ images: 0, audio: 0 });
  });

  it("a missing attachment is a placeholder, never malformed, and is skipped in the prompt", async () => {
    const { base, chatui, dataDir, logs } = await serve();
    const alice = await signIn(base, chatui);
    const image = (await upload(base, alice, png(), "p.png")).body;
    const sent = await send(base, alice, { model: MOCK_MODELS.vision, attachmentIds: [image.id] });
    await settle(base, alice, sent.body.generationId ?? "");
    rmSync(path.join(dataDir, alice.userId, "attachments", image.id), { recursive: true });
    const conversationId = sent.body.conversationId ?? "";
    const dto = await conversation(base, alice, conversationId);
    expect(dto.messages[0]?.attachments[0]).toMatchObject({ id: image.id, missing: true });
    const next = await send(base, alice, { conversationId, model: MOCK_MODELS.vision });
    expect(next.status).toBe(202);
    await settle(base, alice, next.body.generationId ?? "");
    expect(mediaParts(lastChatRequest())).toEqual({ images: 0, audio: 0 });
    expect(logs().some((l) => l.msg === "attachment missing; skipped in the prompt")).toBe(true);
  });

  it("conversation delete removes the Markdown first, then its linked attachments", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const image = (await upload(base, alice, png(), "p.png")).body;
    const other = (await upload(base, alice, png(), "keep.png")).body;
    const sent = await send(base, alice, { model: MOCK_MODELS.vision, attachmentIds: [image.id] });
    await settle(base, alice, sent.body.generationId ?? "");
    const conversationId = sent.body.conversationId ?? "";
    const chatFile = path.join(dataDir, alice.userId, "chats", `${conversationId}.md`);
    const store = chatui.services.attachments;
    const original = store.deleteForConversation.bind(store);
    let markdownAtCleanup: boolean | undefined;
    store.deleteForConversation = (userId, id) => {
      markdownAtCleanup = existsSync(chatFile);
      return original(userId, id);
    };
    const res = await fetch(`${base}/api/conversations/${conversationId}`, {
      method: "DELETE",
      headers: alice.headers(true),
    });
    expect(res.status).toBe(200);
    expect(markdownAtCleanup).toBe(false);
    expect(attachmentDirs(dataDir, alice.userId)).toEqual([other.id]);
  });
});

describe("attachment recovery (contracts §2 step 7)", () => {
  it("a crash between the Markdown write and the link is reconciled at startup", async () => {
    const dataDir = tempDataDir();
    const first = await serve({
      config: { dataDir },
      send: {
        hooks: {
          afterMarkdownWrite: () => {
            throw new Error("simulated crash");
          },
        },
      },
    });
    const alice = await signIn(first.base, first.chatui);
    const image = (await upload(first.base, alice, png(), "p.png")).body;
    const sent = await send(first.base, alice, {
      model: MOCK_MODELS.vision,
      attachmentIds: [image.id],
    });
    expect(sent.status).toBe(500);
    const metaFile = path.join(dataDir, alice.userId, "attachments", image.id, "meta.json");
    expect((JSON.parse(readFileSync(metaFile, "utf8")) as { messageId: unknown }).messageId).toBe(
      null,
    );
    await first.chatui.shutdown();

    const second = await serve({ config: { dataDir } });
    const report = await second.chatui.ready;
    expect(report.attachments).toMatchObject({ linked: 1, collected: 0 });
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
      messageId: string;
      conversationId: string;
    };
    expect(meta.messageId).toMatch(/^[0-9a-f-]{36}$/);
    const markdown = readFileSync(
      path.join(dataDir, alice.userId, "chats", `${meta.conversationId}.md`),
      "utf8",
    );
    expect(markdown).toContain(`<!-- cc:user id=${meta.messageId} attachments="${image.id}"`);
  });

  it("pending attachments past the TTL are collected; incomplete uploads are removed; linked ones stay", async () => {
    const dataDir = tempDataDir();
    const first = await serve({ config: { dataDir } });
    const alice = await signIn(first.base, first.chatui);
    const stale = (await upload(first.base, alice, png(), "old.png")).body;
    const used = (await upload(first.base, alice, png(), "used.png")).body;
    const sent = await send(first.base, alice, {
      model: MOCK_MODELS.vision,
      attachmentIds: [used.id],
    });
    await settle(first.base, alice, sent.body.generationId ?? "");
    // An upload that crashed before meta.json was written.
    const incomplete = "11111111-1111-4111-8111-111111111111";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(dataDir, alice.userId, "attachments", incomplete));
    writeFileSync(path.join(dataDir, alice.userId, "attachments", incomplete, "blob"), "x");
    await first.chatui.shutdown();

    const later = new Date(Date.now() + 2 * 86_400_000);
    const second = await serve({ config: { dataDir }, now: () => later });
    const report = await second.chatui.ready;
    expect(report.attachments).toEqual({ incompleteRemoved: 1, linked: 0, collected: 1 });
    expect(attachmentDirs(dataDir, alice.userId)).toEqual([used.id]);
    expect(attachmentDirs(dataDir, alice.userId)).not.toContain(stale.id);
  });
});

import { describe, expect, it } from "vitest";
import {
  displayFilename,
  sniff,
  TextProbe,
  type SniffInput,
} from "../../server/attachments/sniff.ts";
import { fencedText } from "../../server/chat/send-service.ts";
import {
  estimateCounter,
  historyGroups,
  normalizeRoles,
  type PromptMessage,
} from "../../server/chat/prompt.ts";
import { serializeMessages } from "../../server/providers/llamacpp.ts";
import { contentDisposition, parseRange } from "../../server/routes/attachments.ts";
import type { AttachmentMeta } from "../../server/storage/attachments.ts";
import { flac, gif, jpeg, mp3, png, pngHeaderOnly, wav, webp } from "../support/media.ts";

function input(bytes: Buffer, filename: string, declaredType?: string): SniffInput {
  const probe = new TextProbe();
  probe.push(bytes);
  probe.end();
  return {
    head: bytes,
    size: bytes.length,
    validUtf8: probe.valid,
    hasNul: probe.hasNul,
    filename,
    declaredType,
    maxImagePixels: 50_000_000,
  };
}

describe("INV-27: content sniffing", () => {
  it("identifies every allowlisted type by magic bytes and structure, with image sizes", () => {
    expect(sniff(input(png(4, 3), "x.png"))).toEqual({
      ok: true,
      mediaType: "image/png",
      kind: "image",
      width: 4,
      height: 3,
    });
    expect(sniff(input(jpeg(8, 6), "x.jpg"))).toMatchObject({
      mediaType: "image/jpeg",
      width: 8,
      height: 6,
    });
    expect(sniff(input(gif(), "x.gif"))).toMatchObject({
      mediaType: "image/gif",
      width: 1,
      height: 1,
    });
    expect(sniff(input(webp(5, 7), "x.webp"))).toMatchObject({
      mediaType: "image/webp",
      width: 5,
      height: 7,
    });
    expect(sniff(input(wav(), "x.wav"))).toMatchObject({ mediaType: "audio/wav", kind: "audio" });
    expect(sniff(input(mp3(), "x.mp3"))).toMatchObject({ mediaType: "audio/mpeg" });
    expect(sniff(input(flac(), "x.flac"))).toMatchObject({ mediaType: "audio/flac" });
  });

  it("the bytes decide: no extension is fine, a contradicting hint is a mismatch", () => {
    expect(sniff(input(png(), "pasted"))).toMatchObject({ ok: true, mediaType: "image/png" });
    expect(sniff(input(png(), "x.png", "application/octet-stream"))).toMatchObject({ ok: true });
    expect(sniff(input(png(), "x.png", "image/png; charset=binary"))).toMatchObject({ ok: true });
    expect(sniff(input(jpeg(), "x.jpg", "image/jpg"))).toMatchObject({ ok: true });
    expect(sniff(input(png(), "x.gif"))).toEqual({ ok: false, reason: "mismatch" });
    expect(sniff(input(png(), "x.png", "image/webp"))).toEqual({ ok: false, reason: "mismatch" });
    expect(sniff(input(png(), "x.heic"))).toEqual({ ok: false, reason: "mismatch" });
    expect(sniff(input(wav(), "x.mp3"))).toEqual({ ok: false, reason: "mismatch" });
    expect(sniff(input(Buffer.from("hello"), "x.png"))).toEqual({ ok: false, reason: "mismatch" });
    expect(sniff(input(Buffer.from("hello"), "x.bin"))).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("rejects SVG, HTML and other active markup whatever the name or type", () => {
    for (const [text, name, type] of [
      ["<svg></svg>", "x.svg"],
      ["<svg xmlns='x'/>", "x.txt"],
      ["\ufeff  <!DOCTYPE html><html>", "x.md"],
      ["<html><body>", "x.txt"],
      ["<?xml version='1.0'?><svg/>", "x.txt"],
      ["<script>alert(1)</script>", "x.js"],
      ["hello", "x.txt", "text/html"],
      ["hello", "x.txt", "image/svg+xml"],
    ] as [string, string, string?][])
      expect(sniff(input(Buffer.from(text), name, type)), name).toEqual({
        ok: false,
        reason: "active",
      });
    // Markup inside a document is just text.
    expect(sniff(input(Buffer.from("Use <b>bold</b> sparingly"), "x.md"))).toMatchObject({
      ok: true,
      mediaType: "text/markdown",
    });
  });

  it("text must be valid UTF-8 without NUL; truncated or malformed media is refused", () => {
    expect(sniff(input(Buffer.from([0xc3, 0x28]), "x.txt"))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(sniff(input(Buffer.from("a\0b"), "x.txt"))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(sniff(input(Buffer.alloc(0), "x.txt"))).toEqual({ ok: false, reason: "unsupported" });
    const truncatedPng = png().subarray(0, 20);
    expect(sniff(input(truncatedPng, "x.png"))).toEqual({ ok: false, reason: "malformed" });
    expect(sniff(input(wav().subarray(0, 50), "x.wav"))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(sniff(input(mp3(2).subarray(0, 300), "x.mp3"))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(sniff(input(webp().subarray(0, 24), "x.webp"))).toEqual({
      ok: false,
      reason: "malformed",
    });
    // A lone MPEG sync pattern in random data is not an MP3.
    expect(sniff(input(Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]), "x.mp3"))).toMatchObject({
      ok: false,
    });
  });

  it("refuses images over the pixel limit", () => {
    expect(
      sniff({ ...input(pngHeaderOnly(20_000, 20_000), "x.png"), maxImagePixels: 1_000_000 }),
    ).toEqual({
      ok: false,
      reason: "too_many_pixels",
    });
  });

  it("the streaming UTF-8 probe handles characters split across chunks", () => {
    const bytes = Buffer.from("naïve 🙂");
    const probe = new TextProbe();
    for (const b of bytes) probe.push(Buffer.from([b]));
    probe.end();
    expect(probe.valid).toBe(true);
    const cut = new TextProbe();
    cut.push(bytes.subarray(0, bytes.length - 1));
    cut.end();
    expect(cut.valid).toBe(false);
  });
});

describe("INV-28: filenames are display metadata only", () => {
  it("strips controls, bidi overrides and separators; normalizes and bounds the name", () => {
    expect(displayFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(displayFilename("a\u0000b\u0007c\u202e\u2066.txt")).toBe("abc.txt");
    expect(displayFilename("C:\\Users\\x.png")).toBe("C:_Users_x.png");
    expect(displayFilename("cafe\u0301.md")).toBe("café.md");
    expect(displayFilename("   ")).toBe("attachment");
    expect(displayFilename("..")).toBe("attachment");
    expect(displayFilename(undefined)).toBe("attachment");
    expect(Array.from(displayFilename("é".repeat(500)))).toHaveLength(200);
  });

  it("Content-Disposition carries an ASCII fallback and the exact UTF-8 name", () => {
    expect(contentDisposition("attachment", 'résumé "final";.txt')).toBe(
      `attachment; filename="r_sum_ _final__.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22%3B.txt`,
    );
    expect(contentDisposition("inline", "a'b(c).png")).toBe(
      `inline; filename="a'b(c).png"; filename*=UTF-8''a%27b%28c%29.png`,
    );
  });
});

describe("byte ranges", () => {
  it("parses one satisfiable range and ignores anything else", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=5-1", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

const meta = (over: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  conversationId: null,
  messageId: null,
  filename: "notes.md",
  mediaType: "text/markdown",
  kind: "text",
  size: 11,
  sha256: "0".repeat(64),
  createdAt: "2026-09-30T00:00:00.000Z",
  ...over,
});

describe("prompt expansion (contracts §4, §7)", () => {
  it("fences text with a fence longer than any backtick run and marks truncation", () => {
    expect(fencedText(meta(), Buffer.from("hello world"), 100)).toBe(
      "Attached file: notes.md\n```\nhello world\n```",
    );
    const text = "a ```` b";
    expect(fencedText(meta({ size: text.length }), Buffer.from(text), 100)).toContain(
      "`````\na ```` b\n`````",
    );
    const long = Buffer.from("é".repeat(10)); // 20 bytes
    const cut = fencedText(meta({ size: 20 }), long, 5);
    expect(cut).toContain("\néé\n"); // the split character is dropped
    expect(cut).toContain("[Truncated: the first 5 of 20 bytes of notes.md are shown.]");
  });

  it("puts media parts before the text; merged messages keep part order", () => {
    const groups = historyGroups(
      {
        title: "t",
        createdAt: "",
        updatedAt: "",
        blocks: [
          { type: "user", id: "u1", body: "look", attachments: ["a"] },
          { type: "user", id: "u2", body: "and this", attachments: ["b"] },
        ],
      },
      undefined,
      (ids) => ({
        text: [],
        media: ids.map((id) => ({
          type: "image" as const,
          attachmentId: id,
          mediaType: "image/png",
        })),
      }),
    );
    const merged = normalizeRoles(groups.groups.flat());
    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("look\n\nand this");
    expect(merged[0]?.parts?.map((p) => (p.type === "text" ? p.text : p.attachmentId))).toEqual([
      "a",
      "look",
      "b",
      "and this",
    ]);
  });

  it("the estimate counts MEDIA_TOKEN_RESERVE per image/audio part", async () => {
    const message: PromptMessage = {
      role: "user",
      content: "hi",
      parts: [
        { type: "image", attachmentId: "a", mediaType: "image/png" },
        { type: "audio", attachmentId: "b", mediaType: "audio/wav" },
        { type: "text", text: "hi" },
      ],
    };
    expect(await estimateCounter(10, 500).countPrompt([message])).toBe(2 + 10 + 1_000);
  });

  it("serializes image_url data URLs and input_audio parts; a vanished blob becomes a note", async () => {
    const body = await serializeMessages(
      [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: "q",
          parts: [
            { type: "image", attachmentId: "img", mediaType: "image/png" },
            { type: "audio", attachmentId: "snd", mediaType: "audio/flac" },
            { type: "image", attachmentId: "gone", mediaType: "image/png" },
            { type: "text", text: "q" },
          ],
        },
      ],
      (part) =>
        Promise.resolve(part.attachmentId === "gone" ? null : Buffer.from(part.attachmentId)),
    );
    expect(body).toEqual([
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${Buffer.from("img").toString("base64")}` },
          },
          {
            type: "input_audio",
            input_audio: { data: Buffer.from("snd").toString("base64"), format: "flac" },
          },
          { type: "text", text: "[An attachment is no longer available.]" },
          { type: "text", text: "q" },
        ],
      },
    ]);
  });
});

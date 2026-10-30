// Content sniffing for uploads (Phase 12, contracts §7, INV-27). The media
// type comes from the bytes; the filename extension and the client's
// Content-Type are hints that may only agree with it, never override it.

export type AttachmentKind = "image" | "audio" | "text";

export interface Sniffed {
  mediaType: string;
  kind: AttachmentKind;
  width: number | null;
  height: number | null;
}

export class SniffError extends Error {
  override name = "SniffError";
  readonly reason: "unsupported" | "too_large" | "empty";

  constructor(reason: SniffError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface SniffInput {
  size: number;
  /** Reads `length` bytes at `offset` (shorter at the end of the file). */
  read: (offset: number, length: number) => Promise<Buffer>;
  /** The whole file decoded as UTF-8 without errors and without NUL bytes. */
  text: boolean;
  /** Display filename (only its extension is used, as a hint). */
  filename: string;
  /** The client's declared type (hint). */
  clientType: string;
  maxImagePixels: number;
}

/** Binary types by extension; an extension must agree with the sniffed type. */
const BINARY_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
};

/** Client type aliases browsers report for the accepted binary types. */
const CLIENT_ALIASES: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac",
};

/** Text types by extension. Active types (HTML, SVG, XML, scripts run by browsers as pages) are absent. */
const TEXT_EXTENSIONS: Record<string, string> = {
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  toml: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  sql: "text/plain",
  js: "text/plain",
  mjs: "text/plain",
  cjs: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  py: "text/plain",
  rb: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  kt: "text/plain",
  swift: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cc: "text/plain",
  cpp: "text/plain",
  hpp: "text/plain",
  cs: "text/plain",
  php: "text/plain",
  pl: "text/plain",
  lua: "text/plain",
  r: "text/plain",
  sh: "text/plain",
  bash: "text/plain",
  zsh: "text/plain",
  ps1: "text/plain",
  css: "text/plain",
  scss: "text/plain",
  diff: "text/plain",
  patch: "text/plain",
  tex: "text/plain",
  rst: "text/plain",
};

/** A document that browsers or viewers would treat as markup is rejected even as text. */
const ACTIVE_TEXT = /^\s*(<\?xml|<svg[\s>]|<!doctype\s+html|<html[\s>]|<script[\s>])/i;

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const unsupported = (message: string) => new SniffError("unsupported", message);

function startsWith(head: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((b, i) => head[offset + i] === b);
}

function ascii(head: Buffer, offset: number, length: number): string {
  return head.toString("latin1", offset, offset + length);
}

interface Detected {
  mediaType: string;
  kind: "image" | "audio";
  width?: number;
  height?: number;
}

async function detectPng(input: SniffInput, head: Buffer): Promise<Detected | null> {
  if (!startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (head.length < 33 || ascii(head, 12, 4) !== "IHDR") throw unsupported("Malformed PNG image");
  const tail = await input.read(Math.max(0, input.size - 12), 12);
  if (tail.length < 12 || ascii(tail, 4, 4) !== "IEND") throw unsupported("Truncated PNG image");
  return {
    mediaType: "image/png",
    kind: "image",
    width: head.readUInt32BE(16),
    height: head.readUInt32BE(20),
  };
}

function detectGif(head: Buffer): Detected | null {
  const signature = ascii(head, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  if (head.length < 13) throw unsupported("Malformed GIF image");
  return {
    mediaType: "image/gif",
    kind: "image",
    width: head.readUInt16LE(6),
    height: head.readUInt16LE(8),
  };
}

function detectWebp(input: SniffInput, head: Buffer): Detected | null {
  if (ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WEBP") return null;
  if (head.readUInt32LE(4) + 8 > input.size) throw unsupported("Truncated WebP image");
  const chunk = ascii(head, 12, 4);
  if (chunk === "VP8X" && head.length >= 30) {
    return {
      mediaType: "image/webp",
      kind: "image",
      width: 1 + head.readUIntLE(24, 3),
      height: 1 + head.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && head.length >= 30 && startsWith(head, [0x9d, 0x01, 0x2a], 23)) {
    return {
      mediaType: "image/webp",
      kind: "image",
      width: head.readUInt16LE(26) & 0x3fff,
      height: head.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && head.length >= 25 && head[20] === 0x2f) {
    const bits = head.readUInt32LE(21);
    return {
      mediaType: "image/webp",
      kind: "image",
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  throw unsupported("Malformed WebP image");
}

async function detectJpeg(input: SniffInput, head: Buffer): Promise<Detected | null> {
  if (!startsWith(head, [0xff, 0xd8, 0xff])) return null;
  // Walk the segments until a start-of-frame marker gives the dimensions.
  let offset = 2;
  for (let guard = 0; guard < 1_000; guard++) {
    const marker = await input.read(offset, 10);
    if (marker.length < 4 || marker[0] !== 0xff) break;
    const type = marker[1] ?? 0;
    if (type === 0xff) {
      offset += 1;
      continue;
    }
    const length = marker.readUInt16BE(2);
    const isFrame = type >= 0xc0 && type <= 0xcf && type !== 0xc4 && type !== 0xc8 && type !== 0xcc;
    if (isFrame) {
      if (marker.length < 9) break;
      return {
        mediaType: "image/jpeg",
        kind: "image",
        height: marker.readUInt16BE(5),
        width: marker.readUInt16BE(7),
      };
    }
    if (type === 0xd9 || type === 0xda || length < 2) break;
    offset += 2 + length;
  }
  throw unsupported("Malformed JPEG image");
}

function detectWav(input: SniffInput, head: Buffer): Detected | null {
  if (ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WAVE") return null;
  if (head.readUInt32LE(4) + 8 > input.size) throw unsupported("Truncated WAV audio");
  // The fmt chunk must come before the data, within the first chunks.
  let offset = 12;
  while (offset + 8 <= head.length) {
    const id = ascii(head, offset, 4);
    const size = head.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      if (size < 16 || offset + 24 > head.length) break;
      const channels = head.readUInt16LE(offset + 10);
      const rate = head.readUInt32LE(offset + 12);
      if (channels < 1 || rate < 1) break;
      return { mediaType: "audio/wav", kind: "audio" };
    }
    offset += 8 + size + (size % 2);
  }
  throw unsupported("Malformed WAV audio");
}

/** MPEG audio frame header: bytes per frame, or 0 when this is not a valid header. */
function mp3FrameLength(header: Buffer, offset: number): number {
  if (offset + 4 > header.length) return 0;
  const b1 = header[offset + 1] ?? 0;
  const b2 = header[offset + 2] ?? 0;
  if (header[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return 0;
  const version = (b1 >> 3) & 0x03; // 0: MPEG 2.5, 2: MPEG 2, 3: MPEG 1
  const layer = (b1 >> 1) & 0x03; // 1: layer III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3)
    return 0;
  const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const rates =
    version === 3
      ? [44100, 48000, 32000]
      : version === 2
        ? [22050, 24000, 16000]
        : [11025, 12000, 8000];
  const bitrate = (version === 3 ? v1 : v2)[bitrateIndex] ?? 0;
  const rate = rates[rateIndex] ?? 1;
  const padding = (b2 >> 1) & 0x01;
  return Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / rate) + padding;
}

async function detectMp3(input: SniffInput, head: Buffer): Promise<Detected | null> {
  let offset = 0;
  if (ascii(head, 0, 3) === "ID3") {
    if (head.length < 10) throw unsupported("Malformed MP3 audio");
    // ID3v2 size is a 28-bit synchsafe integer.
    const size =
      ((head[6] ?? 0) << 21) | ((head[7] ?? 0) << 14) | ((head[8] ?? 0) << 7) | (head[9] ?? 0);
    offset = 10 + size + ((head[5] ?? 0) & 0x10 ? 10 : 0);
  } else if (mp3FrameLength(head, 0) === 0) {
    return null;
  }
  const frame = await input.read(offset, 4);
  const length = mp3FrameLength(frame, 0);
  if (length === 0) throw unsupported("Malformed MP3 audio");
  // A second frame header right after the first rules out a chance match.
  if (offset + length + 4 <= input.size) {
    const next = await input.read(offset + length, 4);
    if (mp3FrameLength(next, 0) === 0) throw unsupported("Malformed MP3 audio");
  } else if (offset + length > input.size) {
    throw unsupported("Truncated MP3 audio");
  }
  return { mediaType: "audio/mpeg", kind: "audio" };
}

function detectFlac(input: SniffInput, head: Buffer): Detected | null {
  if (ascii(head, 0, 4) !== "fLaC") return null;
  // The first metadata block must be STREAMINFO (type 0, 34 bytes).
  if (head.length < 42 || ((head[4] ?? 0) & 0x7f) !== 0 || head.readUIntBE(5, 3) !== 34)
    throw unsupported("Malformed FLAC audio");
  if (input.size <= 42) throw unsupported("Truncated FLAC audio");
  return { mediaType: "audio/flac", kind: "audio" };
}

async function detectBinary(input: SniffInput, head: Buffer): Promise<Detected | null> {
  return (
    (await detectPng(input, head)) ??
    detectGif(head) ??
    detectWebp(input, head) ??
    (await detectJpeg(input, head)) ??
    detectWav(input, head) ??
    detectFlac(input, head) ??
    (await detectMp3(input, head))
  );
}

/**
 * Decides the media type of a fully received upload. Throws SniffError for an
 * empty file, an unknown or disallowed type, a hint that disagrees with the
 * bytes, a malformed or truncated file, or an image over the pixel limit.
 */
export async function sniff(input: SniffInput): Promise<Sniffed> {
  if (input.size === 0) throw new SniffError("empty", "The file is empty");
  const head = await input.read(0, 64);
  const ext = extensionOf(input.filename);
  const detected = await detectBinary(input, head);
  if (detected) {
    const byExtension = BINARY_EXTENSIONS[ext];
    if (ext !== "" && byExtension !== detected.mediaType)
      throw unsupported("The file's extension does not match its contents");
    const declared = CLIENT_ALIASES[input.clientType.toLowerCase()];
    if (declared !== undefined && declared !== detected.mediaType)
      throw unsupported("The file's type does not match its contents");
    const width = detected.width ?? null;
    const height = detected.height ?? null;
    if (detected.kind === "image") {
      if (!width || !height) throw unsupported("The image has no dimensions");
      if (width * height > input.maxImagePixels)
        throw new SniffError("too_large", "The image has too many pixels");
    }
    return { mediaType: detected.mediaType, kind: detected.kind, width, height };
  }
  if (!input.text) throw unsupported("This file type is not supported");
  if (ext in BINARY_EXTENSIONS)
    throw unsupported("The file's extension does not match its contents");
  const mediaType = ext === "" ? "text/plain" : TEXT_EXTENSIONS[ext];
  if (mediaType === undefined) throw unsupported("This file type is not supported");
  const start = (await input.read(0, 512)).toString("utf8");
  if (ACTIVE_TEXT.test(start)) throw unsupported("HTML, SVG and XML documents are not supported");
  return { mediaType, kind: "text", width: null, height: null };
}

/** Streaming UTF-8 validation: valid UTF-8 with no NUL bytes counts as text. */
export class TextProbe {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private valid = true;

  push(chunk: Uint8Array): void {
    if (!this.valid) return;
    if (chunk.includes(0)) {
      this.valid = false;
      return;
    }
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      this.valid = false;
    }
  }

  finish(): boolean {
    if (!this.valid) return false;
    try {
      this.decoder.decode();
      return true;
    } catch {
      return false;
    }
  }
}

// Content sniffing for uploads (contracts §7, INV-27). Loadable natively by Node.
// The media type comes from the bytes: magic numbers plus enough structure to
// reject truncated or spoofed files. The client's Content-Type and the file
// extension are hints only; a hint that names a different type is a mismatch.
import path from "node:path";
import {
  EXTENSIONS,
  kindOf,
  type AttachmentKind,
  type AttachmentMediaType,
} from "../../shared/attachment-media.ts";

/** Bytes kept from the start of an upload for sniffing (JPEG metadata can be large). */
export const SNIFF_HEAD_BYTES = 1024 * 1024;

export type SniffResult =
  | {
      ok: true;
      mediaType: AttachmentMediaType;
      kind: AttachmentKind;
      width: number | null;
      height: number | null;
    }
  | { ok: false; reason: "unsupported" | "mismatch" | "malformed" | "active" | "too_many_pixels" };

export interface SniffInput {
  /** The first bytes of the file (up to SNIFF_HEAD_BYTES). */
  head: Buffer;
  /** Total size in bytes. */
  size: number;
  /** The whole file decoded as strict UTF-8 without error (computed while streaming). */
  validUtf8: boolean;
  /** The file contains a NUL byte. */
  hasNul: boolean;
  /** Client-supplied filename and Content-Type (hints). */
  filename: string;
  declaredType: string | undefined;
  /** Largest accepted image in pixels (width × height). */
  maxImagePixels: number;
}

const EXT_TO_TYPE = new Map<string, AttachmentMediaType>();
for (const [type, exts] of Object.entries(EXTENSIONS) as [AttachmentMediaType, string[]][])
  for (const ext of exts) EXT_TO_TYPE.set(ext, type);

/** Declared-type aliases browsers and OSes use. */
const DECLARED_ALIASES: Record<string, AttachmentMediaType> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-flac": "audio/flac",
};

function extensionOf(filename: string): string | null {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ext === "" ? null : ext;
}

function normalizeDeclared(value: string | undefined): string | null {
  const type = (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "" || type === "application/octet-stream" || type === "binary/octet-stream")
    return null;
  return DECLARED_ALIASES[type] ?? type;
}

const u16be = (b: Buffer, o: number) => b.readUInt16BE(o);
const u32be = (b: Buffer, o: number) => b.readUInt32BE(o);
const u16le = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32le = (b: Buffer, o: number) => b.readUInt32LE(o);
const ascii = (b: Buffer, o: number, n: number) =>
  b.length >= o + n ? b.toString("latin1", o, o + n) : "";

type Binary =
  { type: AttachmentMediaType; width?: number; height?: number } | { malformed: true } | null;

function png(b: Buffer): Binary {
  if (b.length < 8 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return null;
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return { malformed: true };
  return { type: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function gif(b: Buffer): Binary {
  const sig = ascii(b, 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  if (b.length < 13) return { malformed: true };
  return { type: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
}

function jpeg(b: Buffer): Binary {
  if (b.length < 3 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return { malformed: true };
    let marker = b[o + 1] ?? 0;
    while (marker === 0xff && o + 2 < b.length) marker = b[++o + 1] ?? 0; // fill bytes
    o += 2;
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan before SOF
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (o + 2 > b.length) break;
    const length = u16be(b, o);
    if (length < 2) return { malformed: true };
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 7 > b.length) return { malformed: true };
      return { type: "image/jpeg", height: u16be(b, o + 3), width: u16be(b, o + 5) };
    }
    o += length;
  }
  return { malformed: true };
}

function riff(b: Buffer, form: string): boolean {
  return ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === form;
}

function webp(b: Buffer, size: number): Binary {
  if (!riff(b, "WEBP")) return null;
  if (b.length < 30 || u32le(b, 4) + 8 > size) return { malformed: true };
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return { malformed: true };
    return { type: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return { malformed: true };
    const [b1 = 0, b2 = 0, b3 = 0, b4 = 0] = [b[21], b[22], b[23], b[24]];
    return {
      type: "image/webp",
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") {
    const w = 1 + ((b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16));
    const h = 1 + ((b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16));
    return { type: "image/webp", width: w, height: h };
  }
  return { malformed: true };
}

function wav(b: Buffer, size: number): Binary {
  if (!riff(b, "WAVE")) return null;
  let o = 12;
  let fmt = false;
  while (o + 8 <= b.length) {
    const id = ascii(b, o, 4);
    const length = u32le(b, o + 4);
    const body = o + 8;
    if (id === "fmt ") {
      if (length < 16 || body + 16 > b.length) return { malformed: true };
      const channels = u16le(b, body + 2);
      const rate = u32le(b, body + 4);
      const bits = u16le(b, body + 14);
      if (channels < 1 || channels > 32 || rate < 1 || rate > 768_000 || bits < 1)
        return { malformed: true };
      fmt = true;
    } else if (id === "data") {
      // 0xFFFFFFFF marks a stream whose length was unknown when written.
      if (!fmt || length === 0 || (length !== 0xffffffff && body + length > size))
        return { malformed: true };
      return { type: "audio/wav" };
    }
    o = body + length + (length % 2);
  }
  return { malformed: true };
}

function flac(b: Buffer, size: number): Binary {
  if (ascii(b, 0, 4) !== "fLaC") return null;
  // The first metadata block must be STREAMINFO (type 0, 34 bytes).
  if (
    b.length < 42 ||
    ((b[4] ?? 0) & 0x7f) !== 0 ||
    (((b[5] ?? 0) << 16) | ((b[6] ?? 0) << 8) | (b[7] ?? 0)) !== 34
  )
    return { malformed: true };
  const rate = ((b[18] ?? 0) << 12) | ((b[19] ?? 0) << 4) | ((b[20] ?? 0) >> 4);
  if (rate < 1 || rate > 655_350) return { malformed: true };
  let o = 4;
  for (;;) {
    if (o + 4 > size) return { malformed: true };
    if (o + 4 > b.length) return { type: "audio/flac" }; // metadata beyond the sniffed head
    const last = ((b[o] ?? 0) & 0x80) !== 0;
    const length = ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0);
    o += 4 + length;
    if (last) break;
  }
  if (o + 2 > size) return { malformed: true };
  if (o + 2 > b.length) return { type: "audio/flac" };
  // Audio frames start with the 14-bit sync code 0b11111111111110.
  if (b[o] !== 0xff || ((b[o + 1] ?? 0) & 0xfe) !== 0xf8) return { malformed: true };
  return { type: "audio/flac" };
}

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
};

/** Length of an MPEG audio Layer III frame at `o`, or null if no valid header is there. */
function mp3Frame(b: Buffer, o: number): number | null {
  if (o + 4 > b.length) return null;
  const [h0, h1 = 0, h2 = 0] = [b[o], b[o + 1], b[o + 2]];
  if (h0 !== 0xff || (h1 & 0xe0) !== 0xe0) return null;
  const version = (h1 >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5, 1: reserved
  const layer = (h1 >> 1) & 3; // 1: Layer III
  const bitrateIndex = h2 >> 4;
  const rateIndex = (h2 >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3)
    return null;
  const bitrate = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[bitrateIndex] ?? 0;
  const rate = MP3_RATES[version as 0 | 2 | 3][rateIndex] ?? 0;
  const padding = (h2 >> 1) & 1;
  return Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / rate) + padding;
}

function mp3(b: Buffer, size: number): Binary {
  let start = 0;
  const id3 = ascii(b, 0, 3) === "ID3";
  if (id3) {
    if (b.length < 10) return { malformed: true };
    const tag = ((b[6] ?? 0) << 21) | ((b[7] ?? 0) << 14) | ((b[8] ?? 0) << 7) | (b[9] ?? 0);
    start = 10 + tag + (((b[5] ?? 0) & 0x10) !== 0 ? 10 : 0);
    if (start >= size) return { malformed: true };
    if (start + 4 > b.length) return { type: "audio/mpeg" }; // huge embedded art
  }
  const first = mp3Frame(b, start);
  if (first === null) return id3 ? { malformed: true } : null;
  // Two consecutive frame headers (or one frame ending the file) rule out
  // random bytes that happen to start with a sync pattern.
  const next = start + first;
  if (next > size) return { malformed: true };
  if (next === size) return { type: "audio/mpeg" };
  if (next + 4 > b.length) return { type: "audio/mpeg" };
  return mp3Frame(b, next) === null ? { malformed: true } : { type: "audio/mpeg" };
}

/** Markup browsers render or execute: never accepted, whatever the extension. */
const ACTIVE_TEXT =
  /^\s*(?:<!doctype\s+html|<html[\s>]|<svg[\s>]|<\?xml|<script[\s>]|<iframe[\s>]|<object[\s>])/i;

function binary(b: Buffer, size: number): Binary {
  return (
    png(b) ?? jpeg(b) ?? gif(b) ?? webp(b, size) ?? wav(b, size) ?? flac(b, size) ?? mp3(b, size)
  );
}

export function sniff(input: SniffInput): SniffResult {
  const ext = extensionOf(input.filename);
  const extType = ext === null ? null : (EXT_TO_TYPE.get(ext) ?? "unknown");
  const declared = normalizeDeclared(input.declaredType);
  if (declared === "image/svg+xml" || declared === "text/html" || ext === "svg" || ext === "html")
    return { ok: false, reason: "active" };
  if (input.size === 0) return { ok: false, reason: "unsupported" };

  const found = binary(input.head, input.size);
  if (found && "malformed" in found) return { ok: false, reason: "malformed" };
  if (found) {
    if (extType !== null && extType !== found.type) return { ok: false, reason: "mismatch" };
    if (declared !== null && declared !== found.type) return { ok: false, reason: "mismatch" };
    const kind = kindOf(found.type);
    if (kind === "image") {
      const width = found.width ?? 0;
      const height = found.height ?? 0;
      if (width < 1 || height < 1) return { ok: false, reason: "malformed" };
      if (width * height > input.maxImagePixels) return { ok: false, reason: "too_many_pixels" };
      return { ok: true, mediaType: found.type, kind, width, height };
    }
    return { ok: true, mediaType: found.type, kind, width: null, height: null };
  }

  // Text: valid UTF-8 without NUL bytes, a text extension (or none), and no
  // active markup. A binary extension with text content is a spoof.
  if (!input.validUtf8 || input.hasNul) return { ok: false, reason: "unsupported" };
  if (extType !== null && (extType === "unknown" || kindOf(extType) !== "text"))
    return { ok: false, reason: extType === "unknown" ? "unsupported" : "mismatch" };
  if (declared !== null && (declared.startsWith("image/") || declared.startsWith("audio/")))
    return { ok: false, reason: "mismatch" };
  const text = input.head.toString("utf8").replace(/^\uFEFF/, "");
  if (ACTIVE_TEXT.test(text)) return { ok: false, reason: "active" };
  const mediaType = extType ?? "text/plain";
  return { ok: true, mediaType, kind: "text", width: null, height: null };
}

/** Streaming UTF-8 validator and NUL detector (the whole file, chunk by chunk). */
export class TextProbe {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  valid = true;
  hasNul = false;

  push(chunk: Buffer): void {
    if (!this.hasNul && chunk.includes(0)) this.hasNul = true;
    if (!this.valid) return;
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      this.valid = false;
    }
  }

  end(): void {
    if (!this.valid) return;
    try {
      this.decoder.decode();
    } catch {
      this.valid = false;
    }
  }
}

/** Display filename: NFC, no control/bidi characters or path separators, bounded (INV-28). */
export function displayFilename(raw: string | undefined): string {
  const cleaned = (raw ?? "")
    .normalize("NFC")
    // C0/C1 controls, bidi overrides/isolates, zero-width and BOM characters.
    // eslint-disable-next-line no-control-regex -- stripping controls is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\uFEFF]/g, "")
    .replace(/[/\\]/g, "_")
    .trim();
  const chars = Array.from(cleaned);
  const bounded = chars.length > 200 ? chars.slice(0, 200).join("") : cleaned;
  return bounded === "" || bounded === "." || bounded === ".." ? "attachment" : bounded;
}

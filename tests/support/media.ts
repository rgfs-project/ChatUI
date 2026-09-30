/**
 * Small, valid media files built in code (Phase 12 tests). PNG and WAV are
 * fully decodable by browsers; the others carry correct headers and framing
 * for the server's sniffer. No path aliases: scripts/verify.ts imports this.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-color RGB PNG of `width` × `height` pixels. */
export function png(width = 4, height = 3, rgb: [number, number, number] = [40, 90, 160]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG header claiming the given size (for pixel-limit tests; not decodable). */
export function pngHeaderOnly(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr)]);
}

/** JPEG markers up to a baseline SOF0 frame header (sniffable, not decodable). */
export function jpeg(width = 8, height = 6): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from("JFIF\0"),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** A 1×1 GIF89a. */
export function gif(): Buffer {
  return Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
}

/** A lossless WebP (VP8L) header of the given size. */
export function webp(width = 5, height = 7): Buffer {
  const w = width - 1;
  const h = height - 1;
  const vp8l = Buffer.from([
    0x2f,
    w & 0xff,
    ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >> 2) & 0xff,
    (h >> 10) & 0x0f,
    0,
    0,
    0,
    0,
    0,
  ]);
  const chunk = Buffer.concat([Buffer.from("VP8L"), Buffer.alloc(4), vp8l]);
  chunk.writeUInt32LE(vp8l.length, 4);
  const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), chunk]);
  riff.writeUInt32LE(riff.length - 8, 4);
  return riff;
}

/** A mono 16-bit PCM WAV of `ms` milliseconds of silence. */
export function wav(ms = 100, rate = 8_000): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Three MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz) after an ID3v2 tag. */
export function mp3(frames = 3): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...Buffer.alloc(10)]);
  return Buffer.concat([id3, ...Array.from({ length: frames }, () => frame)]);
}

/** A FLAC stream: marker, STREAMINFO (last block) and one frame header. */
export function flac(): Buffer {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0);
  info.writeUInt16BE(4096, 2);
  // 44100 Hz (20 bits), 2 channels - 1 (3 bits), 16 bits - 1 (5 bits).
  const rate = 44_100;
  info[10] = (rate >> 12) & 0xff;
  info[11] = (rate >> 4) & 0xff;
  info[12] = ((rate & 0x0f) << 4) | (1 << 1) | 0;
  info[13] = 15 << 4;
  const header = Buffer.from([0x80, 0, 0, 34]); // last block, type 0, length 34
  return Buffer.concat([
    Buffer.from("fLaC"),
    header,
    info,
    Buffer.from([0xff, 0xf8, 0x69, 0x08, 0, 0]),
  ]);
}

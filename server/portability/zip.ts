// A small ZIP writer and a bounded, defensive ZIP reader (Phase 13d, INV-42).
// Writer: deflate, one entry at a time, streamed to a file. Reader: central
// directory only, no symlinks, no encryption, no traversal, bounded sizes,
// entry count, ratio and depth; inflation is capped per entry.
import { open, type FileHandle } from "node:fs/promises";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  override name = "ZipError";
}

interface CentralEntry {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  method: number;
}

/** Writes a ZIP file entry by entry (each entry held in memory once). */
export class ZipWriter {
  private readonly file: FileHandle;
  private offset = 0;
  private readonly entries: CentralEntry[] = [];

  private constructor(file: FileHandle) {
    this.file = file;
  }

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await open(path, "wx", 0o600));
  }

  async add(name: string, data: Buffer): Promise<void> {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 6 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt32LE(0, 10); // time and date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    await this.file.write(Buffer.concat([header, nameBytes, body]));
    this.entries.push({
      name: nameBytes,
      crc,
      compressed: body.length,
      size: data.length,
      offset: this.offset,
      method: stored ? 0 : 8,
    });
    this.offset += header.length + nameBytes.length + body.length;
    if (this.offset > 0xffff_ffff) throw new ZipError("archive too large for ZIP32");
  }

  async close(): Promise<void> {
    const parts: Buffer[] = [];
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt32LE(0, 12);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE((0o100600 << 16) >>> 0, 38); // regular file, 0600
      header.writeUInt32LE(entry.offset, 42);
      parts.push(header, entry.name);
    }
    const central = Buffer.concat(parts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(this.offset, 16);
    await this.file.write(Buffer.concat([central, end]));
    await this.file.sync();
    await this.file.close();
  }

  async abort(): Promise<void> {
    await this.file.close().catch(() => undefined);
  }
}

export interface ZipLimits {
  maxEntries: number;
  /** Largest expanded size of one entry. */
  maxEntryBytes: number;
  /** Total expanded size of all entries. */
  maxTotalBytes: number;
  /** Expanded ÷ compressed, for entries over 1 MB expanded. */
  maxRatio: number;
  /** Path segments. */
  maxDepth: number;
}

export interface ZipEntry {
  name: string;
  size: number;
}

/** A validated archive: names are safe relative paths; read entries on demand. */
export class ZipReader {
  private readonly file: FileHandle;
  private readonly index = new Map<string, CentralEntry>();
  private readonly limits: ZipLimits;

  private constructor(file: FileHandle, limits: ZipLimits) {
    this.file = file;
    this.limits = limits;
  }

  /** Opens and validates the central directory (no data is inflated yet). */
  static async open(path: string, limits: ZipLimits): Promise<ZipReader> {
    const file = await open(path, "r");
    const reader = new ZipReader(file, limits);
    try {
      await reader.load();
      return reader;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  private async read(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.file.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new ZipError("truncated archive");
    return buffer;
  }

  private async load(): Promise<void> {
    const { size } = await this.file.stat();
    if (size < 22) throw new ZipError("not a ZIP archive");
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await this.read(size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("not a ZIP archive");
    const count = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || centralOffset === 0xffffffff)
      throw new ZipError("ZIP64 archives are not supported");
    if (count > this.limits.maxEntries) throw new ZipError("too many entries");
    if (centralOffset + centralSize > size) throw new ZipError("corrupt central directory");
    const central = await this.read(centralOffset, centralSize);
    let p = 0;
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > central.length || central.readUInt32LE(p) !== 0x02014b50)
        throw new ZipError("corrupt central directory");
      const flags = central.readUInt16LE(p + 8);
      const method = central.readUInt16LE(p + 10);
      const crc = central.readUInt32LE(p + 16);
      const compressed = central.readUInt32LE(p + 20);
      const expanded = central.readUInt32LE(p + 24);
      const nameLength = central.readUInt16LE(p + 28);
      const extraLength = central.readUInt16LE(p + 30);
      const commentLength = central.readUInt16LE(p + 32);
      const madeBy = central.readUInt16LE(p + 4) >> 8;
      const external = central.readUInt32LE(p + 38);
      const offset = central.readUInt32LE(p + 42);
      const nameBytes = central.subarray(p + 46, p + 46 + nameLength);
      p += 46 + nameLength + extraLength + commentLength;
      const name = nameBytes.toString("utf8");
      if (flags & 0x1) throw new ZipError("encrypted entries are not supported");
      if (method !== 0 && method !== 8) throw new ZipError("unsupported compression");
      // Unix mode in the high bits: only regular files and directories.
      const mode = madeBy === 3 ? external >>> 16 : 0;
      const type = mode & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000)
        throw new ZipError(`"${safeLabel(name)}" is a link or special file`);
      if (name.endsWith("/")) continue; // directory entries carry nothing
      checkName(name, this.limits.maxDepth);
      if (this.index.has(name)) throw new ZipError(`duplicate entry "${safeLabel(name)}"`);
      if (expanded > this.limits.maxEntryBytes)
        throw new ZipError(`"${safeLabel(name)}" is too large`);
      if (expanded > 1024 * 1024 && expanded > compressed * this.limits.maxRatio)
        throw new ZipError(`"${safeLabel(name)}" expands suspiciously (possible ZIP bomb)`);
      total += expanded;
      if (total > this.limits.maxTotalBytes) throw new ZipError("the archive expands too much");
      this.index.set(name, { name: nameBytes, crc, compressed, size: expanded, offset, method });
    }
  }

  entries(): ZipEntry[] {
    return [...this.index.entries()].map(([name, e]) => ({ name, size: e.size }));
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  /** Inflates one entry, never past its declared size, and checks its CRC. */
  async get(name: string): Promise<Buffer> {
    const entry = this.index.get(name);
    if (!entry) throw new ZipError(`missing entry "${safeLabel(name)}"`);
    const local = await this.read(entry.offset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipError("corrupt entry");
    const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = await this.read(start, entry.compressed);
    let data: Buffer;
    try {
      data =
        entry.method === 0
          ? raw
          : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw new ZipError(`"${safeLabel(name)}" could not be expanded`);
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc)
      throw new ZipError(`"${safeLabel(name)}" is corrupt`);
    return data;
  }

  async close(): Promise<void> {
    await this.file.close();
  }
}

function safeLabel(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
}

/** Relative, forward-slash, no `..`, no empty or dot segments, bounded depth (INV-42). */
function checkName(name: string, maxDepth: number): void {
  const segments = name.split("/");
  if (
    name.length === 0 ||
    name.length > 300 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /^[A-Za-z]:/.test(name) ||
    name.includes("\0") ||
    segments.length > maxDepth ||
    segments.some((s) => s === "" || s === "." || s === "..")
  )
    throw new ZipError(`unsafe path "${safeLabel(name)}"`);
}

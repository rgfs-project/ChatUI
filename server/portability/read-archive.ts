import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { ensureDir } from "../storage/fs.ts";
import {
  classifyEntry,
  manifestSchema,
  SMALL_ENTRY_MAX,
  type EntryKind,
  type ImportLimits,
  type Manifest,
} from "./archive.ts";

/** A refused archive; the message is safe to show (INV-42). */
export class ArchiveError extends Error {
  override name = "ArchiveError";
}

export interface ExtractedEntry {
  name: string;
  kind: EntryKind;
  id: string | null;
  length: number;
  sha256: string;
  /** Staged copy, named by position (never by the archive name). */
  file: string;
}

export interface ExtractedArchive {
  manifest: Manifest;
  /** SHA-256 of the manifest bytes: the duplicate-import key. */
  key: string;
  entries: ExtractedEntry[];
  /** Well-formed but unknown entries, skipped and reported. */
  unknown: string[];
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

export function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false },
      (error, zip) => {
        if (error) reject(new ArchiveError("The file is not a readable ZIP archive"));
        else resolve(zip);
      },
    );
  });
}

export function readStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(new ArchiveError(`Entry ${entry.fileName} can't be read`));
      else resolve(stream);
    });
  });
}

/** Every entry's directory record, checked before any byte is decompressed. */
export async function listEntries(
  zip: yauzl.ZipFile,
  limits: ImportLimits,
): Promise<yauzl.Entry[]> {
  const entries: yauzl.Entry[] = [];
  const seen = new Set<string>();
  let expanded = 0;
  // Every central-directory record counts, directories included.
  let records = 0;
  const deadline = Date.now() + limits.maxMs;
  await new Promise<void>((resolve, reject) => {
    zip.on("error", (error: Error) => {
      // yauzl refuses unsafe names itself (absolute, "..", backslashes).
      reject(
        new ArchiveError(
          /absolute path|invalid relative path|invalid characters/.test(error.message)
            ? "An entry points outside the archive"
            : "The archive is damaged",
        ),
      );
    });
    zip.on("end", () => {
      resolve();
    });
    zip.on("entry", (entry: yauzl.Entry) => {
      try {
        const name = entry.fileName;
        const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
        if (++records > limits.maxEntries)
          throw new ArchiveError(`The archive has more than ${String(limits.maxEntries)} entries`);
        if (mode === S_IFLNK) throw new ArchiveError(`${name} is a symbolic link`);
        if (name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))
          throw new ArchiveError(`${name} points outside the archive`);
        if (name.split("/").length > 4) throw new ArchiveError(`${name} is nested too deeply`);
        if ((entry.generalPurposeBitFlag & 0x1) !== 0)
          throw new ArchiveError(`${name} is encrypted`);
        if (seen.has(name)) throw new ArchiveError(`${name} appears twice`);
        seen.add(name);
        const isDir = name.endsWith("/") || mode === S_IFDIR;
        if (!isDir) {
          expanded += entry.uncompressedSize;
          if (expanded > limits.maxExpandedBytes)
            throw new ArchiveError("The archive expands beyond the size limit");
          if (
            entry.uncompressedSize > 1024 * 1024 &&
            entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxRatio
          )
            throw new ArchiveError(`${name} is compressed suspiciously well (a ZIP bomb?)`);
          entries.push(entry);
        }
        // Checked every 1024 records: a flood of entries can't outrun the
        // time limit, and a small archive meets its own checks first.
        if (records % 1024 === 0 && Date.now() > deadline)
          throw new ArchiveError("Reading the archive took too long");
        zip.readEntry();
      } catch (error) {
        reject(error instanceof ArchiveError ? error : new ArchiveError("The archive is damaged"));
      }
    });
    zip.readEntry();
  });
  return entries;
}

/**
 * Reads, bounds and verifies an uploaded archive (INV-42), extracting each
 * entry into `stagingDir` under a positional name. Checks, in order: the
 * central directory (entry count, names, symlinks, encryption, duplicates,
 * expanded total, compression ratio), the manifest (schema, one record per
 * entry, lengths), then every entry's bytes against its manifest length and
 * SHA-256 while it is decompressed (sizes are enforced as bytes arrive, not
 * trusted from headers). The whole read must finish within `limits.maxMs`.
 */
export async function readArchive(
  file: string,
  stagingDir: string,
  limits: ImportLimits,
): Promise<ExtractedArchive> {
  const deadline = Date.now() + limits.maxMs;
  const zip = await openZip(file);
  try {
    const all = await listEntries(zip, limits);
    const manifestEntry = all.find((e) => e.fileName === "manifest.json");
    if (!manifestEntry) throw new ArchiveError("This is not a ChatUI export (no manifest.json)");
    if (manifestEntry.uncompressedSize > (SMALL_ENTRY_MAX.manifest ?? 0))
      throw new ArchiveError("The manifest is too large");
    const manifestBytes = await collect(
      await readStream(zip, manifestEntry),
      SMALL_ENTRY_MAX.manifest ?? 0,
    );
    let manifest: Manifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    } catch {
      throw new ArchiveError("The manifest is not a supported ChatUI export (format or version)");
    }
    const expected = new Map(manifest.entries.map((e) => [e.path, e]));
    if (expected.size !== manifest.entries.length)
      throw new ArchiveError("The manifest lists an entry twice");
    const unknown: string[] = [];
    const entries: ExtractedEntry[] = [];
    await ensureDir(stagingDir);
    let index = 0;
    for (const entry of all) {
      if (entry === manifestEntry) continue;
      if (Date.now() > deadline) throw new ArchiveError("Reading the archive took too long");
      const kind = classifyEntry(entry.fileName);
      if (!kind || kind.kind === "manifest") {
        unknown.push(entry.fileName.slice(0, 200));
        continue;
      }
      const record = expected.get(entry.fileName);
      if (!record) throw new ArchiveError(`${entry.fileName} is not listed in the manifest`);
      expected.delete(entry.fileName);
      if (record.length !== entry.uncompressedSize)
        throw new ArchiveError(`${entry.fileName} has the wrong length`);
      const cap = SMALL_ENTRY_MAX[kind.kind];
      if (cap !== undefined && record.length > cap)
        throw new ArchiveError(`${entry.fileName} is too large`);
      const target = path.join(stagingDir, String(index++));
      const hash = createHash("sha256");
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > record.length) {
            callback(new ArchiveError(`${entry.fileName} is longer than declared`));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          await readStream(zip, entry),
          counter,
          createWriteStream(target, { mode: 0o600 }),
        );
      } catch (error) {
        throw error instanceof ArchiveError
          ? error
          : new ArchiveError(`${entry.fileName} can't be decompressed`);
      }
      const sha256 = hash.digest("hex");
      if (bytes !== record.length || sha256 !== record.sha256)
        throw new ArchiveError(`${entry.fileName} doesn't match its checksum`);
      entries.push({
        name: entry.fileName,
        kind: kind.kind,
        id: kind.id,
        length: bytes,
        sha256,
        file: target,
      });
    }
    if (expected.size > 0)
      throw new ArchiveError(`The archive is missing ${[...expected.keys()][0] ?? "an entry"}`);
    return {
      manifest,
      key: createHash("sha256").update(manifestBytes).digest("hex"),
      entries,
      unknown,
    };
  } finally {
    zip.close();
  }
}

export async function collect(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > max) throw new ArchiveError("An entry is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

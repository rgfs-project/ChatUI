/**
 * ZIP helpers for tests (Phase 13d): read an archive into memory and build
 * archives, including malicious ones. No path aliases (used by scripts too).
 */
import { createHash } from "node:crypto";
import yauzl from "yauzl";
import yazl from "yazl";

export async function readZip(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, z) => {
      if (error) reject(error);
      else resolve(z);
    });
  });
  const out = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          out.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return out;
}

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** Unix mode (e.g. 0o120777 for a symbolic link). */
  mode?: number;
  compress?: boolean;
}

export async function buildZip(entries: readonly ZipEntry[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const e of entries)
    zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name, {
      ...(e.mode !== undefined ? { mode: e.mode } : {}),
      compress: e.compress ?? true,
      mtime: new Date("2026-01-01T00:00:00Z"),
    });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** A manifest listing `entries` (other than the manifest) with exact checksums. */
export function manifestFor(
  entries: readonly ZipEntry[],
  extra: Record<string, unknown> = {},
): ZipEntry {
  return {
    name: "manifest.json",
    data: JSON.stringify({
      format: "chatui-user-archive",
      version: 1,
      exportId: "11111111-2222-4333-8444-555555555555",
      createdAt: "2026-01-01T00:00:00.000Z",
      generator: { app: "chatui", version: "test" },
      entries: entries.map((e) => {
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
        return { path: e.name, length: data.length, sha256: sha256(data) };
      }),
      activeGenerations: [],
      ...extra,
    }),
  };
}

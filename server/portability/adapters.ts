// Import adapters (Phase 13e, contracts §12, INV-42): every supported source
// is converted into staged ChatUI archive entries, so preview, conflicts,
// remapping, the commit journal and recovery are the Phase 13d machinery
// with no second commit path. Adding a source (e.g. an OpenAI export) is one
// more adapter here, with its own observed-format notes and fixtures.
import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImportItem, ImportSource } from "@shared/portability";
import { ensureDir } from "../storage/fs.ts";
import { entryName, type EntryKind, type ImportLimits } from "./archive.ts";
import {
  ArchiveError,
  listEntries,
  openZip,
  readArchive,
  type ExtractedEntry,
} from "./read-archive.ts";

/** What an upload is converted with. */
export interface UploadContext {
  /** The signed-in user: the only destination (ids in staged metadata). */
  userId: string;
  /** The uploaded bytes, already bounded by `limits.maxArchiveBytes`. */
  file: string;
  /** Staged entries are written here under positional names. */
  stagingDir: string;
  limits: ImportLimits;
  /** Reading must finish by this time (ms since the epoch). */
  deadline: number;
  /** The browser's IANA time zone, for sources whose times have none. */
  timeZone: string | null;
  /** The upload time (ISO), for sources without an export date. */
  now: string;
  /** Destination caps an adapter applies per record (the plan applies quotas). */
  caps: { attachmentMaxBytes: number; artifactMaxBytes: number };
}

/** An upload converted into staged ChatUI entries. */
export interface StagedImport {
  source: ImportSource;
  /** The duplicate-import key: the same export always gives the same key. */
  key: string;
  exportCreatedAt: string;
  entries: ExtractedEntry[];
  /** Entries the source doesn't define, skipped and reported. */
  unknown: string[];
  /** Adapter notes for the preview (skipped tool calls, branches, time zone). */
  notes: string[];
  /** Source records that couldn't be mapped, reported as skipped. */
  skipped: ImportItem[];
}

/** The first bytes of the upload and, for a ZIP, its (bounded, checked) entry names. */
export interface Probe {
  head: Buffer;
  zipEntries: string[] | null;
}

export interface ImportAdapter {
  source: ImportSource;
  /** True when this adapter reads the upload; must be cheap and never throw. */
  detect(probe: Probe): boolean;
  stage(ctx: UploadContext, probe: Probe): Promise<StagedImport>;
}

/** Writes staged entries under positional names and counts canonical records. */
export class StageWriter {
  readonly entries: ExtractedEntry[] = [];
  private records = 0;
  private readonly ctx: UploadContext;

  constructor(ctx: UploadContext) {
    this.ctx = ctx;
  }

  async init(): Promise<this> {
    await ensureDir(this.ctx.stagingDir);
    return this;
  }

  /** Counts `n` canonical records against `limits.maxRecords`, and checks the time. */
  count(n = 1): void {
    this.records += n;
    if (this.records > this.ctx.limits.maxRecords)
      throw new ArchiveError(
        `The export has more than ${String(this.ctx.limits.maxRecords)} records`,
      );
    checkDeadline(this.ctx);
  }

  async add(kind: EntryKind, id: string, bytes: Buffer): Promise<void> {
    const file = path.join(this.ctx.stagingDir, String(this.entries.length));
    await writeFile(file, bytes, { mode: 0o600 });
    this.entries.push({
      name: entryName(kind, id),
      kind,
      id,
      length: bytes.length,
      sha256: sha256(bytes),
      file,
    });
  }
}

export function checkDeadline(ctx: Pick<UploadContext, "deadline">): void {
  if (Date.now() > ctx.deadline) throw new ArchiveError("Reading the archive took too long");
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A stable UUID (RFC 9562 version 8) derived from source identifiers, so
 * importing the same export again finds the same records identical.
 */
export function derivedUuid(...parts: string[]): string {
  const h = sha256(JSON.stringify(parts));
  const variant = ((Number.parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An ISO timestamp (any fraction, `Z` or an offset) as canonical UTC milliseconds. */
export function canonicalTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return null;
  // Milliseconds are kept, finer digits dropped (Date keeps milliseconds).
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// The ChatUI archive (Phase 13d) as an adapter

export const chatuiAdapter: ImportAdapter = {
  source: "chatui",
  detect: (probe) => probe.zipEntries?.includes("manifest.json") === true,
  async stage(ctx) {
    const archive = await readArchive(ctx.file, ctx.stagingDir, {
      ...ctx.limits,
      maxMs: Math.max(0, ctx.deadline - Date.now()),
    });
    return {
      source: "chatui",
      key: archive.key,
      exportCreatedAt: archive.manifest.createdAt,
      entries: archive.entries,
      unknown: archive.unknown,
      notes: [],
      skipped: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Detection

/** Local file header, or the end record of an empty ZIP. */
const ZIP_MAGIC = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])];
const HEAD_BYTES = 4096;

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Entry names of a ZIP, with every central-directory bound checked first. */
async function zipEntryNames(file: string, limits: ImportLimits): Promise<string[]> {
  const zip = await openZip(file);
  try {
    return (await listEntries(zip, limits)).map((e) => e.fileName);
  } finally {
    zip.close();
  }
}

/**
 * Detects the upload's source and converts it with that adapter. A ZIP's
 * directory is bounded (entries, names, symlinks, encryption, duplicates,
 * expanded size, ratio) before any adapter sees it.
 */
export async function stageUpload(
  ctx: UploadContext,
  adapters: readonly ImportAdapter[],
): Promise<StagedImport> {
  const head = await readHead(ctx.file);
  const isZip = ZIP_MAGIC.some((magic) => head.subarray(0, 4).equals(magic));
  const probe: Probe = {
    head,
    zipEntries: isZip ? await zipEntryNames(ctx.file, ctx.limits) : null,
  };
  const adapter = adapters.find((a) => a.detect(probe));
  if (!adapter)
    throw new ArchiveError(
      isZip
        ? "This ZIP is neither a ChatUI export (no manifest.json) nor a Claude data export"
        : "This file isn't a ChatUI export, a Claude data export or a duck.ai chat",
    );
  return adapter.stage(ctx, probe);
}

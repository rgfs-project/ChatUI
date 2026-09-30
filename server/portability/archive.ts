// The portable user archive format, version 1 (Phase 13d, contracts §12, INV-43).
import { z } from "zod";

/**
 * A ZIP with a fixed layout. Every entry name matches exactly one pattern;
 * ids are canonical lowercase UUIDs, so no archive name can reach outside
 * its slot, and a name is never used as a destination path (the importer
 * builds destination paths from validated ids through `DataPaths`).
 *
 * manifest.json                       this manifest (first entry)
 * conversations/<id>.md               exact canonical Markdown bytes (malformed files too)
 * attachments/<id>/meta.json, blob    linked attachments (pending uploads are drafts: excluded)
 * artifacts/<id>/meta.json, blob      finalized artifacts
 * memories/<id>.md                    approved memories
 * proposals/<conversation-id>.json    proposal records with their statuses
 * skills.json, preferences.json       per-user settings
 *
 * Excluded: the account (user.json, password hash), sessions, provider
 * credentials, instance settings and audit, generation checkpoints,
 * operation records, derived indexes and `import-staging/`.
 */
export const ARCHIVE_FORMAT = "chatui-user-archive";
export const ARCHIVE_VERSION = 1;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export type EntryKind =
  | "manifest"
  | "conversation"
  | "attachment-meta"
  | "attachment-blob"
  | "artifact-meta"
  | "artifact-blob"
  | "memory"
  | "proposals"
  | "skills"
  | "preferences";

const PATTERNS: [EntryKind, RegExp][] = [
  ["manifest", /^manifest\.json$/],
  ["conversation", new RegExp(`^conversations/(${UUID})\\.md$`)],
  ["attachment-meta", new RegExp(`^attachments/(${UUID})/meta\\.json$`)],
  ["attachment-blob", new RegExp(`^attachments/(${UUID})/blob$`)],
  ["artifact-meta", new RegExp(`^artifacts/(${UUID})/meta\\.json$`)],
  ["artifact-blob", new RegExp(`^artifacts/(${UUID})/blob$`)],
  ["memory", new RegExp(`^memories/(${UUID})\\.md$`)],
  ["proposals", new RegExp(`^proposals/(${UUID})\\.json$`)],
  ["skills", /^skills\.json$/],
  ["preferences", /^preferences\.json$/],
];

/** The kind and id an entry name denotes, or null for anything else. */
export function classifyEntry(name: string): { kind: EntryKind; id: string | null } | null {
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(name);
    if (match) return { kind, id: match[1] ?? null };
  }
  return null;
}

export function entryName(kind: EntryKind, id?: string): string {
  switch (kind) {
    case "manifest":
      return "manifest.json";
    case "conversation":
      return `conversations/${id ?? ""}.md`;
    case "attachment-meta":
      return `attachments/${id ?? ""}/meta.json`;
    case "attachment-blob":
      return `attachments/${id ?? ""}/blob`;
    case "artifact-meta":
      return `artifacts/${id ?? ""}/meta.json`;
    case "artifact-blob":
      return `artifacts/${id ?? ""}/blob`;
    case "memory":
      return `memories/${id ?? ""}.md`;
    case "proposals":
      return `proposals/${id ?? ""}.json`;
    case "skills":
      return "skills.json";
    case "preferences":
      return "preferences.json";
  }
}

export const manifestSchema = z.strictObject({
  format: z.literal(ARCHIVE_FORMAT),
  version: z.literal(ARCHIVE_VERSION),
  exportId: z.uuid(),
  createdAt: z.iso.datetime(),
  generator: z.strictObject({ app: z.literal("chatui"), version: z.string().max(64) }),
  /** Every other entry with its exact length and SHA-256. */
  entries: z
    .array(
      z.strictObject({
        path: z.string().max(200),
        length: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .max(1_000_000),
  /** Conversations exported while a reply was running (their accepted state). */
  activeGenerations: z.array(z.uuid()),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Bounds for reading an archive (INV-42). */
export interface ImportLimits {
  /** The uploaded (compressed) archive. */
  maxArchiveBytes: number;
  /** Sum of all entries' uncompressed sizes. */
  maxExpandedBytes: number;
  maxEntries: number;
  /** Per-entry uncompressed/compressed ratio allowed for entries above 1 MiB. */
  maxRatio: number;
  /** Preview (validation) and commit each within this time. */
  maxMs: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 50_000,
  maxRatio: 200,
  maxMs: 10 * 60_000,
};

/** Per-kind size caps for the small (JSON/Markdown) entries. */
export const SMALL_ENTRY_MAX: Partial<Record<EntryKind, number>> = {
  manifest: 64 * 1024 * 1024,
  "attachment-meta": 64 * 1024,
  "artifact-meta": 64 * 1024,
  memory: 64 * 1024,
  proposals: 16 * 1024 * 1024,
  skills: 4 * 1024 * 1024,
  preferences: 1024 * 1024,
};

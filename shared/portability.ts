import { z } from "zod";
import { canonicalUuid } from "./ids";

/**
 * Portable export and import (Phase 13d, contracts §12, INV-42/INV-43). The
 * browser imports the types; the server validates with the schemas.
 */

export const exportResultSchema = z.strictObject({
  exportId: z.uuid(),
  createdAt: z.string(),
  /** Archive size in bytes. */
  size: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  /** Conversations exported while a reply was still being generated (accepted state). */
  activeGenerations: z.number().int().nonnegative(),
});
export type ExportResult = z.infer<typeof exportResultSchema>;

export const ITEM_KINDS = [
  "conversation",
  "attachment",
  "artifact",
  "memory",
  "proposals",
  "skill",
  "preferences",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** One archive item and what the import will (or did) do with it. */
export const importItemSchema = z.strictObject({
  kind: z.enum(ITEM_KINDS),
  id: z.string(),
  /** Display label (title, filename, name); never a path. */
  label: z.string(),
  /**
   * new: imported as is; identical: already present, skipped; conflict:
   * differs from an existing item (skipped unless copies are chosen);
   * copy: imported with a remapped id; skipped: not imported (see reason);
   * degraded: imported with a dependency dropped (see reason).
   */
  action: z.enum(["new", "identical", "conflict", "copy", "skipped", "degraded"]),
  reason: z.string().nullable(),
  /** The id it was imported under when remapped. */
  newId: z.string().nullable(),
  /** The canonical bytes differ from the archive (references rewritten). */
  rewritten: z.boolean(),
});
export type ImportItem = z.infer<typeof importItemSchema>;

export const importMemorySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  content: z.string(),
  /** new | identical | conflict (same id differs, or the name is taken). */
  action: z.enum(["new", "identical", "conflict"]),
});

/**
 * Where an import comes from (Phase 13e): a ChatUI archive, a Claude data
 * export, or a duck.ai chat download. Each has its own adapter and notes.
 */
export const IMPORT_SOURCES = ["chatui", "claude", "duckai"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const importPreviewSchema = z.strictObject({
  importId: z.uuid(),
  source: z.enum(IMPORT_SOURCES),
  /** The duplicate-import key (a ChatUI archive: SHA-256 of its manifest). */
  key: z.string(),
  state: z.enum(["previewed", "committing", "committed", "rolled_back", "failed", "cancelled"]),
  createdAt: z.string(),
  exportCreatedAt: z.string(),
  /** A previous import with the same key, if any. */
  previousImport: z.strictObject({ importId: z.string(), committedAt: z.string() }).nullable(),
  counts: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())),
  items: z.array(importItemSchema),
  /** Memories need an explicit selection (none are imported by default). */
  memories: z.array(importMemorySchema),
  warnings: z.array(z.string()),
  /** Present once the import finished (or failed part-way). */
  report: z
    .strictObject({
      committedAt: z.string().nullable(),
      items: z.array(importItemSchema),
      error: z.string().nullable(),
    })
    .nullable(),
  progress: z.strictObject({ done: z.number().int(), total: z.number().int() }),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const importCommitSchema = z.strictObject({
  /** What to do with conflicting items: skip (default) or import them as copies. */
  conflicts: z.enum(["skip", "copy"]).default("skip"),
  /** Memories explicitly selected for import (by archive id). */
  memoryIds: z.array(canonicalUuid).max(10_000).default([]),
});
export type ImportCommit = z.infer<typeof importCommitSchema>;

/** The upload's query: the browser's IANA time zone, for sources without one. */
export const importUploadQuerySchema = z.strictObject({
  tz: z.string().max(64).optional(),
});

export const importParamsSchema = z.strictObject({ id: canonicalUuid });

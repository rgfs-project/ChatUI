/**
 * Operator backup and restore of DATA_DIR (Phase 16, INV-50). Runs from the
 * CLI with the server stopped: the instance lock below refuses while a live
 * server owns the directory. No path aliases (the CLI runs natively).
 *
 * A backup is a directory: `data/` (a copy of DATA_DIR) and `manifest.json`
 * (every file's path, size and SHA-256). It leaves out what is derived or
 * transient: per-user `index/` (rebuilt at startup), `import-staging/`
 * (rolled back by recovery first), sessions (everyone signs in again unless
 * `includeSessions`) and the lock itself. Everything else is included,
 * including unfinished recovery state (operation records, generation
 * checkpoints, memory intents, pending removals), which the restored server
 * finishes at startup. Backups contain secrets (`_system/providers.json`)
 * and all user content.
 *
 * Restore only goes into an empty DATA_DIR, verifies every checksum first,
 * and refuses unlisted, missing, altered, linked or out-of-tree files: it
 * never merges into existing data.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

export const BACKUP_FORMAT = "chatui-backup";
const LOCK_FILE = path.join("_system", "server.lock");

export class BackupError extends Error {}

const manifestSchema = z.strictObject({
  format: z.literal("chatui-backup"),
  version: z.literal(1),
  createdAt: z.string(),
  includesSessions: z.boolean(),
  files: z.array(
    z.strictObject({
      path: z.string().max(4096),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

export interface BackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  includesSessions: boolean;
  files: BackupFile[];
}

/** Relative paths (POSIX) left out of every backup. */
export function excluded(rel: string, includeSessions: boolean): boolean {
  if (rel === "_system/server.lock") return true;
  if (!includeSessions && (rel === "_system/sessions" || rel.startsWith("_system/sessions/")))
    return true;
  const [first, second] = rel.split("/");
  return first !== "_system" && (second === "index" || second === "import-staging");
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const dir = path.join(root, rel);
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new BackupError(`refusing symbolic link: ${child}`);
    if (entry.isDirectory()) found.push(...(await walk(root, child)));
    else if (entry.isFile()) found.push(child);
    else throw new BackupError(`refusing special file: ${child}`);
  }
  return found;
}

async function hashFile(file: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

/** Copies a file, hashing the bytes as written; private permissions. */
async function copyFile(from: string, to: string): Promise<{ size: number; sha256: string }> {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let size = 0;
  const source = createReadStream(from);
  source.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    hash.update(bytes);
    size += bytes.length;
  });
  await pipeline(source, createWriteStream(to, { flags: "wx", mode: 0o600 }));
  const handle = await open(to, "r");
  await handle.sync();
  await handle.close();
  return { size, sha256: hash.digest("hex") };
}

async function emptyOrMissing(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  if (!(await lstat(dir)).isDirectory()) return false;
  return (await readdir(dir)).length === 0;
}

/** A safe relative POSIX path inside the backup: no traversal, no absolute or odd names. */
function safeRelative(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return false;
  return rel.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export async function createBackup(
  dataDir: string,
  dest: string,
  options: { includeSessions?: boolean; now?: () => Date } = {},
): Promise<BackupManifest> {
  const includeSessions = options.includeSessions ?? false;
  if (!existsSync(dataDir)) throw new BackupError(`DATA_DIR does not exist: ${dataDir}`);
  if (!(await emptyOrMissing(dest)))
    throw new BackupError("the backup directory must be new or empty");
  await mkdir(path.join(dest, "data"), { recursive: true, mode: 0o700 });
  const files: BackupFile[] = [];
  for (const rel of (await walk(dataDir)).sort()) {
    if (excluded(rel, includeSessions)) continue;
    const copied = await copyFile(path.join(dataDir, rel), path.join(dest, "data", rel));
    files.push({ path: rel, ...copied });
  }
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    includesSessions: includeSessions,
    files,
  };
  await writeFile(path.join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await verifyBackup(dest);
  return manifest;
}

/** Checks a backup against its manifest; throws on any difference. */
export async function verifyBackup(src: string): Promise<BackupManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(src, "manifest.json"), "utf8"));
  } catch {
    throw new BackupError("no readable manifest.json: not a ChatUI backup");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new BackupError("unsupported backup format or malformed manifest");
  const manifest = parsed.data;
  const listed = new Set<string>();
  for (const file of manifest.files) {
    if (!safeRelative(file.path)) throw new BackupError(`unsafe path in manifest: ${file.path}`);
    if (excluded(file.path, manifest.includesSessions))
      throw new BackupError(`manifest lists an excluded path: ${file.path}`);
    if (listed.has(file.path)) throw new BackupError(`duplicate path in manifest: ${file.path}`);
    listed.add(file.path);
  }
  const present = await walk(path.join(src, "data"));
  for (const rel of present)
    if (!listed.has(rel)) throw new BackupError(`file not in the manifest: ${rel}`);
  for (const file of manifest.files) {
    const target = path.join(src, "data", file.path);
    if (!existsSync(target)) throw new BackupError(`missing file: ${file.path}`);
    const actual = await hashFile(target);
    if (actual.size !== file.size || actual.sha256 !== file.sha256)
      throw new BackupError(`checksum mismatch: ${file.path}`);
  }
  return manifest;
}

/** Restores a verified backup into an empty (or new) DATA_DIR. */
export async function restoreBackup(src: string, dataDir: string): Promise<BackupManifest> {
  if (!(await emptyOrMissing(dataDir)))
    throw new BackupError("DATA_DIR is not empty: restore only into an empty directory");
  const manifest = await verifyBackup(src);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const copied = await copyFile(
        path.join(src, "data", file.path),
        path.join(dataDir, file.path),
      );
      if (copied.sha256 !== file.sha256) throw new BackupError(`checksum mismatch: ${file.path}`);
    }
  } catch (error) {
    // Nothing half-restored is left for a server to start on.
    for (const entry of await readdir(dataDir))
      await rm(path.join(dataDir, entry), { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

// ---- Single-process instance lock -------------------------------------------

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid of a live process holding DATA_DIR, or null. */
export function lockHolder(dataDir: string): number | null {
  const file = path.join(dataDir, LOCK_FILE);
  if (!existsSync(file)) return null;
  try {
    const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    return typeof pid === "number" && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes DATA_DIR for this process (the server, or a backup/restore/rebuild).
 * Refuses while another live process holds it; a stale lock (crashed
 * process) is replaced. Returns the release function.
 */
export async function acquireInstanceLock(dataDir: string): Promise<() => Promise<void>> {
  const holder = lockHolder(dataDir);
  if (holder !== null)
    throw new BackupError(`DATA_DIR is in use by process ${String(holder)}: stop it first`);
  const file = path.join(dataDir, LOCK_FILE);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
    mode: 0o600,
  });
  return async () => {
    await rm(file, { force: true });
  };
}

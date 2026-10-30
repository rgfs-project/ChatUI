// Loaded natively by Node from server/cli.ts: .ts imports only, no aliases.
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DIR_MODE, FILE_MODE, TEMP_FILE_RE } from "./storage/fs.ts";
import { isUuid, SYSTEM_DIR } from "./storage/paths.ts";
import { readLock } from "./storage/instance-lock.ts";

/**
 * Offline backup and restore of DATA_DIR (Phase 16, contracts §1).
 *
 * A backup is a directory: the canonical files at their DATA_DIR paths plus
 * `chatui-backup.json` with each file's size and SHA-256. It holds user
 * content and secrets (providers.json, password hashes): store it like
 * DATA_DIR itself. Left out:
 * - `<user>/index/`: derived, rebuilt at start;
 * - `<user>/import-staging/`: transient (any interrupted import is rolled
 *   back first, by the recovery pass the CLI runs before copying);
 * - temporary `.…tmp` files of unfinished writes;
 * - `_system/sessions/` and `_system/server.lock` unless `includeSessions`
 *   (restored users then sign in again).
 * Unfinished recovery state (operation records, generation checkpoints,
 * memory intents, pending removals) is copied as it is.
 */

export const MANIFEST = "chatui-backup.json";
const FORMAT = "chatui-backup";
const VERSION = 1;

export class BackupError extends Error {}

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface Manifest {
  format: typeof FORMAT;
  version: typeof VERSION;
  createdAt: string;
  chatuiVersion: string;
  includesSessions: boolean;
  files: ManifestFile[];
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Refuses while a server is using DATA_DIR (its lock is fresh). */
export async function assertOffline(dataDir: string): Promise<void> {
  const lock = await readLock(dataDir);
  if (lock)
    throw new BackupError(
      `A ChatUI server (pid ${String(lock.pid)} on ${lock.host}) is using this DATA_DIR. ` +
        "Stop it first, or back up a filesystem snapshot instead.",
    );
}

function excluded(relative: string, includeSessions: boolean): boolean {
  const parts = relative.split(path.sep);
  const [top, second] = parts;
  if (TEMP_FILE_RE.test(parts.at(-1) ?? "")) return true;
  if (top === SYSTEM_DIR) {
    if (second === "server.lock") return true;
    if (second === "sessions" && !includeSessions) return true;
    return false;
  }
  return second === "index" || second === "import-staging";
}

/** A path from a manifest: relative, normalized, under an account or `_system`. */
function safeRelative(relative: string): boolean {
  if (relative === "" || path.isAbsolute(relative) || relative.includes("\0")) return false;
  const normal = path.posix.normalize(relative);
  if (normal !== relative || normal.startsWith("../") || normal === "..") return false;
  const top = normal.split("/")[0] ?? "";
  return top === SYSTEM_DIR || isUuid(top);
}

async function walk(root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = dir ? path.join(dir, entry.name) : entry.name;
    if (entry.isSymbolicLink())
      throw new BackupError(`Refusing to follow a symbolic link: ${relative}`);
    if (entry.isDirectory()) out.push(...(await walk(root, relative)));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Copies DATA_DIR into `out` (a new or empty directory) and writes the manifest. */
export async function createBackup(options: {
  dataDir: string;
  out: string;
  includeSessions: boolean;
  chatuiVersion: string;
  now?: () => Date;
}): Promise<{ files: number; bytes: number }> {
  const dataDir = path.resolve(options.dataDir);
  const out = path.resolve(options.out);
  if (out === dataDir || out.startsWith(`${dataDir}${path.sep}`))
    throw new BackupError("The backup must not be inside DATA_DIR");
  if (!(await isEmptyDir(out))) throw new BackupError(`${out} is not empty`);
  await mkdir(out, { recursive: true, mode: DIR_MODE });
  const files: ManifestFile[] = [];
  let bytes = 0;
  // Only ChatUI's own top level: account directories and _system.
  const tops = (await readdir(dataDir, { withFileTypes: true })).filter(
    (e) => e.isDirectory() && (e.name === SYSTEM_DIR || isUuid(e.name)),
  );
  const relatives: string[] = [];
  for (const top of tops) relatives.push(...(await walk(dataDir, top.name)));
  for (const relative of relatives) {
    if (excluded(relative, options.includeSessions)) continue;
    const posix = relative.split(path.sep).join("/");
    if (!safeRelative(posix)) continue;
    const source = path.join(dataDir, relative);
    const data = await readFile(source);
    const target = path.join(out, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });
    await writeFile(target, data, { mode: FILE_MODE, flag: "wx" });
    files.push({ path: posix, size: data.length, sha256: sha256(data) });
    bytes += data.length;
  }
  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    chatuiVersion: options.chatuiVersion,
    includesSessions: options.includeSessions,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeFile(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: FILE_MODE,
    flag: "wx",
  });
  return { files: files.length, bytes };
}

async function readManifest(from: string): Promise<Manifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(from, MANIFEST), "utf8"));
  } catch {
    throw new BackupError(`${from} has no readable ${MANIFEST}; is it a ChatUI backup?`);
  }
  const m = raw as Partial<Manifest>;
  if (m.format !== FORMAT || m.version !== VERSION || !Array.isArray(m.files))
    throw new BackupError("Unsupported backup format or version");
  for (const f of m.files) {
    if (
      typeof f.path !== "string" ||
      !safeRelative(f.path) ||
      typeof f.size !== "number" ||
      typeof f.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(f.sha256)
    )
      throw new BackupError(`Invalid manifest entry: ${JSON.stringify(f).slice(0, 120)}`);
  }
  return m as Manifest;
}

/**
 * Checks a backup completely, then copies it into an empty DATA_DIR. Every
 * file must match its manifest checksum, and a file the manifest does not
 * list is refused rather than merged. Nothing is written until all checks pass.
 */
export async function restoreBackup(options: {
  from: string;
  dataDir: string;
}): Promise<{ files: number; bytes: number }> {
  const from = path.resolve(options.from);
  const dataDir = path.resolve(options.dataDir);
  if (!(await isEmptyDir(dataDir)))
    throw new BackupError(`DATA_DIR ${dataDir} is not empty; restore only into empty state`);
  const manifest = await readManifest(from);
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  if (listed.size !== manifest.files.length) throw new BackupError("The manifest repeats a file");
  const present = (await walk(from))
    .map((p) => p.split(path.sep).join("/"))
    .filter((p) => p !== MANIFEST);
  const unknown = present.filter((p) => !listed.has(p));
  if (unknown.length > 0)
    throw new BackupError(
      `The backup holds files its manifest does not list: ${unknown.slice(0, 5).join(", ")}`,
    );
  let bytes = 0;
  for (const file of manifest.files) {
    const source = path.join(from, ...file.path.split("/"));
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) throw new BackupError(`Missing from the backup: ${file.path}`);
    const data = await readFile(source);
    if (data.length !== file.size || sha256(data) !== file.sha256)
      throw new BackupError(`Checksum mismatch: ${file.path}`);
    bytes += data.length;
  }
  await mkdir(dataDir, { recursive: true, mode: DIR_MODE });
  try {
    for (const file of manifest.files) {
      const target = path.join(dataDir, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });
      await copyFile(path.join(from, ...file.path.split("/")), target);
      await chmod(target, FILE_MODE);
    }
  } catch (error) {
    // Leave empty state behind, never half a restore.
    for (const name of await readdir(dataDir))
      await rm(path.join(dataDir, name), { recursive: true, force: true });
    throw error;
  }
  return { files: manifest.files.length, bytes };
}

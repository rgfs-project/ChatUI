// Durable file primitives (contracts §2). Loadable natively by Node.
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Temp files are `.<name>.<16 hex>.tmp` in the target's directory. */
export const TEMP_FILE_RE = /^\..+\.[0-9a-f]{16}\.tmp$/;

export interface WriteHooks {
  /** Test hook: runs after the temp file is fsynced, before rename (simulated crash). */
  beforeRename?: () => void | Promise<void>;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
}

async function fsyncDirectory(dir: string): Promise<void> {
  // Directory fsync is unavailable on Windows (documented); best effort elsewhere.
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomic durable replace: write a temp file in the same directory, fsync it,
 * rename over the target, fsync the directory. A crash at any point leaves
 * either the old or the new file, never a partial one.
 */
export async function atomicWrite(
  target: string,
  data: string | Uint8Array,
  hooks: WriteHooks = {},
): Promise<void> {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", FILE_MODE);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await hooks.beforeRename?.();
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(dir);
}

/** Durable delete of a file; missing files are fine. */
export async function durableUnlink(target: string): Promise<boolean> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fsyncDirectory(path.dirname(target));
  return true;
}

export async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Startup cleanup: removes temp files (by name pattern) older than the process
 * start anywhere under `root`. Never removes anything else. Returns the count.
 */
export async function cleanupTempFiles(
  root: string,
  startedAt: Date,
  maxDepth = 4,
): Promise<number> {
  let removed = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && TEMP_FILE_RE.test(entry.name)) {
        const info = await stat(full);
        if (info.mtime < startedAt) {
          await rm(full, { force: true });
          removed++;
        }
      }
    }
  };
  await walk(root, 0);
  return removed;
}

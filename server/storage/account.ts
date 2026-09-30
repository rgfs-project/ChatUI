// Account write guard (contracts §6 account closure, INV-61). Loadable natively by Node.
import { ensureDir, readOrNull } from "./fs.ts";
import type { UserBarrier } from "./locks.ts";
import type { DataPaths } from "./paths.ts";

/** The account no longer accepts writes (being closed, or gone). */
export class AccountClosedError extends Error {
  override name = "AccountClosedError";
  readonly userId: string;
  constructor(userId: string) {
    super("The account is closed");
    this.userId = userId;
  }
}

/** Throws unless `userId` has a user.json that is not `closing`. */
export async function assertAccountWritable(paths: DataPaths, userId: string): Promise<void> {
  const bytes = await readOrNull(paths.userFile(userId));
  if (!bytes) throw new AccountClosedError(userId);
  let status: unknown;
  try {
    status = (JSON.parse(bytes.toString("utf8")) as { status?: unknown }).status;
  } catch {
    throw new AccountClosedError(userId);
  }
  if (status === "closing") throw new AccountClosedError(userId);
}

/**
 * Runs one write into a user's directory: under the shared account barrier,
 * after rechecking that the account exists and is not closing. Closure takes
 * the barrier exclusively, so a writer either finishes before the directory
 * is renamed away or aborts here, and never recreates a removed user root.
 */
export class AccountWrites {
  private readonly paths: DataPaths;
  private readonly barrier: UserBarrier;

  constructor(paths: DataPaths, barrier: UserBarrier) {
    this.paths = paths;
    this.barrier = barrier;
  }

  run<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.barrier.shared(userId, async () => {
      await assertAccountWritable(this.paths, userId);
      return fn();
    });
  }

  /**
   * The export snapshot (contracts §2, §12): the per-user barrier held
   * exclusively, so no canonical write is in progress while small files are
   * copied. `fn` must not write through `run` (it would wait for itself).
   */
  exclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.barrier.exclusive(userId, async () => {
      await assertAccountWritable(this.paths, userId);
      return fn();
    });
  }

  /** mkdir -p of a subdirectory inside an existing user root (never the root itself). */
  async ensureSubdir(userId: string, dir: string): Promise<void> {
    await assertAccountWritable(this.paths, userId);
    await ensureDir(dir);
  }
}

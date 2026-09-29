// Canonical per-user preferences (contracts §12, INV-34). Loadable natively.
import { atomicWrite, readOrNull } from "./fs.ts";
import type { AccountWrites } from "./account.ts";
import type { KeyedLocks } from "./locks.ts";
import { isUuid, type DataPaths } from "./paths.ts";

/**
 * `null` means unset (use the default); an explicit value, including 0, is
 * kept as set. Unknown fields in the file are preserved on write.
 */
export interface Preferences {
  version: 1;
  /** Pinned conversation ids (UI ordering hints; never deleted by index rebuilds). */
  pins: string[];
  defaultProvider: string | null;
  defaultModel: string | null;
  /** Whether earlier turns' images are sent again (Phase 12). */
  historyImages: "include" | "omit" | null;
  /** Client-side image shrink edge in pixels (Phase 12); 0 = never shrink. */
  imageMaxEdge: number | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  pins: [],
  defaultProvider: null,
  defaultModel: null,
  historyImages: null,
  imageMaxEdge: null,
};

function sanitize(raw: unknown): { prefs: Preferences; extra: Record<string, unknown> } {
  if (typeof raw !== "object" || raw === null)
    return { prefs: { ...DEFAULT_PREFERENCES }, extra: {} };
  const r = raw as Record<string, unknown>;
  const {
    version: _v,
    pins,
    defaultProvider,
    defaultModel,
    historyImages,
    imageMaxEdge,
    ...extra
  } = r;
  return {
    prefs: {
      version: 1,
      pins: Array.isArray(pins)
        ? pins.filter((p): p is string => typeof p === "string" && isUuid(p)).slice(0, 500)
        : [],
      defaultProvider: typeof defaultProvider === "string" ? defaultProvider : null,
      defaultModel: typeof defaultModel === "string" ? defaultModel : null,
      historyImages: historyImages === "include" || historyImages === "omit" ? historyImages : null,
      imageMaxEdge:
        typeof imageMaxEdge === "number" && Number.isInteger(imageMaxEdge) && imageMaxEdge >= 0
          ? imageMaxEdge
          : null,
    },
    extra,
  };
}

export class PreferencesStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;

  private readonly writes: AccountWrites | undefined;

  constructor(paths: DataPaths, locks: KeyedLocks, writes?: AccountWrites) {
    this.paths = paths;
    this.locks = locks;
    this.writes = writes;
  }

  /** Missing or corrupt files degrade to defaults field by field. */
  async get(userId: string): Promise<Preferences> {
    const bytes = await readOrNull(this.paths.preferencesFile(userId));
    if (!bytes) return { ...DEFAULT_PREFERENCES };
    try {
      return sanitize(JSON.parse(bytes.toString("utf8"))).prefs;
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  /** Applies a partial update under the per-user lock, preserving other fields. */
  async update(userId: string, patch: Partial<Omit<Preferences, "version">>): Promise<Preferences> {
    const write = () =>
      this.locks.run(`preferences:${userId}`, async () => {
        const bytes = await readOrNull(this.paths.preferencesFile(userId));
        let current: ReturnType<typeof sanitize>;
        try {
          current = sanitize(bytes ? JSON.parse(bytes.toString("utf8")) : undefined);
        } catch {
          current = sanitize(undefined);
        }
        const next: Preferences = { ...current.prefs, ...patch, version: 1 };
        await atomicWrite(
          this.paths.preferencesFile(userId),
          `${JSON.stringify({ ...current.extra, ...next }, null, 2)}\n`,
        );
        return next;
      });
    return this.writes ? this.writes.run(userId, write) : write();
  }
}

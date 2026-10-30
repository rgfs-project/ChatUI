// Canonical per-user preferences (contracts §12, INV-34). Loadable natively.
import { atomicWrite, readOrNull } from "./fs.ts";
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
  /** Projects (Phase 13g): named folders, in display order. */
  projects: Project[];
  /** Conversation id → project id (a chat is in at most one project). */
  chatProjects: Record<string, string>;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export const MAX_PROJECTS = 100;
export const PROJECT_NAME_MAX = 60;

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  pins: [],
  defaultProvider: null,
  defaultModel: null,
  historyImages: null,
  imageMaxEdge: null,
  projects: [],
  chatProjects: {},
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
    projects,
    chatProjects,
    ...extra
  } = r;
  const validProjects = Array.isArray(projects)
    ? (projects as unknown[])
        .filter(
          (p): p is Project =>
            typeof p === "object" &&
            p !== null &&
            typeof (p as Project).id === "string" &&
            isUuid((p as Project).id) &&
            typeof (p as Project).name === "string" &&
            typeof (p as Project).createdAt === "string",
        )
        .slice(0, MAX_PROJECTS)
    : [];
  const projectIds = new Set(validProjects.map((p) => p.id));
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
      projects: validProjects,
      chatProjects:
        typeof chatProjects === "object" && chatProjects !== null && !Array.isArray(chatProjects)
          ? Object.fromEntries(
              Object.entries(chatProjects as Record<string, unknown>).filter(
                (e): e is [string, string] =>
                  isUuid(e[0]) && typeof e[1] === "string" && projectIds.has(e[1]),
              ),
            )
          : {},
    },
    extra,
  };
}

export class PreferencesStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;

  constructor(paths: DataPaths, locks: KeyedLocks) {
    this.paths = paths;
    this.locks = locks;
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

  /** Drops pins of conversations that no longer exist (under the lock; INV-34). */
  /** A deleted conversation's pin and project place go with it (INV-34 keeps the rest). */
  async removePins(userId: string, ids: readonly string[]): Promise<void> {
    const current = await this.get(userId);
    if (
      !current.pins.some((id) => ids.includes(id)) &&
      !ids.some((id) => id in current.chatProjects)
    )
      return;
    await this.update(userId, {}, (prefs) => ({
      pins: prefs.pins.filter((id) => !ids.includes(id)),
      chatProjects: Object.fromEntries(
        Object.entries(prefs.chatProjects).filter(([id]) => !ids.includes(id)),
      ),
    }));
  }

  /** Applies a partial update under the per-user lock, preserving other fields. */
  async update(
    userId: string,
    patch: Partial<Omit<Preferences, "version">>,
    /** Computes more changes from the current value, still under the lock. */
    derive?: (current: Preferences) => Partial<Omit<Preferences, "version">>,
  ): Promise<Preferences> {
    return this.locks.run(`preferences:${userId}`, async () => {
      const bytes = await readOrNull(this.paths.preferencesFile(userId));
      let current: ReturnType<typeof sanitize>;
      try {
        current = sanitize(bytes ? JSON.parse(bytes.toString("utf8")) : undefined);
      } catch {
        current = sanitize(undefined);
      }
      const next: Preferences = {
        ...current.prefs,
        ...patch,
        ...derive?.(current.prefs),
        version: 1,
      };
      await atomicWrite(
        this.paths.preferencesFile(userId),
        `${JSON.stringify({ ...current.extra, ...next }, null, 2)}\n`,
      );
      return next;
    });
  }
}

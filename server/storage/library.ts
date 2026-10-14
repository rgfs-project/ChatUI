// Canonical per-user library: projects, which chat is in which project, and
// the archive (`<user>/library.json`).
import { randomUUID } from "node:crypto";
import { ErrorCode } from "@shared/errors";
import { LIBRARY_LIMITS } from "@shared/library-limits";
import { AppError } from "../errors.ts";
import type { AccountWrites } from "./account.ts";
import { atomicWrite, readOrNull } from "./fs.ts";
import type { KeyedLocks } from "./locks.ts";
import { isUuid, type DataPaths } from "./paths.ts";

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Like preferences: UI organisation, never touched by index rebuilds, and a
 * missing or corrupt file degrades to empty field by field. Entries for chats
 * that no longer exist are ignored on read and dropped when a chat is deleted.
 */
export interface Library {
  version: 1;
  projects: Project[];
  /** Conversation id → project id. */
  assignments: Record<string, string>;
  /** Archived conversation ids. */
  archived: string[];
}

const EMPTY: Library = { version: 1, projects: [], assignments: {}, archived: [] };

const MAX_ARCHIVED = 100_000;

function sanitize(raw: unknown): Library {
  if (typeof raw !== "object" || raw === null) return structuredClone(EMPTY);
  const r = raw as Record<string, unknown>;
  const projects: Project[] = Array.isArray(r.projects)
    ? r.projects
        .filter(
          (p): p is Project =>
            typeof p === "object" &&
            p !== null &&
            isUuid((p as Project).id) &&
            typeof (p as Project).name === "string" &&
            typeof (p as Project).createdAt === "string" &&
            typeof (p as Project).updatedAt === "string",
        )
        .slice(0, LIBRARY_LIMITS.maxProjects)
        .map((p) => ({
          id: p.id,
          name: p.name.slice(0, LIBRARY_LIMITS.projectName),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }))
    : [];
  const projectIds = new Set(projects.map((p) => p.id));
  const assignments: Record<string, string> = {};
  if (typeof r.assignments === "object" && r.assignments !== null)
    for (const [chat, project] of Object.entries(r.assignments as Record<string, unknown>))
      if (isUuid(chat) && typeof project === "string" && projectIds.has(project))
        assignments[chat] = project;
  const archived = Array.isArray(r.archived)
    ? [
        ...new Set(r.archived.filter((id): id is string => typeof id === "string" && isUuid(id))),
      ].slice(0, MAX_ARCHIVED)
    : [];
  return { version: 1, projects, assignments, archived };
}

function withoutChat(assignments: Record<string, string>, chatId: string) {
  return Object.fromEntries(Object.entries(assignments).filter(([chat]) => chat !== chatId));
}

export class LibraryStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly writes: AccountWrites | undefined;
  private readonly now: () => Date;

  constructor(options: {
    paths: DataPaths;
    locks: KeyedLocks;
    writes?: AccountWrites;
    now?: () => Date;
  }) {
    this.paths = options.paths;
    this.locks = options.locks;
    this.writes = options.writes;
    this.now = options.now ?? (() => new Date());
  }

  async get(userId: string): Promise<Library> {
    const bytes = await readOrNull(this.paths.libraryFile(userId));
    if (!bytes) return structuredClone(EMPTY);
    try {
      return sanitize(JSON.parse(bytes.toString("utf8")));
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Read-modify-write under the per-user lock; `change` may throw to refuse. */
  private async modify<T>(userId: string, change: (current: Library) => T): Promise<T> {
    const write = () =>
      this.locks.run(`library:${userId}`, async () => {
        const current = await this.get(userId);
        const result = change(current);
        await atomicWrite(this.paths.libraryFile(userId), `${JSON.stringify(current, null, 2)}\n`);
        return result;
      });
    return this.writes ? this.writes.run(userId, write) : write();
  }

  async createProject(userId: string, name: string): Promise<Project> {
    return this.modify(userId, (library) => {
      if (library.projects.length >= LIBRARY_LIMITS.maxProjects)
        throw new AppError(
          ErrorCode.VALIDATION,
          `At most ${String(LIBRARY_LIMITS.maxProjects)} projects`,
        );
      const time = this.now().toISOString();
      const project = { id: randomUUID(), name, createdAt: time, updatedAt: time };
      library.projects.push(project);
      return project;
    });
  }

  async renameProject(userId: string, id: string, name: string): Promise<Project> {
    return this.modify(userId, (library) => {
      const project = library.projects.find((p) => p.id === id);
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, "Project not found");
      project.name = name;
      project.updatedAt = this.now().toISOString();
      return { ...project };
    });
  }

  /** Deletes the project; its chats stay, outside any project. */
  async deleteProject(userId: string, id: string): Promise<void> {
    await this.modify(userId, (library) => {
      if (!library.projects.some((p) => p.id === id))
        throw new AppError(ErrorCode.NOT_FOUND, "Project not found");
      library.projects = library.projects.filter((p) => p.id !== id);
      library.assignments = Object.fromEntries(
        Object.entries(library.assignments).filter(([, project]) => project !== id),
      );
    });
  }

  /** The caller has checked the chat exists. */
  async assign(userId: string, chatId: string, projectId: string | null): Promise<void> {
    await this.modify(userId, (library) => {
      if (projectId === null) {
        library.assignments = withoutChat(library.assignments, chatId);
        return;
      }
      if (!library.projects.some((p) => p.id === projectId))
        throw new AppError(ErrorCode.NOT_FOUND, "Project not found");
      library.assignments[chatId] = projectId;
    });
  }

  /** The caller has checked the chat exists (when archiving). */
  async setArchived(
    userId: string,
    chatIds: readonly string[],
    archived: boolean,
  ): Promise<number> {
    return this.modify(userId, (library) => {
      const set = new Set(library.archived);
      let changed = 0;
      for (const id of chatIds) {
        if (archived === set.has(id)) continue;
        if (archived) set.add(id);
        else set.delete(id);
        changed++;
      }
      if (set.size > MAX_ARCHIVED)
        throw new AppError(ErrorCode.VALIDATION, "Too many archived conversations");
      library.archived = [...set];
      return changed;
    });
  }

  /** A chat was deleted: its project membership and archive entry go too. */
  async forget(userId: string, chatId: string): Promise<void> {
    const library = await this.get(userId);
    if (!(chatId in library.assignments) && !library.archived.includes(chatId)) return;
    await this.modify(userId, (current) => {
      current.assignments = withoutChat(current.assignments, chatId);
      current.archived = current.archived.filter((id) => id !== chatId);
    });
  }
}

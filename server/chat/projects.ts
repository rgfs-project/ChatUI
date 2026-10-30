// Projects (Phase 13g): named folders for chats, kept in preferences.json
// next to pins (user-owned organization, INV-34). A chat is in at most one
// project; deleting a project keeps its chats.
import { randomUUID } from "node:crypto";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import type { ConversationStore } from "../storage/conversations.ts";
import {
  MAX_PROJECTS,
  PROJECT_NAME_MAX,
  type Preferences,
  type PreferencesStore,
} from "../storage/preferences.ts";
import type { TemporaryChats } from "../storage/temporary.ts";

const CONTROL = /[\p{Cc}\u2028\u2029]/u;

function validName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "" || Array.from(name).length > PROJECT_NAME_MAX || CONTROL.test(name))
    throw new AppError(ErrorCode.VALIDATION, "A project name is 1–60 characters on one line");
  return name;
}

const key = (name: string) => name.normalize("NFC").toLowerCase();

export class ProjectService {
  private readonly preferences: PreferencesStore;
  private readonly store: ConversationStore;
  private readonly temporary: TemporaryChats | undefined;
  private readonly now: () => Date;

  constructor(options: {
    preferences: PreferencesStore;
    store: ConversationStore;
    temporary?: TemporaryChats;
    now?: () => Date;
  }) {
    this.preferences = options.preferences;
    this.store = options.store;
    this.temporary = options.temporary;
    this.now = options.now ?? (() => new Date());
  }

  private unique(prefs: Preferences, name: string, except?: string): void {
    if (prefs.projects.some((p) => p.id !== except && key(p.name) === key(name)))
      throw new AppError(ErrorCode.CONFLICT, "You already have a project with this name");
  }

  create(userId: string, rawName: string): Promise<Preferences> {
    const name = validName(rawName);
    return this.preferences.update(userId, {}, (prefs) => {
      this.unique(prefs, name);
      if (prefs.projects.length >= MAX_PROJECTS)
        throw new AppError(ErrorCode.VALIDATION, "You have reached the maximum number of projects");
      return {
        projects: [
          ...prefs.projects,
          { id: randomUUID(), name, createdAt: this.now().toISOString() },
        ],
      };
    });
  }

  rename(userId: string, id: string, rawName: string): Promise<Preferences> {
    const name = validName(rawName);
    return this.preferences.update(userId, {}, (prefs) => {
      if (!prefs.projects.some((p) => p.id === id))
        throw new AppError(ErrorCode.NOT_FOUND, "Project not found");
      this.unique(prefs, name, id);
      return { projects: prefs.projects.map((p) => (p.id === id ? { ...p, name } : p)) };
    });
  }

  /** Removes the project; its chats stay, out of any project. */
  delete(userId: string, id: string): Promise<Preferences> {
    return this.preferences.update(userId, {}, (prefs) => {
      if (!prefs.projects.some((p) => p.id === id))
        throw new AppError(ErrorCode.NOT_FOUND, "Project not found");
      return {
        projects: prefs.projects.filter((p) => p.id !== id),
        chatProjects: Object.fromEntries(
          Object.entries(prefs.chatProjects).filter(([, project]) => project !== id),
        ),
      };
    });
  }

  /** Moves a chat into a project, or out of any (null). Temporary chats can't be moved. */
  move(userId: string, conversationId: string, projectId: string | null): Promise<Preferences> {
    if (!this.store.list(userId).some((entry) => entry.id === conversationId))
      throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
    if (this.temporary?.has(userId, conversationId))
      throw new AppError(ErrorCode.VALIDATION, "A temporary chat can't be moved to a project");
    return this.preferences.update(userId, {}, (prefs) => {
      if (projectId !== null && !prefs.projects.some((p) => p.id === projectId))
        throw new AppError(ErrorCode.NOT_FOUND, "Project not found");
      const next = Object.fromEntries(
        Object.entries(prefs.chatProjects).filter(([id]) => id !== conversationId),
      );
      if (projectId !== null) next[conversationId] = projectId;
      return { chatProjects: next };
    });
  }
}

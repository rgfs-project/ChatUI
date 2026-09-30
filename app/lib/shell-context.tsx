import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AttachmentDto } from "@shared/attachments";

/** A message typed while a reply was streaming; sent when the reply finishes. */
export interface QueuedMessage {
  id: string;
  content: string;
  /** The (providerId, modelId) chosen when it was queued. */
  pair: [string, string];
  /** Uploaded attachments sent with it (Phase 12). */
  attachments?: AttachmentDto[];
}

/**
 * Shell-owned client state that survives route changes (INV-53): composer
 * drafts per conversation (tab memory only, never browser storage), the
 * last (provider, model) choice per conversation plus the last-used pair,
 * and the per-conversation queue of messages waiting for a reply to finish.
 */
export interface ShellState {
  getDraft(key: string): string;
  setDraft(key: string, value: string): void;
  clearDraft(key: string): void;
  getModel(key: string): [string, string] | null;
  setModel(key: string, pair: [string, string]): void;
  /** Stable array per key (a new one only when that queue changes). */
  getQueue(key: string): readonly QueuedMessage[];
  enqueue(key: string, message: QueuedMessage): void;
  removeQueued(key: string, id: string): void;
  /** Removes and returns the whole queue for `key`. */
  takeQueue(key: string): QueuedMessage[];
  /** Moves a queue to another key (the draft becoming a conversation). */
  moveQueue(from: string, to: string): void;
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY: readonly QueuedMessage[] = Object.freeze([]);

function createShellState(): ShellState {
  const drafts = new Map<string, string>();
  const models = new Map<string, [string, string]>();
  const queues = new Map<string, readonly QueuedMessage[]>();
  const listeners = new Set<() => void>();
  let lastModel: [string, string] | null = null;
  const setQueue = (key: string, next: readonly QueuedMessage[]) => {
    if (next.length === 0) queues.delete(key);
    else queues.set(key, next);
    for (const listener of listeners) listener();
  };
  return {
    getDraft: (key) => drafts.get(key) ?? "",
    setDraft: (key, value) => {
      drafts.set(key, value);
    },
    clearDraft: (key) => {
      drafts.delete(key);
    },
    // Per-conversation choice, falling back to the user's last-used pair.
    getModel: (key) => models.get(key) ?? lastModel,
    setModel: (key, pair) => {
      models.set(key, pair);
      lastModel = pair;
    },
    getQueue: (key) => queues.get(key) ?? EMPTY,
    enqueue: (key, message) => {
      setQueue(key, [...(queues.get(key) ?? []), message]);
    },
    removeQueued: (key, id) => {
      setQueue(
        key,
        (queues.get(key) ?? []).filter((m) => m.id !== id),
      );
    },
    takeQueue: (key) => {
      const taken = [...(queues.get(key) ?? [])];
      if (taken.length > 0) setQueue(key, []);
      return taken;
    },
    moveQueue: (from, to) => {
      const moving = queues.get(from);
      if (!moving || from === to) return;
      queues.delete(from);
      setQueue(to, [...(queues.get(to) ?? []), ...moving]);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const ShellContext = createContext<ShellState | null>(null);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [state] = useState(createShellState);
  return <ShellContext.Provider value={state}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell outside ShellProvider");
  return value;
}

/** The queued messages for one conversation (or the new-chat draft). */
export function useQueue(key: string): readonly QueuedMessage[] {
  const shell = useShell();
  return useSyncExternalStore(
    shell.subscribe,
    () => shell.getQueue(key),
    () => EMPTY,
  );
}

/** Draft key for the unsaved new chat. */
export const NEW_DRAFT = "new";

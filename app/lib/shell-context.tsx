import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * Shell-owned client state that survives route changes (INV-53): composer
 * drafts per conversation (tab memory only, never browser storage) and the
 * last (provider, model) choice per conversation plus the last-used pair.
 */
export interface ShellState {
  getDraft(key: string): string;
  setDraft(key: string, value: string): void;
  clearDraft(key: string): void;
  getModel(key: string): [string, string] | null;
  setModel(key: string, pair: [string, string]): void;
}

function createShellState(): ShellState {
  const drafts = new Map<string, string>();
  const models = new Map<string, [string, string]>();
  let lastModel: [string, string] | null = null;
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

/** Draft key for the unsaved new chat. */
export const NEW_DRAFT = "new";

import { useSyncExternalStore } from "react";
import type { SessionDto } from "@shared/auth";

/**
 * The browser's view of the session. The server is the authority: this only
 * holds the CSRF token for mutations and notices when the session ended.
 */
export interface SessionState {
  session: SessionDto | null;
  /** A request came back 401: the session ended while the page was open. */
  expired: boolean;
}

let state: SessionState = { session: null, expired: false };
const listeners = new Set<() => void>();

function emit(next: SessionState) {
  state = next;
  for (const listener of listeners) listener();
}

export const sessionStore = {
  get: () => state,
  set: (session: SessionDto) => {
    emit({ session, expired: session.user === null && state.session?.user != null });
  },
  expire: () => {
    if (!state.expired) emit({ ...state, expired: true });
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

const serverState: SessionState = { session: null, expired: false };

export function useSessionState(): SessionState {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get, () => serverState);
}

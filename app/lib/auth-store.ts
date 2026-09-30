import { useSyncExternalStore } from "react";
import { useRouteLoaderData } from "react-router";
import type { SessionDto } from "@shared/auth";

/**
 * Browser authentication state (contracts §5, §12). Explicitly
 * `unknown | authenticated | unauthenticated`: the SSR session seeds it, so a
 * first render never flashes a login form or private content. Module state is
 * only ever mutated in the browser (event handlers and effects), never during
 * SSR.
 */
export type AuthStatus = "unknown" | "authenticated" | "unauthenticated";

export interface AuthState {
  /** False until the browser has applied the SSR session (server renders derive it). */
  initialized: boolean;
  status: AuthStatus;
  session: SessionDto | null;
  /** Increments on every observed change of signed-in account. */
  epoch: number;
  /** The account whose session expired mid-use (re-authentication pending). */
  expired: { userId: string; username: string } | null;
}

const INITIAL: AuthState = {
  initialized: false,
  status: "unknown",
  session: null,
  epoch: 0,
  expired: null,
};

let state: AuthState = INITIAL;
const listeners = new Set<() => void>();

function set(next: AuthState): void {
  state = next;
  for (const listener of listeners) listener();
}

function userOf(session: SessionDto | null): string | null {
  return session?.user?.id ?? null;
}

export const authStore = {
  get: (): AuthState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** A server-provided session (SSR bootstrap, loader revalidation, login). */
  applySession(session: SessionDto): void {
    const next = userOf(session);
    const previous = state.expired?.userId ?? userOf(state.session);
    // An anonymous revalidation while re-authentication is pending keeps the dialog.
    if (!next && state.expired) {
      set({ ...state, initialized: true, status: "unauthenticated", session });
      return;
    }
    const changed = state.initialized && previous !== next;
    set({
      initialized: true,
      status: next ? "authenticated" : "unauthenticated",
      session,
      epoch: changed ? state.epoch + 1 : state.epoch,
      expired: null,
    });
  },

  /**
   * Any 401 mid-use: move to `unauthenticated` exactly once and remember whose
   * session it was, so only that user's re-authentication restores the draft.
   */
  expire(): void {
    const user = state.session?.user;
    if (state.status !== "authenticated" || !user) return;
    set({
      ...state,
      status: "unauthenticated",
      session: state.session ? { ...state.session, user: null, csrfToken: null } : null,
      expired: { userId: user.id, username: user.username },
    });
  },

  /** Explicit sign-out: no re-authentication dialog, nothing kept. */
  signedOut(): void {
    set({
      initialized: true,
      status: "unauthenticated",
      session: state.session ? { ...state.session, user: null, csrfToken: null } : null,
      epoch: state.epoch + 1,
      expired: null,
    });
  },
};

/** Test helper: back to the pre-bootstrap state (one page load per test). */
export function resetAuthStoreForTests(): void {
  state = INITIAL;
  listeners.clear();
}

function derive(session: SessionDto | undefined): AuthState {
  if (!session) return INITIAL;
  return {
    initialized: false,
    status: session.user ? "authenticated" : "unauthenticated",
    session,
    epoch: 0,
    expired: null,
  };
}

/**
 * Current auth state. Before the browser store is initialized (SSR and the
 * hydration render) it is derived from the root loader's session, so server
 * and first client render agree.
 */
export function useAuth(): AuthState {
  const root = useRouteLoaderData<{ session: SessionDto }>("root");
  const snapshot = useSyncExternalStore(authStore.subscribe, authStore.get, () => INITIAL);
  return snapshot.initialized ? snapshot : derive(root?.session);
}

/** The signed-in user's id inside the authenticated shell ("" outside it). */
export function useUserId(): string {
  const auth = useAuth();
  return auth.status === "authenticated" ? (auth.session?.user?.id ?? "") : "";
}

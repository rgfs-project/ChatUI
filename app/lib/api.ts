import type { SessionDto } from "@shared/auth";

import { authStore } from "./auth-store";

/**
 * The shared browser fetch adapter (contracts §5, INV-59). Session state
 * lives in the auth store; this module never holds its own copy.
 */

export class AccountChangedError extends Error {
  override name = "AccountChangedError";
}

/** The session ended mid-use (a 401): the request was not executed. */
export class SessionExpiredError extends Error {
  override name = "SessionExpiredError";
}

export function setSession(session: SessionDto): void {
  authStore.applySession(session);
}

export function currentSession(): SessionDto | null {
  return authStore.get().session;
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

function isMutation(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

/**
 * fetch() for every API call:
 * - mutations carry X-CSRF-Token and X-Expected-User;
 * - any 401 UNAUTHENTICATED moves auth to `unauthenticated` once (the app
 *   opens the re-authentication dialog) and throws SessionExpiredError;
 * - on CSRF_INVALID it refetches the session once and retries once only if the
 *   account and epoch are unchanged and the request is still current;
 *   otherwise the request is discarded (the account boundary purges state).
 * Aborts (`init.signal`) propagate as the platform AbortError.
 */
export async function apiFetch(
  url: string,
  init: RequestInit & { isCurrent?: () => boolean } = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const mutation = isMutation(method);
  const origin = { userId: currentSession()?.user?.id ?? null, epoch: authStore.get().epoch };
  const { isCurrent, ...requestInit } = init;
  const send = () => {
    const headers = new Headers(requestInit.headers);
    const session = currentSession();
    if (mutation && session?.csrfToken && session.user) {
      headers.set("X-CSRF-Token", session.csrfToken);
      headers.set("X-Expected-User", session.user.id);
    }
    return fetch(url, { ...requestInit, headers });
  };
  const response = await send();
  if (response.status === 401 && (await errorCode(response)) === "UNAUTHENTICATED") {
    authStore.expire();
    throw new SessionExpiredError("The session has ended");
  }
  if (!mutation) return response;
  const code = await errorCode(response);
  if (code === "SESSION_CHANGED") {
    await refreshSession();
    throw new AccountChangedError("The signed-in account changed");
  }
  if (code !== "CSRF_INVALID") return response;
  const fresh = await refreshSession(false);
  if (
    fresh?.user?.id === origin.userId &&
    authStore.get().epoch === origin.epoch &&
    (isCurrent?.() ?? true)
  ) {
    authStore.applySession(fresh);
    return send();
  }
  if (fresh && !fresh.user) authStore.expire();
  else if (fresh) authStore.applySession(fresh);
  throw new AccountChangedError("The signed-in account changed");
}

/**
 * Reads the server's view of the session. With `apply`, a signed-out answer
 * while signed in counts as expiry (re-authentication dialog), anything else
 * is applied as the current session.
 */
export async function refreshSession(apply = true): Promise<SessionDto | null> {
  try {
    const response = await fetch("/api/auth/session", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const session = (await response.json()) as SessionDto;
    if (apply) {
      if (!session.user) authStore.expire();
      else authStore.applySession(session);
    }
    return session;
  } catch {
    return null;
  }
}

/** Only same-origin in-app paths are allowed as a post-login destination. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/chat";
  if (!/^\/(chat(\/[A-Za-z0-9%_-]{1,200})?|account|settings)(\?[A-Za-z0-9=&%_.-]*)?$/.test(value))
    return "/chat";
  return value;
}

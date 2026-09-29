import type { SessionDto } from "@shared/auth";

/**
 * Browser session state and the shared fetch wrapper (contracts §5, INV-59).
 * Module state is only touched in the browser (never during SSR).
 */
let current: SessionDto | null = null;
/** Increments on every observed change of signed-in account. */
let epoch = 0;

export const ACCOUNT_CHANGED_EVENT = "chatui:account-changed";

export class AccountChangedError extends Error {
  override name = "AccountChangedError";
}

export function setSession(session: SessionDto): void {
  if (current !== null && current.user?.id !== session.user?.id) {
    epoch++;
    window.dispatchEvent(new CustomEvent(ACCOUNT_CHANGED_EVENT));
  }
  current = session;
}

/** Read through a function: `epoch` can change while a request is awaited. */
function currentEpoch(): number {
  return epoch;
}

export function currentSession(): SessionDto | null {
  return current;
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
 * fetch() that attaches X-CSRF-Token and X-Expected-User to mutations. On
 * CSRF_INVALID it refetches the session once and retries once only if the
 * account and epoch are unchanged and the request is still current;
 * otherwise the request is discarded and user-bound client state is cleared.
 */
export async function apiFetch(
  url: string,
  init: RequestInit & { isCurrent?: () => boolean } = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const mutation = isMutation(method);
  const origin = { userId: current?.user?.id ?? null, epoch };
  const send = () => {
    const headers = new Headers(init.headers);
    if (mutation && current?.csrfToken && current.user) {
      headers.set("X-CSRF-Token", current.csrfToken);
      headers.set("X-Expected-User", current.user.id);
    }
    return fetch(url, { ...init, headers });
  };
  const response = await send();
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
    currentEpoch() === origin.epoch &&
    (init.isCurrent?.() ?? true)
  ) {
    current = fresh;
    return send();
  }
  if (fresh) setSession(fresh);
  window.dispatchEvent(new CustomEvent(ACCOUNT_CHANGED_EVENT));
  throw new AccountChangedError("The signed-in account changed");
}

export async function refreshSession(apply = true): Promise<SessionDto | null> {
  try {
    const response = await fetch("/api/auth/session", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const session = (await response.json()) as SessionDto;
    if (apply) setSession(session);
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

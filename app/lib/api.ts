import type { SessionDto } from "@shared/auth";
import { sessionStore } from "./session";

/** An API error answer (contracts §5) or a transport failure (`code` undefined). */
export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly code: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    status: number,
    code: string | undefined,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

async function refreshSession(): Promise<SessionDto | null> {
  try {
    const response = await fetch("/api/auth/session", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const session = (await response.json()) as SessionDto;
    sessionStore.set(session);
    return session;
  } catch {
    return null;
  }
}

/**
 * fetch() for every API call. Mutations carry the CSRF token and the expected
 * user; a stale token is refreshed once and the request retried only while the
 * same account is signed in. A 401 marks the session as ended.
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const mutation = !SAFE.has(method);
  const userId = sessionStore.get().session?.user?.id ?? null;
  const send = () => {
    const headers = new Headers(init.headers);
    const session = sessionStore.get().session;
    if (mutation && session?.csrfToken && session.user) {
      headers.set("X-CSRF-Token", session.csrfToken);
      headers.set("X-Expected-User", session.user.id);
    }
    return fetch(url, { ...init, method, headers });
  };
  let response = await send();
  if (response.status === 401) {
    sessionStore.expire();
    return response;
  }
  if (mutation && response.status === 403 && (await codeOf(response)) === "CSRF_INVALID") {
    const fresh = await refreshSession();
    if (userId !== null && fresh?.user?.id === userId) response = await send();
  }
  return response;
}

async function codeOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

/** Turns a non-2xx answer into an ApiError. */
export async function ensureOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  let code: string | undefined;
  let message = `Request failed (${String(response.status)})`;
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    code = body.error?.code;
    if (body.error?.message) message = body.error.message;
    details = body.error?.details;
  } catch {
    // Not a contract error body.
  }
  throw new ApiError(response.status, code, message, details);
}

/** JSON request and response; `body` objects are serialized. */
export async function api<T>(
  url: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET", signal: options.signal ?? null };
  if (options.body !== undefined) {
    init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    init.headers = { "Content-Type": "application/json" };
  }
  let response: Response;
  try {
    response = await apiFetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, undefined, "Couldn’t reach ChatUI. Check your connection.");
  }
  await ensureOk(response);
  return (await response.json()) as T;
}

/** A readable message for any error. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** Only same-origin in-app paths are allowed as a post-login destination. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/chat";
  if (!/^\/(chat(\/[A-Za-z0-9%_-]{1,200})?|account|settings)(\?[A-Za-z0-9=&%_.-]*)?$/.test(value))
    return "/chat";
  return value;
}

import type { SessionDto } from "@shared/auth";

/**
 * Browser session state and the shared fetch wrapper (contracts §5, INV-59).
 * Module state is only touched in the browser (never during SSR).
 */
let current: SessionDto | null = null;
/** Increments on every observed change of signed-in account. */
let epoch = 0;

export const ACCOUNT_CHANGED_EVENT = "chatui:account-changed";
/**
 * The signed-in session stopped working mid-use (expired, revoked): the app
 * opens the in-app re-authentication dialog (contracts §12). Fired once per
 * session; `detail.userId` is the account whose draft may be restored.
 */
export const SESSION_EXPIRED_EVENT = "chatui:session-expired";
let expiryReported = false;

export function reportSessionExpired(): void {
  const userId = current?.user?.id;
  if (expiryReported || !userId) return;
  expiryReported = true;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { userId } }));
}

export class AccountChangedError extends Error {
  override name = "AccountChangedError";
}

export function setSession(session: SessionDto): void {
  if (current !== null && current.user?.id !== session.user?.id) {
    epoch++;
    window.dispatchEvent(new CustomEvent(ACCOUNT_CHANGED_EVENT));
  }
  if (session.user) expiryReported = false;
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
  if (response.status === 401) reportSessionExpired();
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

/** A contract error from the API (contracts §5). */
export class ApiError extends Error {
  override name = "ApiError";
  readonly code: string | null;
  readonly status: number;

  constructor(code: string | null, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Reads a contract error body; a body without one is reported as unknown. */
export async function apiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(
      body.error?.code ?? null,
      body.error?.message ?? `Request failed (${String(response.status)})`,
      response.status,
    );
  } catch {
    return new ApiError(null, `Request failed (${String(response.status)})`, response.status);
  }
}

/** JSON request through the shared adapter; non-2xx responses throw ApiError. */
export async function apiJson<T>(
  url: string,
  init: RequestInit & { isCurrent?: () => boolean; json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Accept", "application/json");
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const response = await apiFetch(url, {
    ...rest,
    headers,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (!response.ok) throw await apiError(response);
  return (await response.json()) as T;
}

const SAFE_RETURN_TO =
  /^\/(chat\/new|chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|settings(\/[a-z-]{1,32})?|admin(\/[a-z-]{1,32})?)$/;

/** Only known same-origin in-app paths are allowed as a post-login destination. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !SAFE_RETURN_TO.test(value)) return "/chat/new";
  return value;
}

/**
 * Multipart upload with progress (fetch has no upload progress). Same rules as
 * apiFetch: CSRF and expected-user headers, a 401 opens re-authentication,
 * and a CSRF failure refreshes the session (the caller may try again).
 */
export function apiUpload<T>(
  url: string,
  file: Blob,
  filename: string,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Accept", "application/json");
    if (current?.csrfToken && current.user) {
      xhr.setRequestHeader("X-CSRF-Token", current.csrfToken);
      xhr.setRequestHeader("X-Expected-User", current.user.id);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body !== null) {
        resolve(body as T);
        return;
      }
      if (xhr.status === 401) reportSessionExpired();
      const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
      const code = error?.code ?? null;
      if (code === "CSRF_INVALID" || code === "SESSION_CHANGED") void refreshSession();
      reject(
        new ApiError(code, error?.message ?? `Upload failed (${String(xhr.status)})`, xhr.status),
      );
    };
    xhr.onerror = () => {
      reject(new ApiError(null, "The upload failed. Check your connection.", 0));
    };
    xhr.onabort = () => {
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    options.signal?.addEventListener("abort", () => {
      xhr.abort();
    });
    const form = new FormData();
    form.append("file", file, filename);
    xhr.send(form);
  });
}

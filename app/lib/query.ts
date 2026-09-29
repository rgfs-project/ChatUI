import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { SessionDto } from "@shared/auth";
import type { ConversationDto, ConversationSummary } from "@shared/conversations";
import type { ModelListDto } from "@shared/generations";
import { apiFetch } from "./api";

/**
 * The one canonical query-key factory (contracts §9.1). Every key starts
 * with the signed-in user's id, so a cache can never serve another
 * account's data; `queryClient.clear()` runs on every account change.
 */
export const queryKeys = {
  session: () => ["session"] as const,
  conversations: (userId: string) => ["user", userId, "conversations"] as const,
  conversation: (userId: string, id: string) => ["user", userId, "conversation", id] as const,
  generation: (userId: string, id: string) => ["user", userId, "generation", id] as const,
  models: (userId: string) => ["user", userId, "models"] as const,
  preferences: (userId: string) => ["user", userId, "preferences"] as const,
  /** Mutation key for sends (optimistic messages are read from its state). */
  sends: (userId: string) => ["user", userId, "send"] as const,
};

/** Only these key families may be dehydrated into HTML (browser-safe DTOs). */
export const DEHYDRATE_ALLOWLIST = new Set([
  "conversations",
  "conversation",
  "models",
  "preferences",
]);

export function isDehydratable(key: readonly unknown[]): boolean {
  return key[0] === "user" && typeof key[2] === "string" && DEHYDRATE_ALLOWLIST.has(key[2]);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // SSR-seeded data is fresh on hydration: no immediate duplicate fetch.
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** JSON request through the shared adapter (CSRF, expected user, epoch rules). */
export async function apiJson<T>(
  url: string,
  init: RequestInit & { isCurrent?: () => boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await apiFetch(url, { ...init, headers });
  if (!response.ok) {
    let code: string | null = null;
    let message = `Request failed (${String(response.status)})`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? null;
      message = body.error?.message ?? message;
    } catch {
      // not JSON
    }
    throw new ApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

/**
 * Query functions. Each takes the query's AbortSignal, so a superseded,
 * unmounted or account-cancelled request is aborted rather than resolved late
 * (INV-23; TanStack Query only aborts when the signal is consumed).
 */
export const fetchers = {
  session: (signal?: AbortSignal) =>
    apiJson<SessionDto>("/api/auth/session", signal ? { signal } : {}),
  conversations: async (signal?: AbortSignal) =>
    (
      await apiJson<{ conversations: ConversationSummary[] }>(
        "/api/conversations",
        signal ? { signal } : {},
      )
    ).conversations,
  conversation: (id: string, signal?: AbortSignal) =>
    apiJson<ConversationDto>(
      `/api/conversations/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    ),
  models: (refresh = false, signal?: AbortSignal) =>
    apiJson<ModelListDto>(`/api/models${refresh ? "?refresh=1" : ""}`, signal ? { signal } : {}),
};

/** Not worth retrying: the server answered with a definite client error. */
function retryable(failureCount: number, error: Error): boolean {
  // Definite answers (4xx), expiry and account changes are final; only
  // network failures (TypeError) and 5xx get one more try.
  if (error instanceof ApiError) return error.status >= 500 && failureCount < 1;
  return error.name === "TypeError" && failureCount < 1;
}

/**
 * Query options: the one pairing of key and fetcher per resource, used by
 * every consumer (and any later prefetch), so the cache identity never forks.
 */
export const queries = {
  conversations: (userId: string) =>
    queryOptions({
      queryKey: queryKeys.conversations(userId),
      queryFn: ({ signal }) => fetchers.conversations(signal),
      retry: retryable,
    }),
  conversation: (userId: string, id: string) =>
    queryOptions({
      queryKey: queryKeys.conversation(userId, id),
      queryFn: ({ signal }) => fetchers.conversation(id, signal),
      retry: retryable,
    }),
  models: (userId: string) =>
    queryOptions({
      queryKey: queryKeys.models(userId),
      queryFn: ({ signal }) => fetchers.models(false, signal),
      retry: retryable,
    }),
};

/** Drops every cached query and mutation that does not belong to `userId`. */
export function purgeOtherAccounts(client: QueryClient, userId: string | null): void {
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== "user" || query.queryKey[1] !== userId,
  });
  client.getMutationCache().clear();
}

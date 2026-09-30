import { QueryClient } from "@tanstack/react-query";
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

export const fetchers = {
  session: () => apiJson<SessionDto>("/api/auth/session"),
  conversations: async () =>
    (await apiJson<{ conversations: ConversationSummary[] }>("/api/conversations")).conversations,
  conversation: (id: string) =>
    apiJson<ConversationDto>(`/api/conversations/${encodeURIComponent(id)}`),
  models: (refresh = false) => apiJson<ModelListDto>(`/api/models${refresh ? "?refresh=1" : ""}`),
};

/** Drops every cached query and mutation that does not belong to `userId`. */
export function purgeOtherAccounts(client: QueryClient, userId: string | null): void {
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== "user" || query.queryKey[1] !== userId,
  });
  client.getMutationCache().clear();
}

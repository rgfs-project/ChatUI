import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { SessionDto } from "@shared/auth";
import type {
  ConversationDto,
  ConversationList,
  ConversationResult,
  ConversationSummary,
} from "@shared/conversations";
import type { ModelListDto, ProviderModelsDto } from "@shared/generations";
import type { InstanceDto } from "@shared/instance";
import type { PreferencesDto } from "@shared/preferences";
import { apiError, apiFetch, apiJson } from "../api";
import { qk } from "./keys";

/**
 * Query definitions: key + fetcher, shared by consumers, prefetches and SSR
 * seeding so every path uses the same cache identity (INV-31). Server loaders
 * fill the same keys with identical DTOs from internal services.
 */

export const sessionQuery = () =>
  queryOptions({
    queryKey: qk.session(),
    queryFn: () => apiJson<SessionDto>("/api/auth/session"),
    // Changes only through sign-in/out or an observed account change.
    staleTime: Infinity,
  });

export const conversationsQuery = (userId: string) =>
  queryOptions({
    queryKey: qk.conversations(userId),
    queryFn: async ({ signal }): Promise<ConversationSummary[]> =>
      (await apiJson<ConversationList>("/api/conversations", { signal })).conversations,
  });

export const conversationQuery = (userId: string, id: string) =>
  queryOptions({
    queryKey: qk.conversation(userId, id),
    queryFn: async ({ signal }): Promise<ConversationResult> => {
      const response = await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, {
        signal,
        headers: { Accept: "application/json" },
      });
      if (response.ok)
        return { ok: true, conversation: (await response.json()) as ConversationDto };
      const error = await apiError(response);
      // A malformed id is a 400 before any lookup: to the user it does not exist.
      if (error.code === "NOT_FOUND" || error.code === "VALIDATION")
        return { ok: false, code: "NOT_FOUND" };
      if (error.code === "CONVERSATION_MALFORMED")
        return { ok: false, code: "CONVERSATION_MALFORMED" };
      throw error;
    },
  });

export const modelsQuery = (userId: string) =>
  queryOptions({
    queryKey: qk.models(userId),
    queryFn: async ({ signal }): Promise<ProviderModelsDto[]> =>
      (await apiJson<ModelListDto>("/api/models", { signal })).providers,
  });

export const preferencesQuery = (userId: string) =>
  queryOptions({
    queryKey: qk.preferences(userId),
    queryFn: ({ signal }) => apiJson<PreferencesDto>("/api/preferences", { signal }),
  });

export const instanceQuery = (userId: string) =>
  queryOptions({
    queryKey: qk.instance(userId),
    queryFn: ({ signal }) => apiJson<InstanceDto>("/api/instance", { signal }),
  });

/** Forces a provider refresh and stores the result under the models key. */
export async function refreshModels(client: QueryClient, userId: string): Promise<void> {
  const list = await apiJson<ModelListDto>("/api/models?refresh=1");
  client.setQueryData(qk.models(userId), list.providers);
}

/**
 * A mutation response replaces the cached conversation, unless the cache
 * already holds a newer version: a stale response never wins (INV-23).
 * Storage sets `updatedAt` on every canonical mutation, so it orders versions.
 */
export function storeConversation(
  client: QueryClient,
  userId: string,
  conversation: ConversationDto,
): boolean {
  const key = qk.conversation(userId, conversation.id);
  const cached = client.getQueryData<ConversationResult>(key);
  if (cached?.ok && cached.conversation.updatedAt > conversation.updatedAt) return false;
  // An in-flight (e.g. speculative) fetch started earlier must not land on top of this.
  void client.cancelQueries({ queryKey: key });
  client.setQueryData(key, { ok: true, conversation } satisfies ConversationResult);
  return true;
}

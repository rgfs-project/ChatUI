import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { fetchers, queries } from "./query";

/**
 * Bounded intent prefetch (contracts §9.3, INV-31). Desktop hover (after a
 * short delay) or keyboard focus on a conversation warms the conversation
 * query through the same query options the view and the route's
 * clientLoader consume, so a following click reuses the cached or in-flight
 * request. At most one speculation exists; a new intent or leaving cancels
 * it (aborting the request) unless a navigation has already claimed it.
 * Speculative requests use low fetch priority. Touch input never triggers it
 * (no hover on mobile).
 */
export const HOVER_DELAY_MS = 80;

interface Speculation {
  id: string;
  queryKey: QueryKey;
  client: QueryClient;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

let current: Speculation | null = null;

function cancel(s: Speculation): void {
  if (s.timer) clearTimeout(s.timer);
  if (!s.started) return;
  const query = s.client.getQueryCache().find({ queryKey: s.queryKey, exact: true });
  // Only abort work nobody else is waiting for (a mounted view or a navigation).
  if (query?.state.fetchStatus === "fetching" && query.getObserversCount() === 0)
    void s.client.cancelQueries({ queryKey: s.queryKey, exact: true });
}

/** Intent to open `conversationId` (hover after a delay, or focus at once). */
export function prefetchIntent(
  client: QueryClient,
  userId: string,
  conversationId: string,
  delayMs = HOVER_DELAY_MS,
): void {
  if (!userId) return;
  if (current?.id === conversationId) return;
  endIntent();
  const options = queries.conversation(userId, conversationId);
  const state = client.getQueryState(options.queryKey);
  // Fresh data or a request already in flight: nothing speculative to do.
  if (state?.fetchStatus === "fetching" || (state?.data && !state.isInvalidated)) return;
  const s: Speculation = {
    id: conversationId,
    queryKey: options.queryKey,
    client,
    timer: null,
    started: false,
  };
  s.timer = setTimeout(() => {
    s.timer = null;
    s.started = true;
    void client
      .query({
        ...options,
        queryFn: ({ signal }) => fetchers.conversation(conversationId, signal, "low"),
      })
      .catch(() => undefined);
  }, delayMs);
  current = s;
}

/** The pointer left or focus moved away: drop the speculation. */
export function endIntent(): void {
  if (!current) return;
  cancel(current);
  current = null;
}

/** A navigation now needs this data: the speculation must not be cancelled. */
export function claimIntent(conversationId: string): void {
  if (current?.id === conversationId) {
    if (current.timer) clearTimeout(current.timer);
    current = null;
  }
}

/** Test helper. */
export function resetPrefetchForTests(): void {
  if (current?.timer) clearTimeout(current.timer);
  current = null;
}

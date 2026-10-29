import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { qk } from "./query/keys";
import { conversationQuery } from "./query/queries";

/** Intent must last this long before anything is fetched (a pointer passing over is not intent). */
export const PREFETCH_DELAY_MS = 120;
/** At most this many speculative fetches at once. */
export const PREFETCH_MAX_IN_FLIGHT = 2;

let inFlight = 0;

/**
 * Bounded intent prefetch (Phase 9, INV-31): desktop hover or keyboard focus
 * warms one conversation through the same query definition navigation uses,
 * so the click reuses the cached (or in-flight) request. Touch never
 * prefetches. Leaving before the delay cancels it; leaving during the fetch
 * cancels it when nothing else is using that query. Newer data always wins:
 * a prefetch of fresh data is a no-op (stale time), and query cancellation
 * keeps an older response from landing after a newer one (INV-23).
 */
export function createPrefetcher(client: QueryClient, userId: string) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const start = (id: string) => {
    timers.delete(id);
    const query = client.getQueryState(qk.conversation(userId, id));
    if (query?.status === "success" && !query.isInvalidated) return; // already warm
    if (inFlight >= PREFETCH_MAX_IN_FLIGHT) return;
    inFlight++;
    void client
      .query(conversationQuery(userId, id))
      .catch(() => undefined)
      .finally(() => {
        inFlight--;
      });
  };
  return {
    intent(id: string): void {
      if (timers.has(id)) return;
      timers.set(
        id,
        setTimeout(() => {
          start(id);
        }, PREFETCH_DELAY_MS),
      );
    },
    cancel(id: string): void {
      const timer = timers.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.delete(id);
        return;
      }
      const key = qk.conversation(userId, id);
      const query = client.getQueryCache().find({ queryKey: key });
      if (query?.state.fetchStatus === "fetching" && query.getObserversCount() === 0)
        void client.cancelQueries({ queryKey: key });
    },
  };
}

export function usePrefetcher(userId: string) {
  const client = useQueryClient();
  return useMemo(() => createPrefetcher(client, userId), [client, userId]);
}

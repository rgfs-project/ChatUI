import { dehydrate, QueryClient, type DehydratedState } from "@tanstack/react-query";
import { DEHYDRATE_ALLOWLIST, resourceOf } from "./keys";

/**
 * Hydrated data stays fresh long enough that the browser does not refetch
 * what the document just delivered (INV-56).
 */
export const STALE_TIME_MS = 30_000;

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: STALE_TIME_MS, retry: 1, refetchOnWindowFocus: false },
    },
  });
}

let browserClient: QueryClient | undefined;

/** The browser's single QueryClient. Never used during SSR (INV-55). */
export function getBrowserQueryClient(): QueryClient {
  if (typeof window === "undefined") throw new Error("getBrowserQueryClient is browser-only");
  browserClient ??= makeQueryClient();
  return browserClient;
}

/** Only allowlisted, successful queries leave the server. */
export function dehydrateAllowed(client: QueryClient): DehydratedState {
  return dehydrate(client, {
    shouldDehydrateQuery: (query) => {
      const resource = resourceOf(query.queryKey);
      return (
        query.state.status === "success" &&
        resource !== undefined &&
        DEHYDRATE_ALLOWLIST.has(resource)
      );
    },
    shouldDehydrateMutation: () => false,
  });
}

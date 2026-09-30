import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAuth } from "./auth-store";
import { purgeOtherAccounts } from "./query";

/**
 * Account boundary for the browser cache (INV-55, contracts §12). Whenever
 * the authenticated account changes (sign-in, sign-out, switch, or a session
 * expiring mid-use) the previous account's in-flight queries are aborted and
 * its cached queries and mutations dropped. The first render keeps the
 * SSR-seeded cache so hydrated data is reused without a duplicate fetch.
 */
/**
 * The account the page's cache belongs to. Module state (browser only), so a
 * change is noticed even across the shell unmounting (e.g. sign-in page).
 */
let cacheAccount: string | null | undefined;

export function useAccountBoundary(client: QueryClient): void {
  const auth = useAuth();
  const userId = auth.status === "authenticated" ? (auth.session?.user?.id ?? null) : null;
  useEffect(() => {
    if (cacheAccount === undefined || cacheAccount === userId) {
      cacheAccount = userId;
      return;
    }
    cacheAccount = userId;
    void client.cancelQueries({
      predicate: (query) => query.queryKey[0] !== "user" || query.queryKey[1] !== userId,
    });
    purgeOtherAccounts(client, userId);
  }, [client, userId]);
}

/** Test helper: a new page load. */
export function resetAccountBoundaryForTests(): void {
  cacheAccount = undefined;
}

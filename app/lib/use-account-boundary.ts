import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ACCOUNT_CHANGED_EVENT } from "./api";
import { purgeOtherAccounts } from "./query";

/**
 * Account boundary for the browser cache (INV-55): when the signed-in account
 * changes (sign-in, sign-out, switch, expiry) every query of the previous
 * account is dropped. The first render keeps the SSR-seeded cache so the
 * hydrated data is reused without a duplicate fetch.
 */
export function useAccountBoundary(client: QueryClient, userId: string | null): void {
  const previous = useRef(userId);
  useEffect(() => {
    if (previous.current === userId) return;
    previous.current = userId;
    purgeOtherAccounts(client, userId);
  }, [client, userId]);
  useEffect(() => {
    // The shared adapter saw another account: nothing cached is trustworthy.
    const purge = () => {
      client.clear();
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, purge);
    return () => {
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, purge);
    };
  }, [client]);
}

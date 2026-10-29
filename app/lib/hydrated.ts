import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => undefined;

/** false during SSR and hydration, true once React has hydrated on the client. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

import { useCallback, useSyncExternalStore } from "react";

/** Narrow screens get the sidebar as an overlay drawer. */
export const NARROW_QUERY = "(max-width: 767.98px)";

/** A CSS media query as React state; false on the server and before hydration. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

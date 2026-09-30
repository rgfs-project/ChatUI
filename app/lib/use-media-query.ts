import { useCallback, useSyncExternalStore } from "react";

/** Narrow screens get the sidebar as an overlay drawer. */
export const NARROW_QUERY = "(max-width: 767.98px)";

/** `matchMedia` where the environment has it (not in every test DOM or old browser). */
function mediaList(query: string): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** A CSS media query as React state; false on the server and before hydration. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaList(query);
      list?.addEventListener("change", onChange);
      return () => {
        list?.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => mediaList(query)?.matches ?? false,
    () => false,
  );
}

import { useSyncExternalStore } from "react";

/**
 * The layout breakpoint (Phase 11). Below it the sidebar is a modal drawer.
 * Keep in sync with the `767.98px` media queries in app.css.
 */
export const NARROW_QUERY = "(max-width: 767.98px)";

/**
 * Subscribes to a media query. The server and the hydration render assume
 * "not matching" (the desktop markup); CSS already lays the page out
 * correctly at every width before this hook takes over, so the switch is
 * behavioural only and never a visual jump.
 */
export function useMediaQuery(query: string): boolean {
  // Environments without matchMedia (some embedded browsers, jsdom) get the
  // desktop behaviour; the CSS layout still adapts.
  const supported = () => typeof window.matchMedia === "function";
  return useSyncExternalStore(
    (onChange) => {
      if (!supported()) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => supported() && window.matchMedia(query).matches,
    () => false,
  );
}

export function useNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

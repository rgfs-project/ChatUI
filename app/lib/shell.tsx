import { createContext, useContext, useSyncExternalStore } from "react";

export interface ShellUser {
  id: string;
  username: string;
  role: "user" | "admin";
}

export interface ShellControls {
  user: ShellUser;
  narrow: boolean;
  /** Wide screens: the sidebar column is open (else the icon rail shows). */
  sidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  openSearch: () => void;
}

const ShellContext = createContext<ShellControls | null>(null);
export const ShellProvider = ShellContext.Provider;

export function useShell(): ShellControls {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell outside the app shell");
  return shell;
}

/**
 * Phones (a touch-only screen no wider than a phone in landscape) use the
 * drawer and the top bar. Desktops keep the desktop layout at any window
 * size; app.css uses the same query.
 */
export const NARROW_QUERY = "(hover: none) and (pointer: coarse) and (max-width: 932px)";

/** false on the server and during hydration; then the live answer. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      // Environments without matchMedia (jsdom) answer false.
      if (typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

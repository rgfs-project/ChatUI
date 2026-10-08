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

/** Phone-sized screens use the drawer and the top bar. */
export const NARROW_QUERY = "(max-width: 767px)";

/** false on the server and during hydration; then the live answer. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

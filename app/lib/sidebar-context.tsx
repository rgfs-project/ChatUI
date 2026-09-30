import { createContext, useContext } from "react";

/**
 * The shell's sidebar, for controls outside it (the conversation header
 * shows "Show sidebar"/"Open conversations" and New chat while it is hidden).
 * Wide screens hide and show the column; narrow ones open a modal drawer.
 */
export interface SidebarControls {
  visible: boolean;
  show: () => void;
  /** Below the breakpoint: the sidebar is a drawer (Phase 11). */
  narrow: boolean;
  drawerOpen: boolean;
  /** The control that opens the drawer, for focus return (a callback ref). */
  setDrawerTrigger: (element: HTMLElement | null) => void;
  /** Starts loading the drawer chunk (touch or pointer intent; never required). */
  warmDrawer: () => void;
}

const SidebarContext = createContext<SidebarControls>({
  visible: true,
  show: () => undefined,
  narrow: false,
  drawerOpen: false,
  setDrawerTrigger: () => undefined,
  warmDrawer: () => undefined,
});

export const SidebarProvider = SidebarContext.Provider;

export function useSidebar(): SidebarControls {
  return useContext(SidebarContext);
}

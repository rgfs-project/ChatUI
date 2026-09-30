import { createContext, useContext } from "react";

/**
 * The shell's sidebar visibility, for controls outside the sidebar (the
 * conversation header shows "Show sidebar" and "New chat" while it is hidden).
 */
export interface SidebarControls {
  visible: boolean;
  show: () => void;
}

const SidebarContext = createContext<SidebarControls>({
  visible: true,
  show: () => undefined,
});

export const SidebarProvider = SidebarContext.Provider;

export function useSidebar(): SidebarControls {
  return useContext(SidebarContext);
}

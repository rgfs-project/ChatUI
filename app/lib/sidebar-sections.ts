import { useSyncExternalStore } from "react";
import { useRouteLoaderData } from "react-router";
import {
  ALL_OPEN,
  SECTIONS_COOKIE,
  serializeCollapsed,
  type CollapsedSections,
  type SidebarSection,
} from "@shared/sidebar-sections";
import { THEME_COOKIE_MAX_AGE } from "@shared/theme";

/**
 * Collapsed sidebar sections, shared by the sidebar and the drawer. The first
 * render uses what the server read from the cookie; a change applies at once
 * and is remembered for the next document request.
 */
let current: CollapsedSections | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCollapsedSections(): [
  CollapsedSections,
  (section: SidebarSection, collapsed: boolean) => void,
] {
  const initial =
    useRouteLoaderData<{ sidebarSections?: CollapsedSections }>("root")?.sidebarSections ??
    ALL_OPEN;
  const collapsed = useSyncExternalStore(
    subscribe,
    () => current ?? initial,
    () => initial,
  );
  const set = (section: SidebarSection, value: boolean) => {
    current = { ...collapsed, [section]: value };
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${SECTIONS_COOKIE}=${serializeCollapsed(current)}; Path=/; Max-Age=${String(THEME_COOKIE_MAX_AGE)}; SameSite=Lax${secure}`;
    for (const listener of listeners) listener();
  };
  return [collapsed, set];
}

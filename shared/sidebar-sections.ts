import { readCookie } from "./cookies";

/**
 * Which sidebar sections are collapsed (owner's request, after ChatGPT and
 * Claude): a presentation hint in a cookie, so the server renders the sidebar
 * already in the remembered state (no shift after hydration). Missing or
 * unknown values mean "open".
 */
export const SECTIONS_COOKIE = "chatui_sections";
export const SIDEBAR_SECTIONS = ["pinned", "recents"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
export type CollapsedSections = Readonly<Record<SidebarSection, boolean>>;

export const ALL_OPEN: CollapsedSections = { pinned: false, recents: false };

export function collapsedFromCookieHeader(header: string | null | undefined): CollapsedSections {
  const names = (readCookie(header, SECTIONS_COOKIE) ?? "").split(".");
  return { pinned: names.includes("pinned"), recents: names.includes("recents") };
}

/** "pinned.recents", "pinned", "recents" or "none". */
export function serializeCollapsed(collapsed: CollapsedSections): string {
  const names = SIDEBAR_SECTIONS.filter((s) => collapsed[s]);
  return names.length > 0 ? names.join(".") : "none";
}

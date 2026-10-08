import { readCookie } from "./cookies";

/**
 * Whether the wide-screen sidebar is open or collapsed to the icon rail: a
 * presentation hint in a cookie, so the server renders the remembered state
 * into the first HTML and a reload never flashes the sidebar open.
 */
export const SIDEBAR_COOKIE = "chatui_sidebar";

export function sidebarOpenFromCookieHeader(header: string | null | undefined): boolean {
  return readCookie(header, SIDEBAR_COOKIE) !== "closed";
}

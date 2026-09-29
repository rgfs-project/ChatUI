/**
 * Centralized path builders (INV-53). Conversation ids are opaque and always
 * encoded; the URL is the authoritative active-conversation identity.
 */
export const paths = {
  newChat: () => "/chat/new",
  chat: (conversationId: string) => `/chat/${encodeURIComponent(conversationId)}`,
  settings: () => "/settings",
  admin: () => "/admin",
  account: () => "/account",
  login: (returnTo?: string) =>
    returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login",
} as const;

/**
 * The document path a loader request stands for. Client navigations fetch
 * loader data from `<path>.data` (`/_root.data` for "/") with a `_routes`
 * parameter; a return-to must name the page, never the data endpoint.
 */
export function documentPathOf(requestUrl: string): string {
  const url = new URL(requestUrl);
  let pathname = url.pathname;
  if (pathname === "/_root.data") pathname = "/";
  else if (pathname.endsWith(".data")) pathname = pathname.slice(0, -".data".length);
  url.searchParams.delete("_routes");
  const search = url.searchParams.toString();
  return pathname + (search ? `?${search}` : "");
}

/** Overlay routes keep the previous conversation behind them (history state). */
export interface OverlayState {
  background?: string;
}

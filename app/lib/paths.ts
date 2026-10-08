/** Every in-app URL is built here; conversation ids are always encoded. */
export const paths = {
  newChat: () => "/chat/new",
  chat: (conversationId: string) => `/chat/${encodeURIComponent(conversationId)}`,
  settings: (section?: string) =>
    section ? `/settings?section=${encodeURIComponent(section)}` : "/settings",
  login: (returnTo?: string) =>
    returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login",
} as const;

/**
 * The page a loader request stands for: client navigations fetch
 * `<path>.data?_routes=…`, but a return-to must name the page.
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

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

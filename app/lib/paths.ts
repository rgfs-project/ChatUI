/**
 * Centralized path builders (INV-53). Conversation ids are opaque and always
 * encoded; components never assemble URLs by hand.
 */
export const paths = {
  newChat: () => "/chat/new",
  chat: (id: string) => `/chat/${encodeURIComponent(id)}`,
  settings: (section?: string) =>
    section ? `/settings/${encodeURIComponent(section)}` : "/settings",
  library: () => "/library",
  profile: () => "/profile",
  admin: (section?: string) => (section ? `/admin/${encodeURIComponent(section)}` : "/admin"),
  status: () => "/status",
  login: (returnTo?: string) =>
    returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login",
  register: () => "/register",
};

/** Router state carried by an internally opened overlay: the page behind it. */
export interface OverlayState {
  background: string;
}

const CHAT_PATH = /^\/chat\/([^/?#]+)$/;

/**
 * The conversation a chat path names: an id, `null` for the draft, or
 * `undefined` when the path is not a chat route.
 */
export function conversationIdOfPath(pathname: string): string | null | undefined {
  const match = CHAT_PATH.exec(pathname);
  if (!match?.[1]) return undefined;
  const id = decodeURIComponent(match[1]);
  return id === "new" ? null : id;
}

/** The background chat path of an overlay, if it was opened from inside the app. */
export function overlayBackground(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null || !("background" in state)) return undefined;
  const background = state.background;
  return typeof background === "string" && conversationIdOfPath(background) !== undefined
    ? background
    : undefined;
}

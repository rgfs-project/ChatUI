import { readCookie } from "./cookies";

/**
 * Whether replies show their "Thought process" (owner's request): a
 * presentation hint in a cookie, rendered by the server as
 * `<html data-reasoning="hidden">`, so CSS hides it from the first paint.
 * Stored replies and their reasoning are unchanged either way.
 */
export const REASONING_COOKIE = "chatui_reasoning";

export function reasoningShownFromCookieHeader(header: string | null | undefined): boolean {
  return readCookie(header, REASONING_COOKIE) !== "hidden";
}

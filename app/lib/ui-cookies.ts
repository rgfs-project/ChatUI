/**
 * Presentation hints kept in first-party cookies so the server renders the
 * right layout before paint (no flash). They never carry identity or content
 * and are validated before use (contracts §9.2).
 */
export const UI_COOKIES = {
  sidebar: "chatui_sidebar",
  timeZone: "chatui_tz",
  locale: "chatui_locale",
  /** Hash of the last dismissed instance notice. */
  notice: "chatui_notice",
  /** The sidebar's Recents section is folded. */
  recents: "chatui_recents",
  /** The sidebar's Pinned section is folded. */
  pinned: "chatui_pinned",
} as const;

import { APPEARANCE_COOKIE, parseAppearance, type Appearance } from "./appearance";

export interface UiHints {
  appearance: Appearance;
  /** Phone layout: decided by device on the server, before paint (Phase 11). */
  phone: boolean;
  sidebarCollapsed: boolean;
  /** The Recents list is folded away (its heading is a toggle). */
  recentsCollapsed: boolean;
  pinnedCollapsed: boolean;
  /** Hash of the notice this browser dismissed (so the server hides it too). */
  noticeDismissed: string | null;
  timeZone: string;
  locale: string;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // ignore an undecodable value
    }
  }
  return out;
}

export function validTimeZone(value: string | undefined): string | null {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function validLocale(value: string | undefined): string | null {
  if (!value || value.length > 35) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

/** First supported language of an Accept-Language header. */
function acceptLanguage(header: string | null): string | null {
  for (const part of (header ?? "").split(",")) {
    const locale = validLocale(part.split(";")[0]?.trim());
    if (locale) return locale;
  }
  return null;
}

/**
 * A phone, not a tablet or a narrow desktop window: the Client Hint
 * `Sec-CH-UA-Mobile: ?1` (Chromium) or a phone user agent. Width alone never
 * decides it, so a sideways phone keeps the phone layout and a narrow desktop
 * window keeps the desktop one.
 */
export function isPhone(headers: Headers): boolean {
  if (headers.get("sec-ch-ua-mobile") === "?1") return true;
  const ua = headers.get("user-agent") ?? "";
  if (/iPad|Tablet/i.test(ua)) return false;
  return /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone/i.test(ua);
}

export function readUiHints(request: Request): UiHints {
  const cookies = parseCookies(request.headers.get("cookie"));
  return {
    appearance: parseAppearance(cookies[APPEARANCE_COOKIE]),
    phone: isPhone(request.headers),
    sidebarCollapsed: cookies[UI_COOKIES.sidebar] === "collapsed",
    recentsCollapsed: cookies[UI_COOKIES.recents] === "collapsed",
    pinnedCollapsed: cookies[UI_COOKIES.pinned] === "collapsed",
    noticeDismissed: /^[0-9a-z]{1,16}$/.test(cookies[UI_COOKIES.notice] ?? "")
      ? (cookies[UI_COOKIES.notice] ?? null)
      : null,
    timeZone: validTimeZone(cookies[UI_COOKIES.timeZone]) ?? "UTC",
    locale:
      validLocale(cookies[UI_COOKIES.locale]) ??
      acceptLanguage(request.headers.get("accept-language")) ??
      "en-US",
  };
}

/** Browser only. */
export function writeUiCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/**
 * Presentation hints kept in first-party cookies so the server renders the
 * right layout before paint (no flash). They never carry identity or content
 * and are validated before use (contracts §9.2).
 */
export const UI_COOKIES = {
  sidebar: "chatui_sidebar",
  timeZone: "chatui_tz",
  locale: "chatui_locale",
} as const;

import { APPEARANCE_COOKIE, parseAppearance, type Appearance } from "./appearance";

export interface UiHints {
  appearance: Appearance;
  sidebarCollapsed: boolean;
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

export function readUiHints(request: Request): UiHints {
  const cookies = parseCookies(request.headers.get("cookie"));
  return {
    appearance: parseAppearance(cookies[APPEARANCE_COOKIE]),
    sidebarCollapsed: cookies[UI_COOKIES.sidebar] === "collapsed",
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

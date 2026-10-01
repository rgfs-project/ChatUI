/**
 * Theme preference (Phase 18). A presentation hint only (contracts §9): it
 * lives in a non-HttpOnly cookie so the server renders the right theme into
 * the first HTML (no bootstrap script, no flash) and never carries identity.
 * "system" follows `prefers-color-scheme` in CSS; it is the default and what
 * any missing or unknown value means.
 */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = "chatui_theme";

/** One year: a remembered display choice, like the browser's own. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Reads the theme from a Cookie header; anything unexpected is "system". */
export function themeFromCookieHeader(header: string | null | undefined): Theme {
  if (!header) return "system";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === THEME_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return isTheme(value) ? value : "system";
    }
  }
  return "system";
}

import { REASONING_COOKIE } from "@shared/reasoning-display";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, type Theme } from "@shared/theme";

/**
 * Applies a theme at once and remembers it for the next document request,
 * whose HTML the server then renders in that theme (no flash on reload).
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  // Explicit "system" too: the server needs no special case for "unset".
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${String(THEME_COOKIE_MAX_AGE)}; SameSite=Lax${secure}`;
}

/** The theme in effect on this document (as the server rendered it, or as changed since). */
export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

/** Shows or hides replies' thought process at once, and remembers it. */
export function applyReasoningShown(shown: boolean) {
  const root = document.documentElement;
  if (shown) delete root.dataset.reasoning;
  else root.dataset.reasoning = "hidden";
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${REASONING_COOKIE}=${shown ? "shown" : "hidden"}; Path=/; Max-Age=${String(THEME_COOKIE_MAX_AGE)}; SameSite=Lax${secure}`;
}

export function reasoningShown(): boolean {
  return document.documentElement.dataset.reasoning !== "hidden";
}

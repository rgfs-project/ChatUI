import { REASONING_COOKIE } from "@shared/reasoning-display";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, type Theme } from "@shared/theme";

function remember(name: string, value: string) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${value}; Path=/; Max-Age=${String(THEME_COOKIE_MAX_AGE)}; SameSite=Lax${secure}`;
}

/** Applies a theme now and remembers it, so the server renders it next time. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  remember(THEME_COOKIE, theme);
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

export function applyReasoningShown(shown: boolean) {
  const root = document.documentElement;
  if (shown) delete root.dataset.reasoning;
  else root.dataset.reasoning = "hidden";
  remember(REASONING_COOKIE, shown ? "shown" : "hidden");
}

export function reasoningShown(): boolean {
  return document.documentElement.dataset.reasoning !== "hidden";
}

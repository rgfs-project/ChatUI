/**
 * Appearance preferences (Settings → Appearance): presentation hints kept in
 * one cookie and rendered by the server as <html> attributes, so the first
 * paint already has the right theme and sizes, with no bootstrap script.
 */
export const THEMES = ["light", "dark", "system"] as const;
export const ACCENTS = ["blue", "green", "yellow", "pink", "orange", "purple"] as const;
export const MOTIONS = ["system", "reduce"] as const;
export const UI_SIZES = [12, 13, 14, 15, 16, 17, 18] as const;
export const CODE_SIZES = [11, 12, 13, 14, 15, 16] as const;

export type Theme = (typeof THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type Motion = (typeof MOTIONS)[number];

export interface Appearance {
  theme: Theme;
  accent: Accent;
  uiSize: number;
  codeSize: number;
  motion: Motion;
}

export const APPEARANCE_COOKIE = "chatui_appearance";

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "light",
  accent: "orange",
  uiSize: 14,
  codeSize: 12,
  motion: "system",
};

function oneOf<T extends string | number>(list: readonly T[], value: unknown, fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback;
}

/** Cookie format: `theme.accent.uiSize.codeSize.motion`; anything invalid falls back per field. */
export function parseAppearance(value: string | undefined): Appearance {
  const [theme, accent, ui, code, motion] = (value ?? "").split(".");
  const d = DEFAULT_APPEARANCE;
  return {
    theme: oneOf(THEMES, theme, d.theme),
    accent: oneOf(ACCENTS, accent, d.accent),
    uiSize: oneOf<number>(UI_SIZES, Number(ui), d.uiSize),
    codeSize: oneOf<number>(CODE_SIZES, Number(code), d.codeSize),
    motion: oneOf(MOTIONS, motion, d.motion),
  };
}

export function serializeAppearance(a: Appearance): string {
  return [a.theme, a.accent, String(a.uiSize), String(a.codeSize), a.motion].join(".");
}

export function htmlAttributes(a: Appearance): Record<string, string> {
  return {
    "data-theme": a.theme,
    "data-accent": a.accent,
    "data-ui-size": String(a.uiSize),
    "data-code-size": String(a.codeSize),
    "data-motion": a.motion,
  };
}

/** Browser only: applies at once and remembers it for the next document. */
export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(htmlAttributes(a))) root.setAttribute(name, value);
  document.cookie = `${APPEARANCE_COOKIE}=${serializeAppearance(a)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

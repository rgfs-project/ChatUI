import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTheme, themeFromCookieHeader } from "@shared/theme";

/**
 * Phase 18: the visual language as checkable rules. Colour pairs meet WCAG 2.2
 * AA in both themes (text 4.5:1, UI boundaries and states 3:1), sizes come
 * from the scales, and nothing bypasses the theme tokens.
 */

const APP = join(import.meta.dirname, "../../app");

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

// temml.css is the vendored math stylesheet (em-relative, theme-neutral).
const STYLESHEETS = files(APP, ".css").filter((f) => !f.endsWith("temml.css"));
const appCss = readFileSync(join(APP, "app.css"), "utf8");

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
  throw new Error(`unparsed colour: ${v}`);
}

/** The colour tokens of :root for one scheme (light-dark(light, dark) resolved). */
function tokens(scheme: "light" | "dark"): Map<string, string> {
  const root = /:root \{([\s\S]*?)\n\}/.exec(appCss)?.[1] ?? "";
  const out = new Map<string, string>();
  for (const m of root.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    const [, name, raw] = m;
    if (!name || !raw) continue;
    const pair =
      /^light-dark\(\s*(#[0-9a-f]{6}|rgb\([^)]*\)),\s*(#[0-9a-f]{6}|rgb\([^)]*\))\s*\)$/i.exec(
        raw.trim(),
      );
    if (pair?.[1] && pair[2]) out.set(name, scheme === "light" ? pair[1] : pair[2]);
    else if (/^(#|rgb\()/.test(raw.trim())) out.set(name, raw.trim());
  }
  return out;
}

/** Flattens a translucent colour over an opaque one. */
function over(top: Rgba, base: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (base[i] ?? 0) * (1 - a)) as unknown as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` over `bg`, where `bg` may itself be a translucent token over `base`. */
function ratio(t: Map<string, string>, fg: string, bg: string, base = "canvas"): number {
  const color = (name: string) => {
    const value = t.get(name);
    if (!value) throw new Error(`missing token --${name}`);
    return parseColor(value);
  };
  const baseColor = color(base);
  const background = over(color(bg), baseColor);
  return contrast(over(color(fg), background), background);
}

const SURFACES = ["canvas", "sidebar", "surface", "raised", "field", "code"];

describe.each(["light", "dark"] as const)("colour contrast (%s)", (scheme) => {
  const t = tokens(scheme);

  it.each(["fg", "fg-2", "muted", "danger", "link"])("--%s text is at least 4.5:1", (fg) => {
    for (const bg of SURFACES)
      expect(ratio(t, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    // Hover and selected rows put text on a translucent fill.
    for (const fill of ["hover", "active"])
      for (const base of ["canvas", "sidebar", "raised"])
        expect(ratio(t, fg, fill, base), `${fg} on ${fill}/${base}`).toBeGreaterThanOrEqual(4.5);
  });

  it("paired foregrounds are at least 4.5:1", () => {
    expect(ratio(t, "on-bubble", "bubble")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t, "muted", "bubble")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t, "on-send", "send")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t, "on-avatar", "avatar")).toBeGreaterThanOrEqual(4.5);
  });

  it("field boundaries, focus indicators and switch states are at least 3:1", () => {
    for (const bg of ["canvas", "sidebar", "raised", "field"]) {
      expect(ratio(t, "field-line", bg), `field-line on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "focus", bg), `focus on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "field-focus", bg), `field-focus on ${bg}`).toBeGreaterThanOrEqual(3);
      // Primary buttons and the checked switch track.
      expect(ratio(t, "send", bg), `send on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    // The switch thumb (--canvas) against both tracks.
    expect(ratio(t, "canvas", "field-line")).toBeGreaterThanOrEqual(3);
    expect(ratio(t, "canvas", "send")).toBeGreaterThanOrEqual(3);
  });
});

describe("tokens and scales", () => {
  it("defines every colour token in both themes with light-dark()", () => {
    const light = tokens("light");
    const dark = tokens("dark");
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    expect(light.size).toBeGreaterThan(20);
  });

  it("switches themes only through color-scheme, never per-component media queries", () => {
    for (const file of STYLESHEETS)
      expect(readFileSync(file, "utf8"), file).not.toMatch(/prefers-color-scheme/);
    expect(appCss).toMatch(/:root\[data-theme="light"\] \{\s*color-scheme: light;/);
    expect(appCss).toMatch(/:root\[data-theme="dark"\] \{\s*color-scheme: dark;/);
  });

  it("takes font sizes, radii and weights from the scales", () => {
    for (const file of STYLESHEETS) {
      const css = readFileSync(file, "utf8").replace(/:root \{[\s\S]*?\n\}/, "");
      for (const [, value] of css.matchAll(/font-size: ([^;]+);/g))
        expect(value, `${file}: font-size ${String(value)}`).toMatch(
          /^(var\(--text-[a-z0-9]+\)|[\d.]+em|max\(1rem, 16px\))$/,
        );
      for (const [, value] of css.matchAll(/border-radius: ([^;]+);/g))
        expect(value, `${file}: border-radius ${String(value)}`).toMatch(
          /^((var\(--radius-[a-z0-9]+\)|0|\d+%)\s*)+$/,
        );
      for (const [, value] of css.matchAll(/font-weight: ([^;]+);/g))
        expect(value, `${file}: font-weight ${String(value)}`).toMatch(
          /^(var\(--weight-[a-z]+\)|400|inherit|normal|bold)$/,
        );
    }
  });

  it("honours prefers-reduced-motion for every animation and transition", () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{[^}]*animation-duration: 0\.01ms !important;[^}]*transition-duration: 0\.01ms !important;/,
    );
  });
});

describe("icons", () => {
  const sources = files(APP, ".tsx");
  it("use one Lucide size scale and the default stroke", () => {
    for (const file of sources) {
      const tsx = readFileSync(file, "utf8");
      for (const [, size] of tsx.matchAll(/size=\{(\d+)\}/g))
        expect([14, 16, 18, 20], `${file}: size ${String(size)}`).toContain(Number(size));
      expect(tsx, file).not.toMatch(/strokeWidth=/);
    }
  });
});

describe("theme cookie", () => {
  it("reads a saved theme and treats anything else as system", () => {
    expect(themeFromCookieHeader("a=1; chatui_theme=dark; b=2")).toBe("dark");
    expect(themeFromCookieHeader("chatui_theme=light")).toBe("light");
    expect(themeFromCookieHeader("chatui_theme=system")).toBe("system");
    expect(themeFromCookieHeader("chatui_theme=%3Cscript%3E")).toBe("system");
    expect(themeFromCookieHeader("chatui_theme=")).toBe("system");
    expect(themeFromCookieHeader("xchatui_theme=dark")).toBe("system");
    expect(themeFromCookieHeader(undefined)).toBe("system");
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("custom")).toBe(false);
  });
});

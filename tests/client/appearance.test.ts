import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  htmlAttributes,
  parseAppearance,
  serializeAppearance,
} from "../../app/lib/appearance";
import { readUiHints } from "../../app/lib/ui-cookies";

describe("appearance cookie", () => {
  it("round-trips every field", () => {
    const a = {
      theme: "dark",
      accent: "green",
      uiSize: 16,
      codeSize: 13,
      motion: "reduce",
    } as const;
    expect(parseAppearance(serializeAppearance(a))).toEqual(a);
  });

  it("defaults to light, orange, 14/12 and system motion", () => {
    expect(parseAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE).toMatchObject({
      theme: "light",
      accent: "orange",
      uiSize: 14,
      codeSize: 12,
    });
  });

  it("invalid fields fall back one by one (never trusted as markup)", () => {
    expect(parseAppearance('dark.<script>.99.13."x"')).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: "dark",
      codeSize: 13,
    });
  });

  it("the server reads it from the request cookie into <html> attributes", () => {
    const request = new Request("http://x/", {
      headers: { cookie: "chatui_appearance=system.purple.15.14.reduce" },
    });
    expect(htmlAttributes(readUiHints(request).appearance)).toEqual({
      "data-theme": "system",
      "data-accent": "purple",
      "data-ui-size": "15",
      "data-code-size": "14",
      "data-motion": "reduce",
    });
  });
});

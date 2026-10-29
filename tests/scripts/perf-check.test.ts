import { describe, expect, it } from "vitest";
import { compare, firstLoadFiles, measure, type Manifest } from "../../scripts/perf-check.ts";

const manifest: Manifest = {
  "entry.tsx": { file: "assets/entry.js", imports: ["_shared.js"] },
  "route.tsx": {
    file: "assets/route.js",
    imports: ["_shared.js"],
    dynamicImports: ["katex.js"],
    assets: ["assets/app.css"],
  },
  "_shared.js": { file: "assets/shared.js" },
  "katex.js": { file: "assets/katex.js" },
};
const files: Record<string, string> = {
  "assets/entry.js": "e".repeat(1000),
  "assets/route.js": "console.log('route')".repeat(50),
  "assets/shared.js": "shared code ".repeat(100),
  "assets/katex.js": "katex ".repeat(10_000),
  "assets/app.css": "body{margin:0}",
};
const read = (file: string) => Buffer.from(files[file] ?? "");

describe("perf:check", () => {
  it("counts static imports and linked CSS, never dynamic imports", () => {
    const set = firstLoadFiles(manifest, ["entry.tsx", "route.tsx"]);
    expect(set.js.sort()).toEqual(["assets/entry.js", "assets/route.js", "assets/shared.js"]);
    expect(set.css).toEqual(["assets/app.css"]);
  });

  it("passes against the recorded budget and fails against a lowered one", () => {
    const sizes = { chat: measure(manifest, ["entry.tsx", "route.tsx"], read) };
    const budget = {
      compression: "gzip" as const,
      tolerance: 0.1,
      routes: { chat: { js: sizes.chat.js, css: sizes.chat.css } },
    };
    expect(compare(sizes, budget).ok).toBe(true);
    const lowered = {
      ...budget,
      routes: { chat: { js: Math.floor(sizes.chat.js / 2), css: sizes.chat.css } },
    };
    const result = compare(sizes, lowered);
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.startsWith("FAIL  chat js"))).toBe(true);
  });

  it("an untracked route fails", () => {
    const sizes = { other: measure(manifest, ["entry.tsx"], read) };
    expect(compare(sizes, { compression: "gzip", tolerance: 0.1, routes: {} }).ok).toBe(false);
  });
});

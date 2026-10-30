import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

/** Relative modules `file` loads at runtime (type-only imports are erased by Node). */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specs = [
    ...source.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gms),
    ...source.matchAll(/^\s*export\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gms),
    ...source.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g),
  ].map((m) => m[1] ?? "");
  return specs
    .filter((spec) => spec.endsWith(".ts"))
    .map((spec) => path.resolve(path.dirname(file), spec));
}

function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() ?? "";
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...runtimeImports(file));
  }
  return seen;
}

/** Repository paths the runtime stage copies from the build context. */
function copiedSources(): string[] {
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  return [...runtime.matchAll(/^COPY (?!--from)(.+)$/gm)].flatMap((m) =>
    (m[1] ?? "")
      .trim()
      .split(/\s+/)
      .slice(0, -1)
      .map((src) => path.resolve(root, src)),
  );
}

describe("container image", () => {
  it("copies every server module the CLI and server entry load natively", () => {
    const sources = copiedSources();
    const covered = (file: string) =>
      sources.some((src) => file === src || file.startsWith(src + path.sep));
    const needed = closure([path.join(root, "server/cli.ts"), path.join(root, "server/main.ts")]);
    const missing = [...needed].filter((file) => !covered(file)).map((f) => path.relative(root, f));
    expect(missing).toEqual([]);
  });
});

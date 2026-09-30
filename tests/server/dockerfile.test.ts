import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The runtime image copies an explicit list of server sources (the CLI and
 * the process entry run natively via type stripping; the application itself
 * comes from the server bundle). Every module reachable from `server/cli.ts`
 * through runtime imports must be copied, or the container cannot start.
 * (Phase 16 shipped `backup.ts`/`http-limits.ts` without copying them.)
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Sources the runtime stage copies from the build context: files and directories. */
function copiedSources(): string[] {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8").replace(/\\\n\s*/g, " ");
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  const sources: string[] = [];
  for (const line of runtime.split("\n")) {
    const match = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
    if (!match?.[1]) continue;
    const parts = match[1].trim().split(/\s+/);
    sources.push(...parts.slice(0, -1));
  }
  return sources;
}

/** Relative runtime imports of a module (type-only imports are erased by Node). */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  // One statement at a time (no `;` inside), so a type-only import is never
  // attributed to the statement before it.
  const statement = /^\s*(import|export)\s+(?!type\b)[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm;
  for (const m of source.matchAll(statement)) if (m[2]) found.push(m[2]);
  for (const m of source.matchAll(/^\s*import\s+"(\.{1,2}\/[^"]+)"/gm)) if (m[1]) found.push(m[1]);
  for (const m of source.matchAll(/import\(\s*"(\.{1,2}\/[^"]+)"\s*\)/g))
    if (m[1]) found.push(m[1]);
  return found.map((spec) => path.resolve(path.dirname(file), spec));
}

describe("runtime image contents", () => {
  it("copies every module the CLI and server entry import at runtime", () => {
    const copied = copiedSources().map((s) => path.join(ROOT, s.replace(/\/$/, "")));
    const covered = (file: string) =>
      copied.some((c) => file === c || file.startsWith(`${c}${path.sep}`));
    const seen = new Set<string>();
    const queue = [path.join(ROOT, "server/cli.ts")];
    const missing: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop() ?? "";
      if (seen.has(file)) continue;
      seen.add(file);
      if (!covered(file)) missing.push(path.relative(ROOT, file));
      if (existsSync(file)) queue.push(...runtimeImports(file));
    }
    expect(seen.has(path.join(ROOT, "server/main.ts"))).toBe(true);
    expect(seen.has(path.join(ROOT, "server/backup.ts"))).toBe(true);
    expect(missing).toEqual([]);
  });
});

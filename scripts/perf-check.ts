/**
 * Bundle budget check (contracts §9.5). Reads the production React Router
 * manifest, resolves the files each tracked route group loads on a cold
 * visit (entry + route modules + their static imports, deduplicated), and
 * compares their gzip level-9 size with `performance-budget.json`.
 *
 *   node scripts/perf-check.ts                 check against the budget
 *   node scripts/perf-check.ts --budget <file> check against another budget
 *   node scripts/perf-check.ts --write         (re)write the budget from this build
 *
 * Deterministic and offline: it only reads build output.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLIENT = path.join(ROOT, "build", "client");
const ASSETS = path.join(CLIENT, "assets");
const BUDGET_FILE = path.join(ROOT, "performance-budget.json");

interface ManifestRoute {
  module: string;
  imports?: string[];
  css?: string[];
  clientLoaderModule?: string;
}
interface Manifest {
  entry: { module: string; imports: string[] };
  routes: Record<string, ManifestRoute>;
}

export interface Budget {
  compression: "gzip-9";
  /** Allowed growth over each budget before the check fails (0.1 = 10%). */
  tolerance: number;
  budgets: Record<string, number>;
}

/** Route groups: what a cold visit to each surface downloads before hydration. */
export const GROUPS: Record<string, string[]> = {
  "critical-chat-js": ["root", "routes/app-layout", "routes/chat-conversation"],
  "new-chat-js": ["root", "routes/app-layout", "routes/chat-new"],
  "login-js": ["root", "routes/login"],
  /** The lazy admin route (Phase 10): never part of the chat groups above. */
  "admin-route-js": ["root", "routes/app-layout", "routes/admin"],
};

export function readManifest(): Manifest {
  const file = readdirSync(ASSETS).find((f) => /^manifest-[\w-]+\.js$/.test(f));
  if (!file) throw new Error("no React Router manifest in build/client/assets (run npm run build)");
  const source = readFileSync(path.join(ASSETS, file), "utf8");
  const json = source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1);
  return JSON.parse(json) as Manifest;
}

function gzipBytes(publicPath: string): number {
  return gzipSync(readFileSync(path.join(CLIENT, publicPath)), { level: 9 }).length;
}

export function filesFor(manifest: Manifest, routeIds: string[]): string[] {
  const files = new Set<string>([manifest.entry.module, ...manifest.entry.imports]);
  for (const id of routeIds) {
    const route = manifest.routes[id];
    if (!route) throw new Error(`route ${id} is not in the manifest`);
    files.add(route.module);
    for (const f of route.imports ?? []) files.add(f);
    // A split clientLoader is fetched with the route module on navigation.
    if (route.clientLoaderModule) files.add(route.clientLoaderModule);
  }
  return [...files];
}

export function measure(): Record<string, number> {
  const manifest = readManifest();
  const sizes: Record<string, number> = {};
  for (const [name, routes] of Object.entries(GROUPS))
    sizes[name] = filesFor(manifest, routes).reduce((n, f) => n + gzipBytes(f), 0);
  // Critical CSS: the stylesheets a cold chat visit links before hydration:
  // those the critical route modules reference as a `/assets/…css` URL (the
  // root's `links()`), plus the critical routes' own CSS. Stylesheets that
  // only appear in a lazy chunk's preload list (`assets/…css`, no leading
  // slash) load on demand and are excluded.
  const criticalRoutes = GROUPS["critical-chat-js"] ?? [];
  const linked = new Set<string>();
  for (const file of filesFor(manifest, criticalRoutes)) {
    const source = readFileSync(path.join(CLIENT, file), "utf8");
    for (const match of source.matchAll(/["'`](\/assets\/[\w.-]+\.css)["'`]/g))
      if (match[1]) linked.add(match[1]);
  }
  for (const id of criticalRoutes)
    for (const css of manifest.routes[id]?.css ?? []) linked.add(css);
  sizes["critical-css"] = [...linked].reduce((n, f) => n + gzipBytes(f), 0);
  // On-demand cost of the source panel (Phase 13c): its own chunk and
  // stylesheet, downloaded only when a file is first opened.
  const assets = readdirSync(ASSETS);
  sizes["artifact-panel-on-demand"] = assets
    .filter((f) => /^ArtifactPanel-[\w-]+\.js$/.test(f) || /^artifacts-[\w-]+\.css$/.test(f))
    .reduce((n, f) => n + gzipBytes(`/assets/${f}`), 0);
  // On-demand cost of Settings → Data (Phase 13d): export and import preview UI.
  sizes["data-settings-on-demand"] = assets
    .filter((f) => /^DataSettings-[\w-]+\.(?:js|css)$/.test(f))
    .reduce((n, f) => n + gzipBytes(`/assets/${f}`), 0);
  sizes["all-client-js"] = readdirSync(ASSETS)
    .filter((f) => f.endsWith(".js"))
    .reduce((n, f) => n + gzipBytes(`/assets/${f}`), 0);
  return sizes;
}

/**
 * Chunks that must stay out of every cold-visit group: attachment UI that a
 * chat without attachments never needs (Phase 12), loaded on first use.
 */
export const LAZY_ONLY = [
  "AttachmentTray",
  "ImageViewer",
  "MemorySuggestions",
  "MemorySettings",
  "ArtifactPanel",
  "ArtifactSettings",
  "DataSettings",
] as const;

/** Lazy-only chunks a route group would download on a cold visit (must be none). */
export function lazyLeaks(manifest: Manifest = readManifest()): string[] {
  const leaks: string[] = [];
  for (const [name, routes] of Object.entries(GROUPS))
    for (const file of filesFor(manifest, routes))
      for (const lazy of LAZY_ONLY)
        if (path.basename(file).startsWith(`${lazy}-`)) leaks.push(`${name}: ${file}`);
  const assets = readdirSync(ASSETS);
  for (const lazy of LAZY_ONLY)
    if (!assets.some((f) => f.startsWith(`${lazy}-`) && f.endsWith(".js")))
      leaks.push(`${lazy}: no separate chunk was built`);
  return leaks;
}

export function check(
  sizes: Record<string, number>,
  budget: Budget,
  leaks: string[] = [],
): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = leaks.length === 0;
  lines.push(
    leaks.length === 0
      ? `PASS  lazy chunks (${LAZY_ONLY.join(", ")}) are outside every cold-visit group`
      : `FAIL  lazy chunks leaked: ${leaks.join("; ")}`,
  );
  for (const [name, limit] of Object.entries(budget.budgets)) {
    const actual = sizes[name];
    if (actual === undefined) {
      lines.push(`FAIL  ${name}: not measured`);
      ok = false;
      continue;
    }
    const max = Math.floor(limit * (1 + budget.tolerance));
    const pass = actual <= max;
    ok &&= pass;
    lines.push(
      `${pass ? "PASS" : "FAIL"}  ${name}: ${String(actual)} B gzip (budget ${String(limit)} B, max ${String(max)} B with ${String(Math.round(budget.tolerance * 100))}%)`,
    );
  }
  return { ok, lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sizes = measure();
  if (args.includes("--write")) {
    const budget: Budget = { compression: "gzip-9", tolerance: 0.1, budgets: sizes };
    writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
    process.stdout.write(`perf-check: wrote ${path.relative(ROOT, BUDGET_FILE)}\n`);
    process.exit(0);
  }
  const at = args.indexOf("--budget");
  const file = at >= 0 && args[at + 1] ? path.resolve(args[at + 1] ?? "") : BUDGET_FILE;
  const budget = JSON.parse(readFileSync(file, "utf8")) as Budget;
  const result = check(sizes, budget, lazyLeaks());
  process.stdout.write(`${result.lines.join("\n")}\n`);
  process.stdout.write(`perf-check: ${result.ok ? "within budget" : "BUDGET EXCEEDED"}\n`);
  process.exit(result.ok ? 0 : 1);
}

/**
 * `npm run perf:check` (Phase 9): measures the compressed JS and CSS that a
 * route needs on first load, from the production build manifest, and fails
 * when a tracked size exceeds performance-budget.json × (1 + tolerance).
 * Deterministic and offline: it reads build/client only.
 *
 *   node scripts/perf-check.ts            check against the budget
 *   node scripts/perf-check.ts --write    record the current sizes as the budget
 *
 * Compression: gzip level 9 (what a typical reverse proxy serves).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLIENT = path.join(ROOT, "build/client");
const BUDGET_FILE = path.join(ROOT, "performance-budget.json");

export interface ManifestEntry {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  /** Files referenced by URL (the root links its stylesheet with `?url`). */
  assets?: string[];
}
export type Manifest = Record<string, ManifestEntry>;

export interface RouteSize {
  js: number;
  css: number;
  files: string[];
}

export interface Budget {
  compression: "gzip";
  /** Allowed regression per tracked category, e.g. 0.1 = 10 %. */
  tolerance: number;
  routes: Record<string, { js: number; css: number }>;
}

const CLIENT_ROUTE = "?__react-router-build-client-route";

/** First-load module sets: the document entry, root and the route's modules. */
export const CRITICAL_ROUTES: Record<string, string[]> = {
  chat: [
    "app/entry.client.tsx",
    `app/root.tsx${CLIENT_ROUTE}`,
    `app/routes/app-layout.tsx${CLIENT_ROUTE}`,
    `app/routes/chat-conversation.tsx${CLIENT_ROUTE}`,
  ],
  login: [
    "app/entry.client.tsx",
    `app/root.tsx${CLIENT_ROUTE}`,
    `app/routes/login.tsx${CLIENT_ROUTE}`,
  ],
};

/** Static imports only: dynamic imports (optional renderers) are not first-load. */
export function firstLoadFiles(
  manifest: Manifest,
  keys: string[],
): { js: string[]; css: string[] } {
  const js = new Set<string>();
  const css = new Set<string>();
  const visit = (key: string) => {
    const entry = manifest[key];
    if (!entry || js.has(entry.file)) return;
    js.add(entry.file);
    for (const sheet of entry.css ?? []) css.add(sheet);
    for (const asset of entry.assets ?? []) if (asset.endsWith(".css")) css.add(asset);
    for (const dep of entry.imports ?? []) visit(dep);
  };
  for (const key of keys) {
    if (!manifest[key]) throw new Error(`manifest has no ${key}`);
    visit(key);
  }
  return { js: [...js], css: [...css] };
}

export function measure(
  manifest: Manifest,
  keys: string[],
  read: (file: string) => Buffer,
): RouteSize {
  const { js, css } = firstLoadFiles(manifest, keys);
  const size = (files: string[]) =>
    files.reduce((sum, file) => sum + gzipSync(read(file), { level: 9 }).length, 0);
  return { js: size(js), css: size(css), files: [...js, ...css] };
}

export function compare(
  sizes: Record<string, RouteSize>,
  budget: Budget,
): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const [route, size] of Object.entries(sizes)) {
    const limit = budget.routes[route];
    if (!limit) {
      ok = false;
      lines.push(`${route}: no budget recorded`);
      continue;
    }
    for (const kind of ["js", "css"] as const) {
      const allowed = Math.round(limit[kind] * (1 + budget.tolerance));
      const pass = size[kind] <= allowed;
      if (!pass) ok = false;
      lines.push(
        `${pass ? "PASS" : "FAIL"}  ${route} ${kind}: ${String(size[kind])} B gzip (budget ${String(limit[kind])}, allowed ${String(allowed)})`,
      );
    }
  }
  return { ok, lines };
}

function main(): void {
  const manifest = JSON.parse(
    readFileSync(path.join(CLIENT, ".vite/manifest.json"), "utf8"),
  ) as Manifest;
  const read = (file: string) => readFileSync(path.join(CLIENT, file));
  const sizes = Object.fromEntries(
    Object.entries(CRITICAL_ROUTES).map(([route, keys]) => [route, measure(manifest, keys, read)]),
  );
  // Sign-in must not carry the chat shell.
  const shared = new Set(firstLoadFiles(manifest, CRITICAL_ROUTES.login ?? []).js);
  const layoutFile = manifest[`app/routes/app-layout.tsx${CLIENT_ROUTE}`]?.file;
  if (layoutFile && shared.has(layoutFile)) {
    process.stderr.write("FAIL  login loads the chat layout chunk\n");
    process.exitCode = 1;
  }
  if (process.argv.includes("--write")) {
    const budget: Budget = {
      compression: "gzip",
      tolerance: 0.1,
      routes: Object.fromEntries(
        Object.entries(sizes).map(([route, s]) => [route, { js: s.js, css: s.css }]),
      ),
    };
    writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
    process.stdout.write(`perf:check: wrote ${path.relative(ROOT, BUDGET_FILE)}\n`);
    return;
  }
  const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Budget;
  const result = compare(sizes, budget);
  process.stdout.write(`${result.lines.join("\n")}\n`);
  if (!result.ok) {
    process.stdout.write("perf:check: over budget\n");
    process.exitCode = 1;
  } else process.stdout.write("perf:check: within budget\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

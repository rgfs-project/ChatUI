/**
 * Mutation-style invariant audit (Phase 17). For each invariant in the
 * register, temporarily break its enforcement with one targeted source
 * mutation, run the tests the register names, and require them to FAIL.
 * The source is always restored (also on Ctrl+C).
 *
 *   node scripts/invariant-audit.ts            every mutation
 *   node scripts/invariant-audit.ts INV-05 ... only these ids
 *
 * Writes docs/phase-reports/phase-17/invariant-audit.json. A mutation whose
 * search text is not found fails the audit (the register drifted).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MUTATIONS, type Mutation } from "./invariant-mutations.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs/phase-reports/phase-17/invariant-audit.json");

interface Result {
  id: string;
  file: string;
  what: string;
  tests: string[];
  outcome: "caught" | "survived" | "not-applied";
  seconds: number;
}

let restore: (() => void) | null = null;
process.on("SIGINT", () => {
  restore?.();
  process.exit(130);
});

function run(mutation: Mutation): boolean {
  const vitest = mutation.tests.filter((t) => /^tests\/(server|client|storage)\//.test(t));
  const e2e = mutation.tests.filter((t) => t.startsWith("tests/e2e/"));
  const verify = mutation.tests.includes("verify");
  let failed = false;
  if (vitest.length > 0) {
    const r = spawnSync("npx", ["vitest", "run", "--bail=1", ...vitest], {
      cwd: ROOT,
      stdio: "ignore",
      timeout: 15 * 60_000,
    });
    failed ||= r.status !== 0;
  }
  if (!failed && (e2e.length > 0 || verify)) {
    const build = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
    if (build.status !== 0) return true; // A mutation that breaks the build is caught.
    if (e2e.length > 0) {
      const r = spawnSync("npx", ["playwright", "test", "--max-failures=1", ...e2e], {
        cwd: ROOT,
        stdio: "ignore",
        timeout: 20 * 60_000,
      });
      failed ||= r.status !== 0;
    }
    if (!failed && verify) {
      const r = spawnSync("node", ["scripts/verify.ts"], { cwd: ROOT, stdio: "ignore" });
      failed ||= r.status !== 0;
    }
  }
  return failed;
}

const only = new Set(process.argv.slice(2));
const results: Result[] = [];
const touchedBuild = MUTATIONS.some(
  (m) =>
    (only.size === 0 || only.has(m.id)) &&
    m.tests.some((t) => t === "verify" || t.startsWith("tests/e2e/")),
);
for (const mutation of MUTATIONS) {
  if (only.size > 0 && !only.has(mutation.id)) continue;
  const started = Date.now();
  const edits = [
    { file: mutation.file, find: mutation.find, replace: mutation.replace },
    ...(mutation.also ?? []).map((e) => ({ ...e, file: e.file ?? mutation.file })),
  ];
  const originals = new Map<string, string>();
  for (const e of edits) {
    const file = path.join(ROOT, e.file);
    if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
  }
  const current = new Map(originals);
  let applicable = true;
  for (const e of edits) {
    const file = path.join(ROOT, e.file);
    const text = current.get(file) ?? "";
    if (text.split(e.find).length - 1 !== 1) applicable = false;
    else current.set(file, text.replace(e.find, e.replace));
  }
  let outcome: Result["outcome"];
  if (!applicable) {
    outcome = "not-applied";
  } else {
    restore = () => {
      for (const [file, text] of originals) writeFileSync(file, text);
    };
    try {
      for (const [file, text] of current) writeFileSync(file, text);
      outcome = run(mutation) ? "caught" : "survived";
    } finally {
      restore();
      restore = null;
    }
  }
  const result: Result = {
    id: mutation.id,
    file: mutation.file,
    what: mutation.what,
    tests: mutation.tests,
    outcome,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  results.push(result);
  process.stdout.write(`${result.outcome.padEnd(12)} ${result.id}  ${result.what}\n`);
}
// Leave a clean production build behind for later gates.
if (touchedBuild) spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });

mkdirSync(path.dirname(OUT), { recursive: true });
function readPrevious(): Result[] {
  try {
    return JSON.parse(readFileSync(OUT, "utf8")) as Result[];
  } catch {
    return [];
  }
}
const previous = readPrevious();
// The latest result per invariant wins (earlier runs of a changed mutation are dropped).
const latest = new Map<string, Result>();
for (const r of [...previous, ...results]) latest.set(r.id, r);
const merged = [...latest.values()].sort((a, b) =>
  a.id.localeCompare(b.id, "en", { numeric: true }),
);
writeFileSync(OUT, `${JSON.stringify(merged, null, 2)}\n`);
const bad = results.filter((r) => r.outcome !== "caught");
process.stdout.write(
  `invariant-audit: ${String(results.length - bad.length)}/${String(results.length)} caught${bad.length ? `; not caught: ${bad.map((b) => `${b.id} (${b.outcome})`).join(", ")}` : ""}\n`,
);
process.exit(bad.length === 0 ? 0 : 1);

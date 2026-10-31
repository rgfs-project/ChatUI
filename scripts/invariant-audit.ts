/**
 * Invariant audit (Phase 17, contracts §8): for each invariant, break its
 * enforcement on purpose and check that the tests the register names fail.
 * A mutation that leaves the tests green is a coverage gap.
 *
 *   node scripts/invariant-audit.ts            # every mutation
 *   node scripts/invariant-audit.ts INV-07 ... # only these
 *
 * Each mutation edits source files in place (every `find` must occur exactly
 * once), runs its check, and always restores the files. Checks that need the
 * production build (E2E, verify) rebuild first. Results are written to
 * docs/invariant-audit.md. Never run it with uncommitted work in the touched files.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MUTATIONS, type Mutation } from "./invariant-mutations.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHECK_TIMEOUT_MS = 10 * 60_000;

interface Result {
  mutation: Mutation;
  killed: boolean;
  detail: string;
  seconds: number;
}

function run(command: string[]): { code: number; out: string } {
  const [bin = "npx", ...args] = command;
  const res = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
    // A check that cannot finish under a mutation has not passed.
    timeout: CHECK_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
    return {
      code: 1,
      out: `the check did not finish within ${String(CHECK_TIMEOUT_MS / 60_000)} min`,
    };
  return { code: res.status ?? 1, out: `${res.stdout}\n${res.stderr}` };
}

function checkCommand(m: Mutation): string[][] {
  const commands: string[][] = [];
  if (m.e2e || m.verify) commands.push(["npx", "react-router", "build"]);
  if (m.vitest)
    commands.push(["npx", "vitest", "run", ...m.vitest, ...(m.grep ? ["-t", m.grep] : [])]);
  if (m.e2e)
    commands.push(["npx", "playwright", "test", ...m.e2e, ...(m.grep ? ["-g", m.grep] : [])]);
  if (m.verify) commands.push(["node", "scripts/verify.ts"]);
  return commands;
}

function failureLine(out: string): string {
  const line =
    out
      .split("\n")
      .find((l) => /FAIL |✘|AssertionError|Error:|expected .* to |did not finish/.test(l))
      ?.trim() ?? "";
  return line.replace(/\s+/g, " ").slice(0, 160);
}

function audit(m: Mutation): Result {
  const started = Date.now();
  const originals = new Map<string, string>();
  try {
    for (const edit of m.edits) {
      const file = path.join(ROOT, edit.file);
      const source = originals.get(file) ?? readFileSync(file, "utf8");
      if (!originals.has(file)) originals.set(file, source);
      const current = readFileSync(file, "utf8");
      const count = current.split(edit.find).length - 1;
      if (count !== 1)
        return {
          mutation: m,
          killed: false,
          detail: `mutation does not apply: ${edit.file} has ${String(count)} matches`,
          seconds: 0,
        };
      writeFileSync(file, current.replace(edit.find, edit.replace));
    }
    for (const command of checkCommand(m)) {
      const res = run(command);
      const isBuild = command.includes("build");
      if (isBuild && res.code !== 0)
        return {
          mutation: m,
          killed: false,
          detail: "the mutated code did not build",
          seconds: (Date.now() - started) / 1000,
        };
      if (!isBuild && res.code !== 0)
        return {
          mutation: m,
          killed: true,
          detail: failureLine(res.out),
          seconds: (Date.now() - started) / 1000,
        };
    }
    return {
      mutation: m,
      killed: false,
      detail: "tests stayed green",
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    for (const [file, source] of originals) writeFileSync(file, source);
  }
}

const only = new Set(process.argv.slice(2));
const selected = MUTATIONS.filter((m) => only.size === 0 || only.has(m.id));
const results: Result[] = [];
for (const m of selected) {
  process.stdout.write(`${m.id} ${m.title} … `);
  const result = audit(m);
  results.push(result);
  process.stdout.write(
    `${result.killed ? "KILLED" : "SURVIVED"} (${result.seconds.toFixed(0)}s) ${result.detail}\n`,
  );
}
// Rebuild the unmutated app so later commands see the real build.
if (selected.some((m) => m.e2e !== undefined || m.verify === true))
  run(["npx", "react-router", "build"]);

if (only.size === 0) {
  const rows = results.map(
    (r) =>
      `| ${r.mutation.id} | ${r.mutation.title} | ${[
        ...(r.mutation.vitest ?? []),
        ...(r.mutation.e2e ?? []),
        ...(r.mutation.verify ? ["scripts/verify.ts"] : []),
      ]
        .map((t) => `\`${t}\``)
        .join(
          ", ",
        )} | ${r.killed ? "**Killed**" : "**Survived**"}: ${r.detail.replace(/\|/g, "\\|")} |`,
  );
  writeFileSync(
    path.join(ROOT, "docs", "invariant-audit.md"),
    `# Invariant audit (Phase 17)

Generated by \`node scripts/invariant-audit.ts\` (mutations in \`scripts/invariant-mutations.ts\`). Each row breaks the invariant's enforcement on purpose and runs the tests the register names; **Killed** means at least one of them failed, as it must. INV-51 is covered by Phase 19.

| Invariant | Mutation | Tests run | Result |
| --- | --- | --- | --- |
${rows.join("\n")}

${String(results.filter((r) => r.killed).length)} of ${String(results.length)} mutations killed.
`,
  );
}
const survived = results.filter((r) => !r.killed);
process.stdout.write(
  `\n${String(results.length - survived.length)}/${String(results.length)} mutations killed\n`,
);
if (survived.length > 0) process.exitCode = 1;

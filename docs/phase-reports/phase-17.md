## Phase 17 report

- **Scope completed:**
  - **Invariant audit** (`npm run audit:invariants`, `scripts/invariant-audit.ts` + `scripts/invariant-mutations.ts`). For each invariant, one targeted source mutation breaks its enforcement; the tests the register names (Vitest, a Playwright spec, or `verify`) must fail; the source is always restored.
    - Where an invariant is enforced in several layers, every layer is mutated together:
      - INV-05: the `finish`, `abort` and completion guards.
      - INV-07: recovery's write-once check and the superseded check.
      - INV-40: capture, staging and the stored-status check.
    - Results: `docs/phase-reports/phase-17/invariant-audit.json`.
  - **Clean-checkout proof** (`npm run clean-checkout`, new CI job): fresh clone → `npm ci` → `.env` from `.env.example` → build → CLI admin (stdin) → `npm start` → browser login, send and a stored reply after reload → clearing `data/` (keeping `.gitkeep`) leaves no accounts.
  - **SSR reliability** (`tests/e2e/ssr.spec.ts`):
    - Parallel A/B document requests with sentinels (24 concurrent) never cross accounts.
    - A foreign 404 and an anonymous redirect carry no private markup.
    - Unknown route 404 vs missing conversation (shell + data state).
    - JSON 404 for the API and a non-HTML 404 for assets.
    - Every script carries the response nonce; no `unsafe-*`.
    - No duplicate conversation/model fetch after hydration; no service worker.
    - Without JS, `/settings` and `/admin` serve the shell fallback (their overlays are client portals).
  - **Feature parity:** `docs/feature-parity.md` covers every matrix row. Claude import is done with real fixtures; ChatGPT import is pending its export; ProseMirror, CodeMirror and interactive previews are not adopted or pending by design.
  - **CI:** added `perf:check` (it was missing) and the clean-checkout job.
- **Invariant audit results:** 60/60 caught.

  | Invariants                   | Result                                                                                                             |
  | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | INV-01–48, INV-50, INV-52–62 | Caught                                                                                                             |
  | INV-49                       | Container behavior; verified by `verify:compose` in CI (Docker and Podman green on `f2f7828`), not mutated locally |
  | INV-51                       | Pending (optional Phase 19)                                                                                        |

- **Gaps the audit found, closed with tests:**
  - INV-11: a dirty marker must force a rebuild when size and mtime are unchanged.
  - INV-17: re-enabling a disabled user must not revive the old session.
  - INV-28/39: attachment, memory and artifact ids must be checked by `DataPaths` itself.
  - INV-60: recovery must not create a stand-in conversation.
- **Bugs fixed:**
  - The Phase 16 container: the runtime image did not copy `server/backup.ts` and `server/http-limits.ts`, so the container could not start (CI `verify:compose` failed).
    - Fixed in `f2f7828`, with `tests/server/dockerfile.test.ts`, which walks the runtime import graph and fails on anything not copied into the image.
    - `verify:compose` now checks that `backup` refuses while the server holds `/data`, and `backup` refuses a destination inside `DATA_DIR`.
  - `scripts/perf-trace.ts` couldn't find the icon-only Send button (fixed in Phase 15).
- **Reliability:** 10 consecutive full runs, all green, with no retries (Playwright `retries: 0`):
  - Unit/integration: 51 files, 698 tests each.
  - E2E: 91 tests each, 5.9–6.9 minutes per run.
  - `verify` 93/93 and `perf:check` passed before the runs.
- **Performance** (production build, `perf-trace`, 4× CPU, 1.6 Mb/s, 150 ms RTT, 200-message conversation, median of 5):

  | Metric                                                   | Value     |
  | -------------------------------------------------------- | --------- |
  | Server TTFB                                              | 286 ms    |
  | First contentful paint (server HTML)                     | 1,357 ms  |
  | DOMContentLoaded                                         | 3,507 ms  |
  | Hydrated                                                 | 4,314 ms  |
  | Composer interactive                                     | 4,538 ms  |
  | Send → 202 (API)                                         | 402 ms    |
  | 202 → first assistant event (provider, mock 30 ms/chunk) | 27 ms     |
  | First event → painted (frontend)                         | 30 ms     |
  | JS transferred                                           | 207,434 B |
  | CSS transferred                                          | 5,086 B   |
  - Budgets: critical chat JS 202,873 B and critical CSS 5,769 B gzip, within budget and not raised. Math (62.9 KB), the highlighter (10.3 KB) and grammars stay out of cold loads.
  - Typing before hydration and hydration without warnings: `verify` (INV-56).
  - CLS was not measured by the trace (no layout-shift instrumentation), so it is not reported.

- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (51 files, 698 tests; 10/10 runs)
  - `build`: PASS
  - `verify`: PASS (93/93)
  - `test:e2e`: PASS (91/91; 10/10 runs)
  - `perf:check`: PASS
  - `clean-checkout`: PASS (working tree)
  - `verify:compose`: PASS in CI for Docker and Podman on `f2f7828` (not runnable here)
- **Limitations / unverified:**
  - Stryker mutation testing was not run; the targeted per-invariant mutations replace it.
  - Screen readers and non-Chromium engines were not run.
  - The live-provider E2E is opt-in and was not run (no live provider here).
  - CI image publishing is untouched (no release workflow was run).
- **Commit/tag:** `test(phase-17): invariant audit, e2e coverage, clean-checkout proof` on `main`, tag `phase-17`, pushed to `origin`.

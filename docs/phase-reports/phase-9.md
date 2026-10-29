## Phase 9 report

Same deterministic fixture before (tag `phase-14`) and after: the production build, the mock provider, the seeded 200-message chat, Chromium on this machine, the median of 10 loads after one warm-up. All local; provider delay is excluded (the mock answers at once).

- **Scope completed:**
  - Bundle audit: removed Zod from the browser bundle.
  - `perf:check` with `performance-budget.json`, run by `verify` and CI.
  - Performance marks and `window.__chatuiPerf()`.
  - Bounded intent prefetch.
  - Cancellation of in-flight fetches before mutation writes.
  - A prompt-prefix reuse test.
  - The architecture write-up.
- **Before → after:**

  | Metric                                   | Before (phase-14) | After                  |
  | ---------------------------------------- | ----------------- | ---------------------- |
  | Chat route JS, gzip-9                    | 254,364 B         | **229,979 B** (−9.6 %) |
  | Chat route CSS, gzip-9                   | 6,773 B           | 6,773 B                |
  | Sign-in route JS, gzip-9                 | 128,195 B         | 128,195 B              |
  | Server TTFB, `/chat/<id>` (200 messages) | 97 ms             | 103 ms                 |
  | First contentful paint                   | 248 ms            | 244 ms                 |
  | Hydration complete                       | 518 ms            | 536 ms                 |
  | Composer interactive (ComposerTTI)       | n/a (no mark)     | 522 ms                 |

  Timing differences are within run-to-run noise on this machine. The change is the 24 KB of JavaScript no longer shipped. Useful HTML (shell, transcript, native composer) arrives with the first response; pre-hydration typing survives (verify, `resilience.spec.ts`).

- **Budget:** `performance-budget.json` records the after values, with 10 % tolerance.
- **Required tests:**
  - INV-29: loader start order.
  - INV-30: held secondary list, slow scripts.
  - Prefetch (`tests/client/prefetch.test.ts`, `perf.spec.ts`): delay, cancel, cap, reuse, newer data wins.
  - Lazy loading: Settings and Admin chunks absent from the chat load and fetched on demand; a failed Settings chunk recovers, because React Router reloads the page and Settings opens next time. `/settings` and `/admin` direct loads are covered by `resilience.spec.ts`.
  - Streaming: render probes, the 200-message E2E and find-in-page.
  - Assets and caching: verify.
  - Instrumentation: `perf.spec.ts` (once each; ComposerTTI and FirstAssistantEvent computed; no content, username or URL in marks).
  - `perf:check` passes against the recorded budget and fails against a lowered one (`tests/scripts/perf-check.test.ts`).
  - Prompt-prefix reuse (`tests/server/prompt.test.ts`).
- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (419)
  - `build`: PASS
  - `perf:check`: PASS
  - `verify`: PASS (78/78)
  - `test:e2e`: PASS (44/44)
  - `npm audit`: 0
  - `verify:compose`: CI
- **Invariants:** INV-29 to INV-33 implemented (table updated).
- **Dependencies:** none new.
- **Deviations / limitations / unverified items:**
  - Live llama.cpp prompt-token reuse is UNVERIFIED (no endpoint here); the formatted-message prefix is asserted with the mock.
  - Timings come from one machine, so they are evidence, not CI thresholds.
  - Route-chunk prefetch on intent is not added: Settings and Admin chunks are small, and opening them fetches them.
- **Commit/tag:** `perf(phase-9): composer-first loading, prefetching, bundle budgets, instrumentation`, tag `phase-9` (local), pushed to `main`.

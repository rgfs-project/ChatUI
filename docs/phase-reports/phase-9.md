## Phase 9 report

- **Scope completed (files/features):**
  - Audit of the existing SSR foundation (no migration):
    - Framework Mode route chunks inspected through the production manifest and sourcemaps (`CHATUI_SOURCEMAP=1` opt-in).
    - Express ordering, statuses and private HTML re-verified.
    - One defect fixed: `.data` route data (private dehydrated state) had no `Cache-Control`; it is now `private, no-store` (`handleDataRequest` in `app/entry.server.tsx`).
  - Asset delivery:
    - Build-time Brotli/gzip variants (`scripts/compress-assets.ts`), served by `server/static-compressed.ts` with `Vary` and immutable caching.
    - The JS sent on a cold chat load fell from 673 KB (it was uncompressed) to 188 KB.
  - Bundle boundaries:
    - Lazy `Menus` (row, title and account menus: Radix DropdownMenu + Floating UI), `Dialogs` (Radix Dialog + scroll lock) and `ReauthDialog`.
    - TanStack Query moved from the root into the chat shell, so public and sign-in pages don't load it.
    - Parse-only GFM plugin: drops the unused Markdown serializer.
    - Chunk-failure recovery: React Router reloads on route chunks; the section boundary reloads on lazy chunks.
  - Query/prefetch identity:
    - `queries.*` options are shared by the view, the new `clientLoader` of `/chat/:id` (no `.data` round trip on client navigation) and the intent prefetch.
    - Intent prefetch (`app/lib/prefetch.ts`): hover 80 ms or focus, one speculation, low priority, aborted on intent change, claimed by navigation.
    - `prefetch="intent"` on links for route chunks.
  - Instrumentation (`app/lib/perf.ts`): the §9.5 marks plus `stream-open`/`first-assistant-paint`, the `ComposerTTI` and `FirstAssistantEvent` measures, a dev console helper `chatuiPerf()`, and a deterministic trace tool (`scripts/perf-trace.ts`, `npm run perf:trace`).
  - Budget: `scripts/perf-check.ts`, `performance-budget.json` (gzip level 9, 10% tolerance), wired into `verify` (with a lowered-budget failure check) and therefore into CI.
  - Prompt prefix: a mock-provider test on formatted prompts, and a live probe (`scripts/probe-prefix.ts`).
- **Critical-path dependency graph:** unchanged from Phase 8 (session middleware → {models ≤ 2.5 s, active conversation + activeGeneration} concurrently → HTML with transcript and native composer → hydrate → SSE for the active generation; the conversation list is secondary). New in this phase: client navigations between conversations read the Query cache (possibly prefetched) instead of a server data request.
- **Before/after trace:** `node scripts/perf-trace.ts 5`, same fixture (the 200-message conversation, mock provider), 4× CPU, 1.6 Mbit/s down with 150 ms latency, cache disabled, medians of 5 cold loads of `/chat/<id>`.

  | Metric (ms unless noted)                                               | Before (Phase 8 build) | After (Phase 9) |
  | ---------------------------------------------------------------------- | ---------------------- | --------------- |
  | Server TTFB                                                            | 94                     | 74              |
  | First contentful paint (server shell)                                  | 898                    | 745             |
  | DOMContentLoaded                                                       | 1,836                  | 1,446           |
  | Hydration complete                                                     | 4,772                  | 2,223           |
  | ComposerTTI (composer interactive)                                     | 4,791                  | 2,249           |
  | JS transferred                                                         | 673,188 B              | 187,889 B       |
  | CSS transferred                                                        | 7,675 B                | 1,877 B         |
  | Send → 202 (unthrottled)                                               | 130                    | 107             |
  | 202 → first assistant event (mock provider, includes its 30 ms pacing) | 64¹                    | 21              |
  | First assistant event → painted                                        | n/a¹                   | 43              |

  ¹ The Phase 8 build had no app marks, so "before" timed the first _painted_ content from the DOM.

  - After (last run), marks relative to navigation start: shell-painted 732, conversation-visible 2,222, hydration-complete 2,224, composer-interactive 2,248, generation-accepted 2,473, stream-open 2,494, first-assistant-event 2,494, first-assistant-paint 2,511.
  - Frontend vs provider delay: `stream-open → first-assistant-event` is provider time; `first-assistant-event → first-assistant-paint` is frontend time.
  - Composer before hydration: the native textarea is in the server HTML and typeable before JS. `tests/e2e/state.spec.ts` types at `DOMContentLoaded` on a slow network and the text survives hydration. Markup visibility (FCP ≈ 0.75 s) is reported separately from send interactivity (ComposerTTI).

- **Route and asset sizes** (gzip level 9, cold visit; `perf:check`):

  | Group                          | Start of Phase 9 (v1) | v1 final  | This build (budget) |
  | ------------------------------ | --------------------- | --------- | ------------------- |
  | critical-chat-js (`/chat/:id`) | 218,067 B             | 183,637 B | 186,534 B           |
  | new-chat-js (`/chat/new`)      | 217,636 B             | 183,219 B | 186,115 B           |
  | login-js                       | 123,447 B             | 115,534 B | 115,242 B           |
  | critical-css                   | 2,197 B               | 2,197 B   | 4,649 B             |
  | all-client-js                  | 224,459 B             | 222,462 B | 226,699 B           |
  - "v1" is the first Phase 9 implementation (before the redesign). This build adds the redesigned shell, the message queue, the "/" command list and sidebar controls: +2.9 KB of critical JS (+1.6 %, within the 10 % tolerance of the v1 budget) and +2.4 KB of CSS for the new states and theme. The budget file was regenerated from this build.
  - The "start" column was measured with the same script on the Phase 8 code plus about 2 KB of the first Phase 9 instrumentation.
  - Remaining critical weight: React DOM (about 60 KB), React Router, TanStack Query and the Markdown pipeline (about 50 KB). All are required on the critical route.
  - On demand: `Menus` + Floating UI, `Dialogs`, `ReauthDialog`, and the `settings`/`admin` route chunks (prefetched when the account menu opens).

- **Live prompt-prefix measurement** (`scripts/probe-prefix.ts`, llama.cpp router mode, model "Gemma 4", 4 turns, append-only history):

  | Turn | Prompt tokens | Processed | Reused from cache | TTFT   |
  | ---- | ------------- | --------- | ----------------- | ------ |
  | 1    | 1,002         | 995       | 7                 | 46.7 s |
  | 2    | 1,028         | 31        | 997               | 24.7 s |
  | 3    | 1,054         | 26        | 1,028             | 30.0 s |
  | 4    | 1,080         | 26        | 1,054             | 20.8 s |

  After the first turn only the new turn is processed (about 97% cache reuse). TTFT on this host is dominated by per-request overhead (as recorded in Phase 2), not prompt processing.

- **Required tests:**
  - INV-29 (loader overlap with gated services, measured concurrency, a hanging model endpoint bounded by the budget): `tests/client/startup.test.tsx`
  - INV-30 (held secondary list, composer usable and draft kept): `tests/client/state.test.tsx`, `tests/e2e/state.spec.ts`
  - Prefetch (bounded, low priority, touch ignored, changed intent aborts, click reuses the in-flight request, an old prefetch can't overwrite newer data): `tests/client/prefetch.test.tsx`
  - Lazy loading:
    - interaction chunks absent from the server's modulepreloads and the initial load, and fetched on intent: `tests/e2e/perf.spec.ts`
    - route-chunk failure recovery: `tests/e2e/perf.spec.ts`
    - `/settings` and `/admin` direct and from a backdrop: `tests/e2e/ui.spec.ts`, `state.spec.ts`
    - the placeholder trigger opens once the menu chunk arrives: `tests/client/primitives.test.tsx`
  - Streaming (200 messages, incomplete Markdown, no remounts, older text findable): `tests/client/conversation-view.test.tsx`, `tests/e2e/ui.spec.ts`
  - Assets (first-party only, no service worker, hashed assets immutable and Brotli-encoded, documents `no-store`): `tests/e2e/perf.spec.ts`, `verify`
  - Precompressed serving: `tests/server/static-compressed.test.ts`
  - Instrumentation (once per event, lifecycle order, `ComposerTTI` and `FirstAssistantEvent`, no sentinel or username in marks): `tests/client/perf.test.ts`, `tests/e2e/perf.spec.ts`
  - `perf:check` (the real budget passes, a halved one fails): `verify`
  - Production SSR proof: `verify` interleaves A/B requests over documents, `.data` route data, error pages and `/chat/new` with a private sentinel, and checks that B never sees it and that documents and route data are `private, no-store`. The existing no-JS, CSP, 404 and hydration checks remain.
  - Prompt prefix: `tests/server/prompt-prefix.test.ts`
- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (32 files, 441 tests)
  - `verify`: PASS (76/76, including `perf:check`)
  - `test:e2e`: PASS (27/27)
  - `verify:compose` (Docker, rootless Podman) runs in CI
  - `npm audit`: 0 vulnerabilities
- **Invariants:**
  - INV-29/30 → startup graph and deferred list → startup/state tests and E2E
  - INV-31 → shared `queries.*` + `clientLoader` + prefetch → prefetch tests
  - INV-32 → counters → 200-message streaming test
  - INV-33 → first-party assets, no service worker → perf E2E and verify
  - INV-54 to INV-57 → re-verified; `.data` now `private, no-store`
- **Behaviour changes from earlier phases:**
  - Client navigation between conversations no longer requests `/chat/<id>.data`; it reads the shared Query cache.
  - The conversation menu and dialogs load on first use.
  - Sign-in pages no longer load TanStack Query.
- **Dependencies:**
  - Removed `remark-gfm`, replaced by its two building blocks: `micromark-extension-gfm` 3.0.0 and `mdast-util-gfm` 3.1.0. The wrapper also registered a serializer ChatUI never uses.
  - Added `remark-parse` 11.0.0 as a dev dependency, for types only; it's already a runtime dependency of `react-markdown`.
- **Fallback / rollback evidence:**
  - Every change is additive or reversible per commit, with no data or API changes.
  - Precompressed assets fall back to `express.static` for clients that accept no encoding, and for files without a variant (tested).
  - A missing lazy chunk degrades to a section error with reload; a missing route chunk to React Router's reload (tested).
  - The budget file can be regenerated with `node scripts/perf-check.ts --write` (the report must explain any increase).
- **Deviations / limitations / unverified items:**
  - This Phase 9 was re-done on the redesigned Phases 7–8 (main was reset to Phase 6 earlier); the first Phase 9 (now `archive/phase-9-v1`) was the reference. Its tooling, server compression, marks, prefetch and tests were ported; lazy loading was extended from the row menu to all three menus (row, title, account) and the shared dialogs. The trace numbers below the size table are from v1 and were not re-recorded for the restyled UI; the structure (critical path, deferred work) is unchanged.
  - Settings moved from a header link into the account menu (redesign). Its "hover prefetch" is now "menu-open prefetch": the menu items are real `<Link prefetch="render">`s, which also lets React Router's lazy route discovery find `/settings` and `/admin`.
  - Timings come from a throttled local Chromium, not field data; production telemetry is out of scope.
  - The "before" bundle sizes were measured at the start of this phase rather than from a clean Phase 8 build (a worktree build couldn't resolve its symlinked `node_modules`). The "before" trace itself is the clean Phase 8 build.
  - HTML/JSON responses are not compressed in-process (BREACH); the TLS proxy may compress them per its policy.
  - Local presentation hints (sidebar collapse, last-viewed conversation) were not added; server state already renders immediately.
- **Commit/tag status:** commit `perf(phase-9): composer-first loading, prefetching, bundle budgets, instrumentation` (squash-merged from `ci/phase-9`) and tag `phase-9`, pushed to `origin/main`.
- **Questions needing approval:** none.

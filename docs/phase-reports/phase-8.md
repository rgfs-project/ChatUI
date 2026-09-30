## Phase 8 report

- **Scope completed (files/features):**
  - Startup dependency graph (`app/routes/app-layout.tsx`, `app/routes/chat-conversation.tsx`):
    - critical: session (middleware), models (layout loader, ≤ 2.5 s budget), active conversation with its `activeGeneration` (child loader), loaded concurrently
    - secondary: the conversation list, no longer server-seeded; the sidebar loads it after hydration, with loading, empty and error states
    - `shouldRevalidate` keeps client navigations from re-running the layout guard
  - Auth state (`app/lib/auth-store.ts`):
    - explicit `unknown | authenticated | unauthenticated`, epoch and `expired`; `useAuth()` derives from the SSR session until initialized, so there's no flash
    - the fetch adapter keeps no session copy of its own
    - `useAccountBoundary` aborts and purges on every identity transition
  - Request lifecycle: `queries.*` option factories (single key + fetcher pairing), an `AbortSignal` in every fetcher, a retry predicate (network/5xx only), SSE events filtered by the observed generation id (`app/lib/use-live-generation.ts`).
  - Optimistic sends (`app/lib/send.ts`, `ConversationView`): mutation-state-rendered messages with temporary ids. Rejection rolls back and restores the text. Unknown outcomes resend with the same key (bounded). `OPERATION_EXPIRED` or exhausted retries give "outcome unknown", with a key lookup (`GET /api/operations/:key`) and "Edit and resend".
  - Session expiry mid-use: any 401 opens the in-app re-authentication dialog (`app/components/SignedOutShell.tsx`) without navigating. Private content is hidden and the account's queries and mutations are aborted and dropped. Drafts live in account-keyed tab memory: restored for the same user, discarded for another identity, the sign-in page, logout or reload. No browser storage.
  - Error boundaries: the shell (route `ErrorBoundary`) plus sidebar and main sections (`app/components/SectionBoundary.tsx`, `react-error-boundary` + `QueryErrorResetBoundary`), each with retry. Inline retry for query failures.
  - Empty states: no conversations; no provider configured; all providers unavailable (Retry forces discovery); a stale list from unreachable providers; an empty conversation.
  - `Composer` extracted from `ConversationView`.
- **Startup dependency graph:**

  ```text
  document request
   └─ session middleware (critical; authorization precedes any private read)
       ├─ root loader: session DTO ............ critical
       ├─ layout loader: models ............... critical, ≤ 2.5 s budget   ┐ concurrent
       └─ chat loader: conversation + activeGen critical                   ┘
  HTML: shell + authorized transcript + native composer (typing works pre-JS)
  hydrate (seeded queries reused, no refetch)
   ├─ SSE for the active generation ........ critical
   └─ GET /api/conversations (sidebar) ..... secondary, never gates the composer
  ```

- **Timing evidence:**
  - `tests/client/startup.test.tsx` runs the real loaders through React Router's static handler with controllable services. Both critical dependencies start before either resolves (gated promises). With two 150 ms dependencies, the whole loader pass takes about 150 ms (asserted between 145 and 290 ms). The conversation list is never called.
  - `tests/e2e/state.spec.ts`, cold load of the 200-message conversation at 256 kbit/s with 300 ms latency, the list request held open by the test:
    - hydrated after 25,228 ms
    - composer usable after 25,264 ms
    - reply sent and stored at 28,273 ms, while the list was still pending
  - Text typed at `DOMContentLoaded`, before hydration, survived hydration.
- **Required tests:**
  - cold concurrent load with overlapping timings: `startup.test.tsx`
  - secondary list held open while the composer becomes usable: `state.test.tsx` (jsdom) and `state.spec.ts` (browser)
  - hard reload of `/chat/:id`, `/settings`, `/admin` with no `/api` response as HTML: `state.spec.ts`
  - slow network: `state.spec.ts`
  - reordered responses, where an older one resolving last never wins and is aborted: `state.test.tsx`
  - rapid conversation switching (random data latency in the browser) and rapid model switching: `state.test.tsx`, `state.spec.ts`
  - sign out → another user, with no cache reuse: `query.test.tsx` (boundary) and `ui.spec.ts` (account switch)
  - Strict Mode, with no duplicate mutation: `state.test.tsx`
  - optimistic reconcile, explicit rollback, dropped-202 same-key resend, outcome unknown, `OPERATION_EXPIRED`: `state.test.tsx`
  - session expiry mid-use: `session-expiry.test.tsx` (same-user restore, different-user discard, reload discard, sign-in page discard, no storage writes, no auth flash), `api.test.ts` (once-only expiry, epoch rules), `state.spec.ts` (real revocation, in-app re-auth without navigation, reload discard)
  - error boundary recovery: `state.test.tsx`
  - empty states: `state.test.tsx`
- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (28 files, 423 tests)
  - `verify`: PASS (70/70)
  - `test:e2e`: PASS (23/23)
  - `verify:compose` (Docker, rootless Podman) runs in CI
  - `npm audit`: 0 vulnerabilities
- **Invariants:**
  - INV-23 → identity-scoped keys, abort signals, navigation abort, boundary cancellation, SSE id filter, epoch-tagged sends → `state.test.tsx`, `query.test.tsx`, `state.spec.ts`
  - INV-29 groundwork → concurrent critical loaders, deferred list → `startup.test.tsx`, `state.spec.ts` (Phase 9 adds budgets)
  - INV-55/56 → unchanged, still covered; the boundary now also runs on expiry
- **Behaviour changes from earlier phases:**
  - The sidebar list is not in the server HTML any more (it loads after hydration).
  - After an in-app session expiry, the app opens a re-authentication dialog instead of redirecting on the next navigation. A signed-out document request still redirects to `/login` with a return-to.
  - Sign-out goes through the auth store; the fetch adapter no longer dispatches a window event.
- **Dependencies:** `react-error-boundary` 6.1.6. It is the standard maintained boundary component (reset keys, `onReset`), and pairs with TanStack's `QueryErrorResetBoundary`.
- **Deviations / limitations / unverified items:**
  - This Phase 8 was re-done on the redesigned Phase 7 (main was reset to Phase 6 earlier); the earlier Phase 8 (now `archive/phase-8-v1`) was the reference. Its Composer/ConversationView split, send module, auth store, boundaries and tests were ported and restyled; the tag is moved to this commit.
  - Queued messages (a Phase 7 user request) go through the optimistic send mutation one at a time, so they get the same rollback, resend and unknown-outcome behaviour; a rejected queued send returns it and the rest of the queue to the box.
  - The model list re-reads on tab focus through the canonical `queries.models` options (bypassing the server cache only when refreshing an existing list); the "Retry" in the model notice remains for the empty/error states.
  - An expired session is detected on the next API call, data request or stream close, not by polling.
  - A send that is still retrying when the session expires is discarded rather than kept; the conversation shows the truth after re-authentication.
  - React Router's `ScrollRestoration` keeps scroll positions in `sessionStorage`; no draft or private content is ever written there (asserted).
- **Commit/tag status:** commit `feat(phase-8): resilient client state, loading, and request lifecycle` (squash-merged from `ci/phase-8`) and tag `phase-8`, pushed to `origin/main`.
- **Questions needing approval:** none.

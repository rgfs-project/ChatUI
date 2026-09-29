## Phase 3 report

- **Scope completed (files/features):**
  - Format (a):
    - `server/storage/markdown.ts`: `formatVersion: 1` parser and pure serializer, exactly per contracts §3, including every attribute (`attachments` is parsed and validated only), escaping, CRLF/BOM, zero-message files and typed malformed results.
    - `tests/storage/markdown.test.ts`: example-based rules plus fast-check round-trip, idempotence, normalization and no-throw properties.
  - Storage (b):
    - `server/storage/paths.ts`: central path construction (INV-12).
    - `server/storage/fs.ts`: atomic durable writes, temp cleanup, durable unlink.
    - `server/storage/locks.ts`: keyed FIFO locks with a held count.
    - `server/storage/conversations.ts`: store with create, get, rename, delete, auto-title and revisions.
    - `server/storage/operations.ts`: acceptance records.
    - `server/storage/recovery.ts`: Phase 3 startup recovery.
  - Index (c): `server/storage/chat-index.ts` (write queue, dirty marker, rebuild, size/mtime reconciliation) and `npm run index:rebuild` / `node server/cli.ts index:rebuild`.
  - Generation integration and UI (d):
    - `server/chat/send-service.ts`: contracts §4.1 acceptance, in-process resolution of failed acceptance, terminal write.
    - `server/chat/prompt.ts` + `server/chat/token-counter.ts`: server-side prompt assembly, formatted-prompt counting via `/apply-template` + `/tokenize`, pessimistic fallback, anchored prefix-stable truncation, `CONTEXT_TOO_LARGE`.
    - Generation manager reworked: reservations, one active run per conversation, persist-then-publish terminal sequence with the revision.
    - API routes:
      - `/api/conversations` (GET, POST)
      - `/api/conversations/:id` (GET, PATCH, DELETE)
      - `/api/operations/:operationKey`
      - `POST /api/generations` with the §4.1 body
    - Error codes: `CONVERSATION_MALFORMED`, `GENERATION_IN_PROGRESS`, `CONTEXT_TOO_LARGE`, `OPERATION_KEY_MISMATCH`, `OPERATION_EXPIRED`, `CONFLICT`.
    - `/chat` UI: conversation list, new, open via `?c=`, rename, delete, send with same-key retries.
  - Config: `LOCAL_USER_ID`, `OPERATION_RETENTION_MS`, `CONTEXT_TRIM_STEP`, `TEMPLATE_OVERHEAD_TOKENS`.
- **Acceptance criteria with test evidence:** all gates pass. `README.md` documents the single-process limitation and backup expectation (back up all of `data/`; `index/` optional). `ARCHITECTURE.md` maps INV-07 to INV-14, plus INV-58 and the INV-60 Phase 3 portion. `verify` runs the full scenario on the production build with real restarts:
  1. send
  2. restart → persisted
  3. delete index → restart → rebuilt
  4. hand-edit → reflected after restart
  5. corrupt one file → `CONVERSATION_MALFORMED` while another conversation still sends
  6. delete → gone
- **Required tests (where):**
  - Round-trip (example + property), every delimiter acceptance/rejection rule, escaping, front matter (unknown, missing, duplicate, reordered keys; version), reasoning/assistant adjacency: `markdown.test.ts`.
  - Index generation, rebuild and reconciliation; atomic write crash before rename; locking with 25 concurrent appends; malformed isolation; path traversal: `storage.test.ts`.
  - Prompt assembly, truncation, consecutive-user normalization after failure, anchored window and prefix stability, formatted recount, budget with multilingual text, emoji and code (exact via template and via fallback, which never under-counts the probe's real counts): `prompt.test.ts`.
  - `conversations.test.ts`:
    - `GENERATION_IN_PROGRESS`; deletion ordering and discard of a running reply; restart persistence
    - first-send rejections leave nothing; the revision race (one change absorbed, two → `CONFLICT` without mutation); no network under lock
    - title sentinel edge cases (failed reply doesn't title; rename to the sentinel re-enables; removing the first reply doesn't block); new-block timestamps; revision in DTO, rename response and terminal SSE event
    - operation keys: retry while active returns the original `202`, lookup, concurrent duplicates, two keys → two sends, mismatch, expired/future, survival across restart
    - crashes after pending / after Markdown / at startup, resolved by hash, never overwriting or recreating
    - `INTERNAL` after acceptance begins
  - Volatile time values before the newest user message: N/A until Phase 10 adds them (no volatile values exist).
- **Quality gates:**
  - `format:check`: PASS
  - `lint`: PASS
  - `typecheck`: PASS
  - `test`: PASS (13 files, 231 tests; two consecutive runs)
  - `build`: PASS
  - `verify`: PASS (56/56)
  - `verify:compose`: PASS on Docker and rootless Podman in CI (run 36528268920)
  - `npm audit`: 0 vulnerabilities
- **Invariants:**
  - INV-07 → `SendService.persistOutcome` + manager decision guard.
  - INV-08 → `SendService.commit`.
  - INV-09 → `markdown.ts`.
  - INV-10 → store and send malformed handling.
  - INV-11 → `ChatIndex`.
  - INV-12 → `paths.ts` + `canonicalUuid`.
  - INV-13 → `GenerationManager.reserve`.
  - INV-14 → `RouteServices.userId`.
  - INV-58 → `SendService` + `OperationStore`.
  - INV-60 (3) → `recovery.ts`.
  - Tests are listed in ARCHITECTURE.md.
- **Security, SSR, data and performance observations (bugs found by tests and fixed):**
  1. Provider streaming started while the conversation lock was still held: an async generator's first `next()` ran inside the locked section. Generation launch now happens after the lock is released.
  2. Uppercase UUIDs passed `z.uuid()` and reached the path module (500). Id params now require canonical lowercase UUIDs (400).
  3. A restart would not reflect hand edits unless the index was dirty. The index now reconciles by file size/mtime at startup.
  4. Acceptance that failed after the pending record could leave a key unresolvable until restart. It is now decided in-process by hashes.
  - The container still writes nothing: storage runs only with the loopback chat demo.
- **Dependencies and why approved:**
  - `yaml` 2.9.1: YAML 1.2 core-schema front matter with duplicate-key detection and key order.
  - `fast-check` 4.10.2 (dev): property-based round-trip tests required by the phase.
- **Deviations / limitations / unverified items:**
  - The spec's four sub-commits (a–d) were made as work-in-progress commits on the temporary `ci/phase-3` branch and squashed into the single phase commit on `main`, per the project owner's workflow.
  - Committed-but-unlaunched sends stay unanswered until Phase 6 (as specified).
  - `index:rebuild` must run with the server stopped (single process).
  - Live-provider token counting was exercised against the mock; the live server's `/apply-template` and `/tokenize` were verified by the Phase 2 probe.
- **Commit/tag status:** commit `feat(phase-3): canonical markdown persistence, derived index, atomic durable writes` and tag `phase-3`, pushed to `origin/main`.
- **Questions needing approval:** none.

## Phase 13a report

- **Plan:** package 13a (contracts §4.2) plus the roadmap's reference-UI items:
  - edit in place, delete one exchange, regenerate, clear history;
  - Ctrl/⌘+K search with tabs, jump and marks;
  - pins with a folding Pinned section;
  - Copy/Edit/Delete under user messages and Regenerate on replies.

  Added mid-phase at the project owner's request: Settings and Administration became full-window pages in the style of the reference (a navigation column with "Back to chat", search and sections; grouped cards of rows), similar to it but not a copy.

- **Scope completed:**
  - **Server:**
    - `server/chat/turns.ts`: turn grammar with exchanges and irregular regions.
    - `server/chat/mutations.ts`: edit (truncates later blocks; may keep or drop the turn's files, never add), delete exchange, clear history, pin cleanup. All run under the conversation lock with the idle and revision checks.
    - `SendService.regenerate`: fresh provider contact, capability check against the turn's media, preflight, revision re-check under the lock, fresh ids, idempotent by operation key.
    - `server/chat/search.ts`: user-scoped, bounded full-text search over titles and message text, plus files by name; a malformed file never fails it.
    - Routes: `PATCH`/`DELETE /api/conversations/:id/messages/:messageId`, `POST …/regenerate` (`202`), `POST /api/conversations/clear`, `GET /api/search`. Deleting a chat now removes its pin.
  - **Browser:**
    - Message actions: Copy/Edit/Delete under user messages; the bubble becomes an editor with Cancel and Send (Enter sends, Escape cancels); Regenerate on replies asks first. Actions that change history hide while a reply runs.
    - Search dialog (lazy chunk): recent chats with an empty query; All/Chats/Images/Documents tabs; `<mark>` snippets; arrow keys and Enter. Opening a chat result scrolls to the message and marks every match once with the CSS Custom Highlight API.
    - Sidebar: a search button in the header; a folding Pinned section in pin order; Pin/Unpin in the row and chat menus.
    - Settings → General → Delete all chats.
    - Settings and Administration: full-window pages (`app/settings/page-layout.tsx`); rows grouped in rounded cards; the page starts focused on itself.
  - **Fixes found by the new tests:**
    - The optimistic copy of a sent message came back as "Sending…" after an edit or delete removed the stored message. It is now cleared once the stored conversation has it.
    - Shortcuts didn't fire with nothing focused (keys went to the body, outside the app element). The body now forwards them.
    - On phones the two sidebar header buttons' 44 px tap areas overlapped; they are now 8 px apart.
- **Required tests:**
  - `tests/server/mutations.test.ts` (11):
    - Edit truncation and stale revision.
    - Delete keeps system blocks; edit removes later system blocks.
    - Irregular regions refused with the file unchanged.
    - Regenerate: fresh ids, idempotent by key, unanswered turn, edit-then-regenerate CONFLICT.
    - Capability `422` and unreachable provider `502` leave the file unchanged.
    - `GENERATION_IN_PROGRESS` for all four operations, then success after cancel.
    - Files removed with their turns; clear history keeps other preferences.
    - Crash after a regeneration commit: an interrupted reply with no duplicates.
    - Search per user and bounded, with a malformed file.
    - INV-34 pins.
  - `tests/e2e/conversation-ops.spec.ts` (6):
    - Edit in place: Cancel, then Send with regeneration, surviving a reload.
    - Regenerate: confirm, cancel, replace. Delete removes one exchange.
    - Actions hide while a reply streams.
    - Search: keyboard, snippet mark, jump and highlight, empty result.
    - Pin: Pinned section, reload, fold, unpin.
    - Delete all chats.
  - `tests/e2e/routing.spec.ts`: Settings closes with "Back to chat".
  - `tests/e2e/mobile.spec.ts`: touch targets include the new header button.
- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (470)
  - `build`: PASS
  - `perf:check`: PASS
  - `verify`: PASS (81/81)
  - `test:e2e`: PASS (65/65)
  - `verify:compose`: CI
- **Budget:** re-recorded:
  - chat JS 239,539 → 244,238 B (message actions, ops provider, Pinned section)
  - CSS 7,960 → 8,418 B
  - sign-in JS 129,601 → 129,999 B

  The search dialog has its own JS and CSS chunk.

- **Invariants:** INV-35 and INV-36 implemented; INV-34 extended (pins).
- **Dependencies:** none new.
- **Deviations / limitations:**
  - Search reads every conversation on a cache miss (fine at single-user scale).
  - Editing can drop a message's files but not add new ones (as specified).
  - The Library page keeps its current header; the reference's tabbed table is left for the polish phase.
- **Commit/tag:** `feat(phase-13a): search, pins and conversation mutations`, tag `phase-13a`, pushed to `main`.

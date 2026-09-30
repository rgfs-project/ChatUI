## Phase 15 report

- **Scope completed:** an audit of every interactive control against the Phase 7 decision record, with the defects fixed in place. No primitive was replaced (none failed a requirement), and the native textarea composer is retained. The full audit table is in `ARCHITECTURE.md` under "Phase 15 audit".
  - **Focus return (defect).** Radix's modal dialog returns focus only to its `Dialog.Trigger`, and ChatUI opens dialogs through `open`. So closing a confirmation (Settings → Delete all, memory/admin deletions), Search or the Settings overlay dropped focus to `<body>`.
    - New `app/lib/focus-return.ts` remembers the opener and restores it. An opener inside a menu resolves to the menu's trigger.
    - Applied to `ConfirmDialog`, `RenameDialog`, `Overlay` and `SearchDialog`.
  - **Contrast (defect).** `--faint` (2.8:1) was used for text: section labels, command groups, queued-message meta and the composer placeholder. Text now uses `--muted` (5.3:1), and search snippets use `--fg-2`.
  - **Keyboard scrolling (defect).** Settings panes scroll on their own; they are now focusable with a focus ring.
  - **Safari IME (defect).** The Enter committing a composition has `isComposing: false` and keyCode 229 in Safari; both are now checked.
  - **Double send.** A submit with no text and no ready attachment is ignored. This is defensive: React's synchronous re-render already prevents it, and the test passes either way.
  - **RTL text.** `dir="auto"` on the composer and user messages, and `unicode-bidi: plaintext` per Markdown block. The UI chrome stays English LTR.
  - **Tooling.** `scripts/perf-trace.ts` works again: it now recognizes the icon-only Send button.
  - **Decisions:** keep native `title` tooltips and `role="status"` toasts, the native model `<select>`, and the textarea. ProseMirror/Tiptap stays out of scope: no rich-input requirement has been approved.
- **Acceptance criteria with test evidence:**
  - `tests/e2e/a11y.spec.ts` (6, new): axe-core WCAG 2.2 A/AA with **0 violations**. It covers the public pages and every chat surface in light and dark: the command list, math/code, a long chat, the row menu, search, the account menu, each Settings tab, the nested confirm, the image viewer, the phone drawer and the admin panel. The baseline run found the contrast and scroll-focus defects above.
  - `tests/e2e/primitives.spec.ts` (6, new):
    - Keyboard-only menu (first item focused, typeahead) → dialog (focus trap) → focus return, with ARIA snapshots as the screen-reader smoke.
    - Nested dialogs: Escape closes the inner one first; focus returns to "Delete all", then to the account trigger, and to the Search button.
    - Back with a dialog open leaves no `aria-hidden`/`inert`, focus guards, scroll lock or `pointer-events`.
    - Five open/close cycles leak no body children or window/document listeners (checked through CDP).
    - Reduced motion: no animations.
    - Latency is recorded.
  - `tests/client/composer.test.tsx` (7, new, INV-48):
    - IME via `isComposing` and via keyCode 229 (fails without the fix).
    - Double Enter, double click, and attachment-only double Enter each send once.
    - Paste text vs files vs both.
    - The draft survives a model switch.
    - Focus stays in the composer and in a message control while tokens stream.
  - `tests/client/primitives.test.tsx` (+1): a dialog opened through `open` returns focus to its opener (fails on the Phase 14 code).
- **Measurements** (production build; `perf-trace` with 4× CPU, 1.6 Mb/s and 150 ms RTT, median of 5 runs):

  |                      | Phase 14  | Phase 15  |
  | -------------------- | --------- | --------- |
  | Composer interactive | 4,362 ms  | 4,277 ms  |
  | JS transferred       | 207,414 B | 207,434 B |
  | CSS transferred      | 5,042 B   | 5,086 B   |
  - Critical chat JS: 202,873 B gzip (+80 B).
  - Warm menu open: 14–26 ms.
  - Keystrokes: handler processing ≈ 0 ms. Event Timing durations (p50 56 ms, p95 72 ms) are headless-compositor presentation delay, identical on an empty chat, and below INP's 200 ms.

- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (49 files, 683 tests)
  - `build`: PASS
  - `verify`: PASS (93/93)
  - `test:e2e`: PASS (87/87)
  - `perf:check`: PASS (within the Phase 14 budget; not rebaselined)
  - `verify:compose`: not run here (no Docker/Podman); CI runs it.
- **Invariants:**
  - INV-47 → Radix wrappers plus `focus-return.ts`, native select, focusable scroll panes → `primitives.test.tsx`, `primitives.spec.ts`, `a11y.spec.ts`, `ui.spec.ts`, `mobile.spec.ts`.
  - INV-48 → `composing()`, paste rules, the `submit` guard → `composer.test.tsx`, `conversation-view.test.tsx`, `attachments.spec.ts`, `verify` INV-56.
- **Dependencies:** `@axe-core/playwright` 4.13.0 (dev): the standard axe-core integration for automated WCAG checks in Playwright.
- **Deviations / limitations / unverified:**
  - Screen-reader output was checked through Chromium's accessibility tree (ARIA snapshots), not with NVDA, JAWS or VoiceOver, which aren't available here.
  - Firefox and WebKit weren't run; the suite is Chromium-only as in earlier phases.
  - axe checks rules, not usability; the keyboard and focus tests cover behavior.
  - The UI chrome has no RTL locale.
- **Commit/tag:** `refactor(phase-15): accessible UI primitives and composer assurance` on `main`, tag `phase-15`, pushed to `origin`.

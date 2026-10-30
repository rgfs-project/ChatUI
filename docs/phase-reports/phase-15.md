## Phase 15 report

- **Plan:**
  - Package 15: audit every interactive primitive against the Phase 7 decision record and fix what the audit finds. Treat the composer as its own critical path (INV-47, INV-48). This is an audit and repair phase, not a migration.
  - From the roadmap (step 18 and §3a): pasting rich text as safe Markdown, the composer "Think" toggle, and microphone dictation. The "/" command menu was already done.
  - Method: inventory first, then measure with axe-core (WCAG 2.2 A/AA) and behaviour tests. Fix in place, keeping before/after bundle numbers.

- **Scope completed:**
  - **Audit:** `docs/primitives-audit.md` covers 14 surfaces with name/role, opening focus, keyboard, Escape/trap/return, portal and collisions, touch, RTL and tests. No primitive was replaced; reasons for each retained choice are written there.
  - **Defects fixed (8):**
    1. The composer textarea carried `aria-expanded` and `aria-haspopup`, which a `textbox` does not allow. It now uses `aria-controls` and `aria-activedescendant` only, and only while the slash list is open.
    2. The Account button's name did not contain its visible text. It now uses a visually hidden prefix instead of `aria-label`.
    3. The same problem on the profile photo button. Avatar initials are now drawn by CSS (`data-initials`).
    4. The image viewer's zoom button now has a name that includes its percentage.
    5. Overflowing code blocks became focusable, named regions (measured with a ResizeObserver, so blocks that fit add no tab stop).
    6. Nested dialogs: closing a confirmation over Settings lost focus. Controlled dialogs now record the opener in a layout effect and return focus to it.
    7. The system reduced-motion setting now also stops spinners and other fixed-duration animations.
    8. The search dialog's result-type tabs got the ARIA tabs keyboard model (roving tab stop, ←/→, `aria-controls`).
  - **Think toggle:**
    - A pill next to + with `aria-pressed`, on by default and kept for the tab. It is shown only for models with the `reasoning` capability.
    - `think` was added to the send and regenerate schemas and passes through the config, the generation manager and `ChatRequest`.
    - llama.cpp gets `chat_template_kwargs.enable_thinking` (UNVERIFIED, documented in `docs/provider-notes.md`). Models without reasoning never get it.
    - The payload hash includes `think` only when it is sent.
  - **Dictation** (`app/chat/dictation.ts`):
    - Uses browser speech recognition, shown only where it exists, as a toggle with `aria-pressed`.
    - Finished phrases are inserted at the caret. A refused microphone, silence and failures are explained.
    - The first use says that the browser may send the audio to its vendor.
  - **Rich paste** (`app/chat/html-to-markdown.ts`):
    - An inert DOMParser document is converted to Markdown: headings, emphasis (Google Docs styles included), safe links, nested and numbered lists, quotes, code fences, GFM tables. Text is escaped.
    - Scripts, styles, frames and unsafe links are dropped.
    - The result is inserted through the editing commands, so Undo works.
    - Plain or code-editor HTML and anything over 1 MB is left to the browser.
  - **Composer:** the native textarea is retained, and a rich editor is marked out of scope (no approved structured-input need).

- **Tests:**
  - `tests/e2e/a11y.spec.ts` (new, axe-core over every page and overlay):
    - chat, the long chat, Library, Profile, seven Settings sections;
    - login, register, status, three admin sections;
    - composer and chat menus, rename, the slash menu, search, confirmation, image viewer, source panel.
  - `tests/e2e/primitives.spec.ts` (new):
    - a modal's `aria-hidden` background and scroll lock, and no residue after closing;
    - a nested confirmation over Settings (focus trap, Escape closes one layer, focus returns inside);
    - Back and Forward on a URL overlay, and leaving from inside it;
    - repeated overlays leave no extra portals or live regions;
    - keyboard-only sidebar menu with typeahead;
    - keyboard-only search tabs;
    - reduced motion;
    - phone: menus stay inside 390 × 844.
  - `tests/e2e/composer.spec.ts` (new):
    - two Enters and a click in one task store one message (checked after reload);
    - focus stays in the composer through a streamed reply, and text typed meanwhile is kept;
    - rich paste becomes Markdown, a script in it never runs, and Undo removes it; plain text is not cancelled;
    - ARIA snapshot of the composer;
    - a real Chromium IME composition (CDP): the Enter that commits it does not send.
  - `tests/client/composer-extras.test.tsx` (new, 8):
    - the converter's structures, hostile input, Google Docs and code-editor input, and the size bound;
    - insertion at the caret;
    - Think shown only for reasoning models and carried by sends;
    - dictation support detection, insertion, the notice, and permission errors.
  - `tests/server/think.test.ts` (new, 3):
    - `enable_thinking` reaches the provider, and the reply's reasoning follows it;
    - a model without reasoning never gets the field;
    - schema validation.
  - Mock provider: honours `enable_thinking: false`.
  - Updated: the slash test asserts `aria-controls`; the viewer test matches the new zoom name.
- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (536)
  - `build`: PASS
  - `perf:check`: PASS
  - `verify`: PASS (81/81)
  - `test:e2e`: PASS (96/96)
  - `npm audit --omit=dev`: 0 vulnerabilities
  - `verify:compose`: CI
- **Budget:** re-recorded.
  - Chat JS: 251,076 → 253,853 B gzip (+1.1 %: converter, dictation, Think pill).
  - Chat CSS: 9,062 → 9,190 B.
  - Sign-in route: unchanged.
  - The converter stays in the critical chunk because a paste handler must decide synchronously whether to cancel the native paste.
- **Invariants:** INV-47 is implemented, with the Phase 15 audit done. INV-48 is implemented. Both rows in ARCHITECTURE are updated.
- **Deviations / limitations:**
  - Colour contrast is reported by axe but left to Phase 18 with the token review.
  - RTL is checked by code review (no RTL locale yet).
  - Screen readers are checked through the browser accessibility tree (ARIA snapshots). A manual NVDA/VoiceOver pass is listed for Phase 18.
  - Think's provider field is UNVERIFIED (no live server reachable). Dictation could not be exercised with real audio in CI and is tested with a recognition double.
- **New dev dependency:** `@axe-core/playwright` 4.14.0 (tests only).
- **Commit/tag:** `refactor(phase-15): accessible UI primitives and composer assurance`, tag `phase-15`, pushed to `main`.

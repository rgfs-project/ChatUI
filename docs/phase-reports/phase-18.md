## Phase 18 report

- **Plan:**
  - Package 18: tokens, typography, focus, motion, states and WCAG 2.2 AA in both themes, with streaming announcements.
  - Measure first: axe with colour contrast enabled across every screen and overlay, in light and dark. Then fix the tokens, not individual components.
  - No architecture, API or behaviour changes.

- **Findings and fixes:**

| Finding (axe or review)                                                                                                            | Ratio before         | Fix                                                      | After                  |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------- | ---------------------- |
| Light secondary text (sidebar labels, notes, time separators, disclaimer, code header, "Thought for …", suggestions, sign-in note) | 3.15:1               | `--text-secondary`/`--text-tertiary` `#6b6b6b`           | 5.2:1 (4.6:1 on hover) |
| Dark tertiary text on menus                                                                                                        | 4.14:1               | `#a0a0a0`                                                | 5.1:1                  |
| White on the danger button, dark theme                                                                                             | 2.76:1               | `--danger-fill` `#dc2626`                                | 4.8:1                  |
| Light focus ring, orange / green / yellow accents                                                                                  | 2.97 / 3.12 / 2.11:1 | Deeper `--focus` shades in light; bright accents in dark | ≥ 5:1                  |
| White icon on the yellow accent (send button)                                                                                      | 2.16:1               | `--accent-text` black for yellow                         | 9.7:1                  |
| Keyboard-highlighted menu items shown only by a subtle background                                                                  | ~1.1:1               | Focus ring on `:focus-visible`                           | ≥ 3:1                  |
| Composer, message editor and settings search: focus shown only by the caret                                                        | —                    | Frame border on `:focus-within` (≥ 5:1)                  | ✓                      |

- **Streaming announcements** (`app/chat/stream-announcer.tsx`):
  - One polite, visually hidden status region says "Assistant is responding", then "Response complete / stopped / failed / timed out / interrupted".
  - It never announces tokens and never takes focus.
- **Theme before paint:** already server-rendered from the appearance cookie, with no inline script (nothing needed in the CSP). Now tested with JavaScript disabled for both a saved theme and "System".
- **Typography and icons:**
  - The system UI and monospace stacks, with no webfont.
  - Lucide icons at 16 px (102 uses), 18 px (43) and 20 px (12), with smaller sizes only inside dense chips.
  - The prose column stays at the measured 48 rem (about 80–90 characters per line, matching the reference layout) rather than 65–75 ch. That is a deliberate deviation, kept for the measurement audit.
- **Tests:**
  - `tests/e2e/a11y.spec.ts` now scans with colour contrast in light and dark (10 tests). Overlay scans are scoped to the overlay, which took them from 40 s to 11 s.
  - `tests/e2e/polish.spec.ts` (new, 6):
    - announcements (start, end, failed, focus untouched);
    - CLS < 0.1 on the cold long chat and while streaming;
    - theme painted with JS disabled under the production CSP;
    - no font requests;
    - keyboard-only walkthrough of sign-in → send → file picker → Settings, and admin → Administration → sections, with a visible focus outline.
- **Changes to existing tests, all with roles and names unchanged:**
  - `measurements.json`: three colour values, for the contrast fixes.
  - `primitives.spec.ts`: the modal test checks that the composer and transcript are hidden. The dialog library deliberately keeps live regions (the new announcer) outside `aria-hidden`, so their container is no longer hidden as a whole.
  - `perf.spec.ts`: waits for the completion mark instead of reading it once. It was flaky under full-suite load.
- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (555)
  - `build`: PASS
  - `verify`: PASS (87/87)
  - `test:e2e`: PASS (114/114)
- **Budget:** re-recorded, chat JS 253,853 → 254,048 B (announcer), CSS 9,190 → 9,298 B (focus states).
- **Unresolved, listed explicitly:**
  - No screen reader is available in this environment. Streaming was reviewed through the accessibility tree and the live region's DOM (Playwright), not with NVDA, VoiceOver or Orca. A manual pass is recommended (SECURITY.md E2).
  - The prose line length is a design deviation (above).
- **Commit/tag:** `style(phase-18): visual language, typography, accessibility, focus states`, tag `phase-18`, pushed to `main`.

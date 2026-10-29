## Phase 14 report

Run order per `docs/ROADMAP.md` (Phase 14 moved before Phase 9; artifact cards come with 13c).

- **Scope completed:**
  - Math: KaTeX → MathML, Copy LaTeX, display/inline delimiters, dollar amounts kept as text.
  - Lazy syntax highlighting with token colours.
  - Table Copy (TSV) and Expand.
  - Read aloud.
  - A lazy-module loader.
  - Input-driven scroll intent.
- **Required tests:**
  - **XSS and links:** XSS URLs/HTML (existing), math injection (`\href`, `\url`), malformed LaTeX → inert source.
  - **MathML and source:** MathML with the TeX annotation; Copy LaTeX.
  - **Code:** unknown-language fallback; HTML in highlighted code stays text.
  - **Streaming:** partial fences, GFM and math.
  - **Lazy loading:** first-party lazy requests with no KaTeX fonts or CSS (E2E); the verify bundle check.
  - **Scroll and selection:** scroll pinned/unpinned while streaming a 200-message chat (E2E); no remount of unrelated messages (render probes).
  - **Read aloud:** absent without speech support.
- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (411)
  - `build`: PASS
  - `verify`: PASS (78/78)
  - `test:e2e`: PASS (41/41)
  - `npm audit`: 0 (an override makes `micromark-extension-math` use the project's KaTeX)
  - `verify:compose`: CI
- **Dependencies:**
  - `katex` 0.19.0: MathML rendering.
  - `remark-math` 6.0.0: math syntax for react-markdown.
  - `highlight.js` 11.12.0: read-only highlighting, lazily loaded.
- **Deviations / limitations / unverified items:**
  - Math is MathML-only (no KaTeX HTML layer). It renders in current Chrome, Firefox and Safari; very old browsers show it less polished.
  - No screen reader was run against the MathML.
  - Code download and an editable canvas are not built (optional or separately reviewed).
- **Commit/tag:** `feat(phase-14): safe math code and streaming answer rendering`, tag `phase-14` (local), pushed to `main`.

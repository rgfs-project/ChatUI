# duck.ai chat export: observed format

ChatUI's duck.ai importer (added at the owner's request alongside Phase 13e, contracts §12: an independently specified and tested adapter) relies only on what is recorded here. Everything else is **UNVERIFIED**.

## Provenance

- **Source:** the operator's own chat, saved from duck.ai's download option on 2026-09-30 as `duck.ai_2026-09-30_06-27-19.txt`.
- **Fixture:** `tests/fixtures/duckai/`, sanitized with `node scripts/sanitize-export.ts duckai …`.
  - Kept: the boilerplate first line, separators, prompt headings, the model heading, Markdown table separators and line structure.
  - Replaced: every other line, with filler.
  - Dates are shifted by 100 days.

## Layout (observed)

- The file is UTF-8 **with a byte-order mark**.
- **Line 1:** `This conversation was generated with Duck.ai (https://duck.ai) using <Vendor>'s <Model> Model. AI chats may display inaccurate or offensive information (see https://duckduckgo.com/duckai/privacy-terms for more info).`
- A blank line, then `====================`, then a blank line.
- Then one section per exchange, separated by a blank line, `--------------------`, and a blank line. Each section is:
  1. `User prompt <n> of <total> - <YYYY-MM-DD>, <h>:<mm>:<ss> <a.m.|p.m.>:`
  2. The prompt text (any lines).
  3. A blank line, then `<Model>:` (e.g. `Claude Haiku 4.5:`, the model named on line 1 without the vendor).
  4. The response in Markdown (any lines, including headings, lists, tables and `---` rules).

## Mapping

- One file becomes one conversation. Its id is derived from the file's SHA-256, so re-importing the same file finds it identical. The title is the first prompt's first line (up to 80 characters).
- Each section becomes a user block and an assistant block (`status: complete`, `model: <Model>`, `provider: duck.ai`).
- **Times have no time zone** in the export. The browser sends its IANA time zone with the upload, and the prompt times are converted from that zone to UTC. Without a zone they are read as UTC and the preview says so. Responses have no time of their own (none is invented).
- The prompt heading is recognised only in the exact form above, with `n` counting up to `total`. A section without a model heading is imported as an unanswered prompt, and the report says so.

## Not observed (UNVERIFIED)

Other languages or date formats, 24-hour times, several models in one chat, image prompts, and a prompt line that itself equals the model heading. An export whose first line doesn't match is refused.

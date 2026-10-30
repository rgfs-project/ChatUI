## Phase 12b report

- **Plan:** the roadmap's new phase, after uploads:
  - `/library` with list/grid, search, type filter, sort menu, "New" menu, per-file menu, upload, download and delete;
  - profile pictures cropped to a square, in five shapes;
  - `/profile` with counts, streaks, a year of activity and insights.

  Added mid-phase at the project owner's request: "Recents" became a button that folds the chat list.

- **Scope completed:**
  - **Library** (page route with its own JS and CSS chunk):
    - Search, filter (All/Images/Audio/Documents), sort (newest, oldest, name, largest) and view (list or grid) live in the URL.
    - The list shows the file's chat (a link) or "Library" / "Not sent"; the grid shows lazy image previews. Images open in the shared viewer.
    - The per-file menu has Open, Download, Go to chat and Delete (with confirmation).
    - "New" → Upload files saves to the Library (`?to=library`: kept, never expired, not attachable yet); "New" → New chat.
    - Usage is shown against the quota.
  - **Profile photo:** cropped in the browser (drag, wheel, zoom slider) to a 512 px JPEG and uploaded with `PUT /api/profile/photo`. The server streams it with a size limit and sniffs it (PNG, JPEG or WebP only), then serves it inline with nosniff and the sandbox CSP. It can be removed.
  - **Shapes:** circle, flower, rounded square, oval and cookie (SVG masks served same-origin). The profile is dehydrated with each document, so the sidebar avatar is server-rendered.
  - **Profile page:**
    - Chats, messages, current and longest streak, files.
    - 53 weeks of daily activity in the user's time zone (it opens at the newest weeks on phones).
    - Insights: busiest weekday and hour, most used model, average per active day.
    - Statistics are cached until the index changes.
  - **Sidebar:**
    - "Library" entry with a books icon.
    - "Profile" in the account menu.
    - "Recents" is a button (`aria-expanded`, chevron) that folds the list. The state is a cookie hint, so the server renders it the same way.
  - **Fix:** tooltips never open on phones. An invisible open tooltip swallowed the Escape meant for the drawer (found when the new sidebar rows moved the focus order).
- **Required tests:**
  - `tests/server/profile.test.ts` (5):
    - Statistics: streaks across time zones, a quiet today, the 53-week window, busiest hour, favourite model, time zone validation.
    - Photo: upload, serving headers, GIF/SVG/text refused, the 5 MB limit keeps the old photo with no temp files, shape, per-user isolation, removal.
    - Library: saved files outlive the pending TTL, can be deleted, and can't be sent (409).
  - `tests/e2e/library.spec.ts`:
    - Library upload, search, filter, sort, grid view persisting through reload, viewer, delete with confirmation.
    - A chat file links to its chat and can't be deleted alone.
    - Profile crop, drag and upload (512 px); shape; server-rendered photo and shape in the next document; removal.
  - `tests/e2e/chat-ui.spec.ts`: Recents folds the list; server-rendered folded state across reload; keyboard menu order.
  - `tests/e2e/mobile.spec.ts`: the Library toolbar fits at 390 px with 44 × 44 targets in the header; activity scrolled to the newest weeks; drawer Escape.
- **Quality gates:**
  - `format:check`, `lint`, `typecheck`: PASS
  - `test`: PASS (459)
  - `build`: PASS
  - `perf:check`: PASS
  - `verify`: PASS (81/81)
  - `test:e2e`: PASS (57/57)
  - `npm audit`: 0
  - `verify:compose`: CI
- **Budget:** re-recorded:
  - chat JS 236,930 → 239,539 B (avatar, Recents toggle, sidebar entries)
  - CSS 7,716 → 7,960 B
  - sign-in JS 129,472 → 129,601 B

  The Library (3.9 KB JS / 1.0 KB CSS gzip) and Profile (4.2 KB / 0.9 KB) chunks load on demand. A first build pulled zod into the Profile chunk through the shape list; it moved to `shared/photo-shapes.ts`.

- **Invariants:** none new. Uploads keep INV-27/28/62; the photo follows the same sniffing and serving rules.
- **Dependencies:** none new.
- **Deviations / limitations:**
  - Library files can't be attached to a message yet.
  - A file that belongs to a chat is deleted with its chat, not on its own (contracts §7: a message never loses a referenced file).
  - The profile photo doesn't count toward the file quota (5 MB cap).
  - Statistics read every conversation on a cache miss (fine at single-user scale).
- **Commit/tag:** `feat(phase-12b): Library, profile photos and shapes, profile page with activity`, tag `phase-12b` (local), pushed to `main`.

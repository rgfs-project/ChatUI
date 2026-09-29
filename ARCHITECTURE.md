# ChatUI architecture

ChatUI is a self-hosted AI chat frontend. This document records the architecture **as implemented**, phase by phase. Sections for later phases are present but marked "N/A until Phase N". The invariant register at the end maps every invariant to the code that enforces it and the test that fails when it breaks.

Guiding principle: the workspace belongs to the user; the model provider is replaceable; Markdown is canonical; generation is server-owned; the browser is not trusted; `data/` is the persistent boundary; the critical UI path is composer-first.

## Runtime and toolchain (Phase 1a)

| Component                       | Version                           | Notes                                                           |
| ------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| Node.js                         | 24.21.0 LTS (`.nvmrc`, `engines`) | Runs `server/main.ts` directly via built-in type stripping      |
| React / React DOM               | 19.3.0                            |                                                                 |
| React Router (Framework Mode)   | 8.4.0                             | `ssr: true`. v8 is the current major; see "Deviations"          |
| Vite                            | 8.3.1                             | Rolldown-based; builds both the browser and SSR bundles         |
| Express                         | 5.2.1                             | Native async error handling                                     |
| TypeScript                      | 6.0.3                             | Newest version supported by typescript-eslint (TS 7 is not yet) |
| Zod                             | 4.6.5                             | Request and response DTO schemas (server only)                  |
| pino / pino-http                | 10.3.1 / 11.0.0                   | Structured logs with redaction                                  |
| helmet                          | 8.3.0                             | Security headers; CSP directives are ours                       |
| ESLint / Prettier               | 10.11 / 3.9                       | Flat config, `strictTypeChecked`                                |
| Vitest / Supertest / Playwright | 5.0 / 7.3 / 1.63                  | Playwright drives the `verify` hydration checks                 |

All versions are pinned exactly in `package.json` and locked in `package-lock.json`.

## Rendering model: SSR from the first commit

- React Router Framework Mode with runtime SSR (`react-router.config.ts`: `ssr: true`). There is no CSR stage, SPA fallback or planned migration.
- `app/entry.server.tsx` streams the document with `renderToPipeableStream`, threading the per-response CSP nonce into both `<ServerRouter nonce>` and the React stream options, so `<Scripts>`, `<ScrollRestoration>` and the hydration payload all carry it.
- `app/entry.client.tsx` hydrates the whole document with `<HydratedRouter>` in Strict Mode.
- The public status page (`app/routes/home.tsx`) renders the server health result into the HTML. Its loader calls the internal health service through the per-request router context and never makes an HTTP call back to its own server.
- Hydration safety: `useHydrated()` (`useSyncExternalStore`) returns `false` on the server and during hydration and `true` afterwards, so the first client render matches the server HTML. `<Links nonce="">` prevents a nonce hydration mismatch, because browsers hide nonce values from the DOM and stylesheets don't need a nonce under `style-src 'self'`.
- The theme follows `prefers-color-scheme` in CSS only, with no theme bootstrap script, so hydration cannot change it.

## Process and module layout

```text
server/main.ts          process entry (Node type stripping; no build step)
  ├─ production/test:   import build/server/index.js  (Vite SSR bundle of server/app.ts)
  └─ development:       Vite middleware mode + ssrLoadModule("server/app.ts") with HMR
server/app.ts           SSR bundle entry: createApp + React Router request handler factory
server/create-app.ts    the single Express app (ordering below)
server/config.ts        environment validation (fails fast)
server/logger.ts        pino logger + redaction list
server/csp.ts           per-response nonce + helmet CSP
server/errors.ts        AppError, error mapping, API 404
server/validation.ts    strict request parsing
server/registry.ts      declarative API route registry
server/routes/          route definitions (health)
server/services/        internal services shared by API routes and document loaders
server/storage/         canonical Markdown, paths, durable fs, locks, index, operation records, recovery (Node-native)
server/chat/            send acceptance, prompt assembly, token counting
server/generations/     model catalog, generation manager, SSE writer
server/providers/       llama.cpp provider
app/                    React Router route modules and entries
shared/                 types/schemas shared by client and server (`@shared/*`)
```

`server/main.ts`, `server/config.ts` and `server/logger.ts` are loaded natively by Node, so they use explicit `.ts` import specifiers and no path aliases. Everything else is bundled by Vite.

In development the server runs with `--conditions=development` so Node-loaded packages (for example `@react-router/express`) and Vite-loaded modules resolve the same React Router build. Without that flag there would be two `RouterContextProvider` classes.

## HTTP boundary (INV-57)

Express middleware order in `server/create-app.ts`:

1. Request logging (method, path without query string, status only).
2. Security headers: a fresh 128-bit nonce, then helmet with our CSP.
3. `/assets/*`: immutable hashed files (`Cache-Control: public, max-age=31536000, immutable`). Anything missing is a JSON `404 NOT_FOUND` and never reaches the document handler.
4. `/api/*`: JSON body parser (256 KB limit), registry routes, JSON `404 NOT_FOUND`, API error handler.
5. Other static files from `build/client` (e.g. `favicon.svg`, `max-age=3600`, no directory index).
6. React Router document handler for every remaining request. Real statuses: an unknown document URL renders the root `ErrorBoundary` with HTTP 404. Documents send `Cache-Control: no-store`.

## API conventions (contracts §5)

- **Route registry** (`server/registry.ts`): each route declares method, `/api/...` path, auth policy (`public` only until Phase 4), CSRF policy (`none` until Phase 4), strict request schemas, a response DTO schema, handler and a test fixture. `buildApiRouter` is the only code that registers API routes. ESLint (`eslint.route-inventory.js`) rejects literal-path `app.get("/…")`-style registrations anywhere else in `server/`, and `tests/server/registry.test.ts` exercises every route's fixture against its DTO.
- **Request validation** (`server/validation.ts`): params, query and body are validated with strict Zod objects that reject unknown fields. A part without a schema must be empty.
- **Response DTOs**: handler output is parsed through the route's strict response schema. Extra fields (e.g. a leaked internal record field) fail the request as `INTERNAL` instead of reaching the client.
- **Errors** (`shared/errors.ts`, `server/errors.ts`): `{ "error": { "code", "message", "details?" } }`. Phase 1a codes: `VALIDATION` 400, `NOT_FOUND` 404, `PAYLOAD_TOO_LARGE` 413, `INTERNAL` 500. Phase 5 adds `PROVIDER_NOT_FOUND` 400. Phase 2 codes: `PROVIDER_UNAVAILABLE` 502, `PROVIDER_ERROR` 502, `PROVIDER_TIMEOUT` 504, `MODEL_NOT_FOUND` 400, `GENERATION_NOT_FOUND` 404, `RATE_LIMITED` 429 (with `Retry-After`; `AppError` can carry response headers). Phase 3 codes: `CONVERSATION_MALFORMED` 422, `GENERATION_IN_PROGRESS` 409, `CONTEXT_TOO_LARGE` 422, `OPERATION_KEY_MISMATCH` 409, `OPERATION_EXPIRED` 409, `CONFLICT` 409. Body-parser failures are mapped explicitly. Any other throw is logged server-side and returned as `INTERNAL` with a generic message.

## Content-Security-Policy (contracts §9.2b)

Production and test policy (`server/csp.ts`):

```text
default-src 'self'; script-src 'self' 'nonce-<fresh per response>'; script-src-attr 'none';
style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self';
worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'
```

No `unsafe-inline` or `unsafe-eval`. Development only adds `style-src 'unsafe-inline'` (Vite-injected styles) and `connect-src ws://localhost:* ws://127.0.0.1:*` (HMR). Other headers: `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, COOP/CORP `same-origin`. HSTS is left to the TLS-terminating proxy deployment introduced with authentication (Phase 4).

## Network boundary and cookie transport (contracts §6, §9.2b)

- Exactly two transports (`server/config.ts`, `PUBLIC_ORIGIN`):
  1. `http://localhost` / `http://127.0.0.1` for the host machine only.
  2. An `https://` origin behind a TLS-terminating proxy.
- Any other `http://` origin fails at startup; there is no insecure-LAN mode. Cookies are `Secure` exactly when the origin is https, and the protocol is never inferred from `X-Forwarded-Proto`. `TRUST_PROXY` (hop count) only affects the client address used for rate limiting.
- **Host, http origin:** `LISTEN_HOST` must be loopback, and `server/create-app.ts` drops non-loopback **socket** peers (`server/loopback.ts`). Forwarded headers are never consulted.
- **Host, https origin:** the process may listen more widely because the TLS proxy is the entry point.
- **Container:** listens on its own interface (`CHATUI_CONTAINER=1`); `compose.yaml` publishes only `127.0.0.1:${HOST_PORT}:3000`. LAN and phone access go through a TLS proxy (README: Caddy, Tailscale HTTPS).

## Provider and server-owned generations (Phase 2)

### Provider (`server/providers/`)

- `Provider` exposes exactly what generation needs: `listModels`, `discoverSlots` and `streamChat(request, signal)`; aborting the signal cancels the upstream request. `llamacpp.ts` implements it for an OpenAI-compatible `llama-server`, following the behaviour recorded in [docs/provider-notes.md](docs/provider-notes.md) by `scripts/probe-provider.ts`.
- Server-side only. `LLAMA_API_KEY` is sent only to the provider. Clients receive ChatUI DTOs and ChatUI-authored messages, never provider payloads, ids, command lines, paths or error bodies (INV-04). Failures are normalized to `PROVIDER_UNAVAILABLE` (unreachable), `PROVIDER_ERROR` (HTTP error, invalid/early-ended stream, oversize, auth, context overflow) or `PROVIDER_TIMEOUT`.
- `PROVIDER_TIMEOUT_MS` is an **inactivity** timeout per request, re-armed on every received chunk. Responses are capped at `PROVIDER_MAX_RESPONSE_BYTES`.
- `ModelCatalog` (`server/generations/catalog.ts`) caches discovery for 30 s. Every generation's model must resolve against it; a miss refreshes once, then fails with `MODEL_NOT_FOUND` before anything starts.

### Generation lifecycle (`server/generations/manager.ts`)

```text
POST /api/generations ──► admission ──► model resolve ──► admission ──► 202 {generationId, assistantMessageId}
                                                                          │
               pending ──(provider headers / first chunk)──► streaming ──┤
                  │                                                       ├─► completed  (stream ended with [DONE])
                  └──────────────────────────────────────────────────────┼─► cancelled  (POST …/cancel)
                                                                          ├─► failed     (provider error, shutdown)
                                                                          └─► timed_out  (inactivity or GENERATION_MAX_MS)
```

- **Exactly one terminal state (INV-05).** `finish()` is the single guarded transition: the first caller wins, later calls are no-ops, and late provider chunks are dropped. Cancel, max-time and shutdown record their terminal state immediately and abort the provider request, without waiting for the provider to react. `tests/server/manager.test.ts` races cancel against completion.
- **Server-owned (INV-06).** The generation runs in the server process independently of any observer. Closing an SSE connection only unsubscribes that observer. Reloading `/chat?g=<id>` re-observes the same generation.
- Content and reasoning (`reasoning_content`) are kept separate in state, events and UI.
- **In memory only** in Phase 2: terminal generations are evicted after 10 minutes, and at most 200 are retained (oldest first). Persistence arrives in Phase 3.
- **Admission (INV-62, Phase 2 portion):** a global `MAX_ACTIVE_GENERATIONS` (default: `/props` `total_slots`, else 1) is checked before any work and again after model validation, with the slot reserved in between. Excess starts get `429 RATE_LIMITED` with `Retry-After`. Per-user (Phase 4), per-provider (Phase 5) and upload (Phase 12) limits come later.
- On shutdown the manager stops admitting, fails active generations ("server shut down") and closes all observers, so `server.close()` is not held open by long-lived streams.

### SSE conventions (`server/generations/sse.ts`, contracts §5)

- `GET /api/generations/:id/stream`: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, never compressed, `: ping` heartbeat every 15 s.
- Events, each with a per-generation monotonically increasing `id`:
  - `snapshot`: the full current state. Always first; its `id` is the last applied event.
  - `state`: `pending → streaming`.
  - `delta`: `{content}` or `{reasoning}`.
  - `terminal`: `{state, finishReason, error}`. The stream ends after it.
    A reconnect (or `EventSource` auto-reconnect) gets a fresh snapshot and then live events. Replay by `Last-Event-ID` is Phase 6.
- **Bounded observers (INV-62):** each connection writes without blocking the generation. While the socket is backpressured, events queue up to 1 MiB; a slower observer is disconnected and can resync from a snapshot.
- Unknown ids fail with a JSON `GENERATION_NOT_FOUND` before any stream bytes. Route validation runs through the registry like every other route (`defineSseRoute`).

### Chat UI

- `/chat` (`app/routes/chat.tsx`) server-renders the shell, model `<select>` and a native `<textarea>`, which are usable before JavaScript. Both controls are uncontrolled, so text typed before hydration survives it (checked by `verify`). Send stays `disabled` until hydration: there is no no-JS send path.
- The loader resolves models (2.5 s budget, then renders without them and offers Refresh) and the requested conversation concurrently. The page streams with `EventSource` and shows reasoning in a collapsed `<details>`.
- Since Phase 4 every chat route requires a session (see Authentication); Phases 2–3 exposed a loopback-only pre-auth demo.

## Providers, models and SSRF (Phase 5)

### Provider configuration (`server/providers/config.ts`)

- `DATA_DIR/_system/providers.json` (`0600`, holds secrets) is the authoritative list: `{ version: 1, providers: [{ id, name, kind: "openai-compatible", baseUrl, apiKey?, timeoutMs?, maxActiveGenerations?, capabilities: { inputModalities, reasoning, tools }, contextTokens? }] }`.
- When the file is missing, it is bootstrapped once with a `local` provider from `LLAMA_BASE_URL` / `LLAMA_API_KEY` (preserving Phase 2–4 behaviour).
- Each entry is validated independently (schema, duplicate id, SSRF URL check); an invalid entry is disabled, logged and listed as `invalid`. A broken file disables all providers but never crashes startup.
- Every valid entry becomes a `Provider` (`server/providers/llamacpp.ts` for `openai-compatible`) whose outbound requests go through the SSRF-safe fetch. `createApp({ providerFactory })` lets tests plug in other implementations; the in-memory provider in `tests/server/providers.test.ts` proves the abstraction.

### Models (`server/generations/catalog.ts`, INV-18)

- The model key is `(providerId, modelId)`; ids are opaque and never parsed.
- **Cache per provider:** a TTL of 30 s with stale-while-revalidate. A fresh list is served; an expired list is served while a background refresh runs; a provider without a list is awaited. `?refresh=1` forces a refresh.
- **Failure policy:** only a successful response replaces a list. A failed refresh keeps the last good list with `stale: true` (provider status `stale`). A provider that never answered is `unavailable` with no models. Discovery starts at startup without blocking it (`warmUp`).
- **Validation:** `POST /api/generations` requires `providerId` + `model`. `SendService` resolves the pair against the server-side cache, refreshing that provider once on a miss, before any mutation. The outcomes are `PROVIDER_NOT_FOUND` (unknown, removed or invalid provider), `MODEL_NOT_FOUND`, or `PROVIDER_UNAVAILABLE` (never reached). The browser's pair is untrusted.
- **Capabilities** use one typed schema for config and model metadata (`inputModalities`, `reasoning`, `tools`) with provenance (`capabilitySources`). Input modalities come from discovery when the provider reports them (llama.cpp router `architecture.input_modalities`, docs/provider-notes.md), else from config. Reasoning and tools come from config. Text is always included; unverified optional capabilities are false. Tool support is only reported until Phase 13b.
- **Admission (contracts §4):** each provider has a limit: `maxActiveGenerations`, else its discovered slots (`/props total_slots` after the first successful discovery), else 1. A saturated provider rejects only its own starts (`429`). The global cap is `MAX_ACTIVE_GENERATIONS` when set, else the sum of provider limits. Per-user limits still apply.
- **Conversations stay provider-independent:** assistant blocks record `provider` (the provider id) and `model` as informational attributes. Switching provider mid-conversation sends the same canonical history. Removing a provider never touches files; its old replies keep their labels.
- **API:** `GET /api/providers` returns `{id, name, status, capabilities}` (never `baseUrl` or `apiKey`). `GET /api/models` returns models grouped by provider with `stale` flags. The chat UI groups the selector by provider (`<optgroup>` with stale/unavailable labels) and preselects the conversation's last provider/model.

### SSRF policy (`server/providers/ssrf.ts`, INV-19)

- **URL checks** (at config load, on every request, and on future admin edits):
  - http/https only
  - no credentials, fragment or query in a base URL
  - optional `PROVIDER_HOST_ALLOWLIST` (exact hostnames)
- **Address checks** (`ipaddr.js`, IPv4-mapped IPv6 normalized first):
  - Cloud metadata endpoints are **always** denied, even when allowlisted or listed as exceptions: `169.254.169.254`, `169.254.170.2`, `169.254.170.23`, `fd00:ec2::254`, `fd00:ec2::23`, `100.100.100.200`, `192.0.0.192`.
  - Link-local is denied except exact `PROVIDER_LINK_LOCAL_EXCEPTIONS` tuples `(hostname, address, port)` for a verified container gateway (no wildcards or CIDRs).
  - Loopback, RFC 1918, unique-local and CGNAT are allowed only with `ALLOW_PRIVATE_PROVIDER_HOSTS=true` (the default: local llama.cpp is the primary use case).
  - Unspecified, multicast, broadcast and reserved addresses are denied.
- **Request time:** each request resolves the hostname, checks **every** resolved address and connects to the checked address through an undici `Agent` whose `lookup` returns only that address (so DNS rebinding cannot swap it). TLS still verifies the hostname's certificate. `redirect: "manual"`: any 3xx is refused.
- A refused destination surfaces as a normalized `PROVIDER_ERROR` ("not allowed by the server's network policy") or as the provider being unavailable. It never reveals the resolved address.

## Persistence (Phase 3)

### Storage layout and identity

```text
DATA_DIR/
├── .gitkeep
└── <user-id>/                        # one directory per account (user.json since Phase 4)
    ├── chats/<conversation-id>.md    # CANONICAL, formatVersion 1
    ├── operations/<sha256>.json      # send-acceptance records (recovery state)
    └── index/chats.json (+ chats.dirty while a mutation is in flight)   # DERIVED
```

- **Identity (INV-14):** since Phase 4 the user directory segment comes only from the authenticated session (`userOf(ctx).userId`); Phase 3 used a configured `LOCAL_USER_ID`.
- **Paths (INV-12):** `server/storage/paths.ts` is the only place paths are built. It accepts canonical lowercase UUIDs, known file names and server-computed SHA-256 hex, and asserts that every resolved path stays inside `DATA_DIR`. Route schemas use `canonicalUuid` (`shared/ids.ts`), so a malformed id is a 400 before any filesystem access.
- **Durable writes (`server/storage/fs.ts`):** temp file `.<name>.<16hex>.tmp` in the same directory → fsync → rename → directory fsync. Files are `0600`, directories `0700`. Startup removes only pattern-matching temp files older than the process start. Windows lacks directory fsync (documented; Linux containers are the supported runtime).
- **Locks (`server/storage/locks.ts`):** in-process FIFO keyed mutexes: one per conversation, plus the per-user index persistence queue (last in the global lock order). Every canonical mutation, including delete, holds the conversation lock. No network I/O happens under a lock; generation work is launched only after the acceptance lock is released (a test wraps the provider and asserts `heldLocks === 0`). Single process only.
- **Startup recovery (`server/storage/recovery.ts`, contracts §2, Phase 3 steps):**
  1. temp files
  2. unexpected top-level entries are logged, never deleted
  3. pending operation records resolved by hash (step 4 of §2)
  4. expired committed records removed
  5. derived index loaded, rebuilt or reconciled (step 8 of §2)

  `createApp().ready` resolves before `server/main.ts` listens. It then rebuilds the username index and sweeps expired sessions. Only account directories (with `user.json`) are processed.

### Canonical Markdown (`server/storage/markdown.ts`, INV-09)

- A strict parser and pure serializer for contracts §3:
  - YAML 1.2 core-schema front matter (exactly four keys in order, integer `formatVersion: 1`, 1–200 code-point titles without line breaks, canonical UTC timestamps)
  - the full delimiter grammar via a tokenizer (BARE/QUOTED JSON values, per-type attribute table, canonical lowercase unique ids, `attachments` and `time` quoted only)
  - reasoning immediately followed by its assistant
  - body escaping, BOM/CRLF handling, and a lone CR kept as content
- `parseConversation` returns `ok | malformed(reason, line)` and never throws for content. Filesystem errors are separate.
- The serializer emits canonical attribute order and JSON-escaped quoted values (with `<`, `>`, `&` and YAML-unsafe characters escaped), and ends the file with exactly one LF. `normalizeBody` maps external text into the round-trip domain. Property tests (fast-check, 400 runs each) prove `parse(serialize(x)) = x`, idempotent re-serialization, normalization of CRLF/blank-edge inputs, and no throws on arbitrary input.
- `writeUnlocked` re-parses the serialized text before writing and refuses to write an invalid model.

### Conversations and the derived index (INV-10, INV-11)

- `ConversationStore` (`server/storage/conversations.ts`) implements create, get, rename (optional `expectedRevision` → `CONFLICT`) and delete (Markdown under the lock, then the index entry). `createdAt` is immutable. `updatedAt` is set by storage on every mutation, and the schemas reject client-supplied timestamps. The §3.3 auto-title (first surviving user block, one line, 60 code points at a word boundary) is applied whenever a `complete` assistant block is written while the title is exactly `New conversation`.
- **Revision** = SHA-256 of the file bytes. It is returned in the conversation DTO, the rename response, and the terminal SSE event/snapshot (computed after the assistant write and auto-title).
- **Malformed files (INV-10)** are listed with `malformed: true`. GET, PATCH and send return `422 CONVERSATION_MALFORMED`, DELETE works, and bytes are never rewritten. They never affect other conversations.
- **Index (`server/storage/chat-index.ts`):** entries `{id, title, createdAt, updatedAt, messageCount, malformed}` plus the file's size and mtime (not exposed).
  - `mutate()` writes `chats.dirty` before the canonical write and removes it after persisting the index with no other mutation pending.
  - At startup a missing, unparseable or dirty index is rebuilt. Otherwise it is **reconciled**: files whose size/mtime changed, new files and removed files are re-derived, so hand edits appear after a restart.
  - `npm run index:rebuild` (`node server/cli.ts index:rebuild`) rebuilds offline.

### Send acceptance (`server/chat/send-service.ts`, contracts §4.1, INV-08, INV-13, INV-58, INV-60)

`POST /api/generations {conversationId?, model, content, operationKey, operationIssuedAt}`:

1. **Operation key first.**
   - A known record with the same payload hash (conversationId, model, normalized content) returns its original `202`, even while that generation runs.
   - A known record with a different payload → `409 OPERATION_KEY_MISMATCH`.
   - An unknown key with `operationIssuedAt` older than retention − 1 day, or more than 1 day in the future → `409 OPERATION_EXPIRED`.
   - Same-key requests in flight are serialized (the later one waits and re-reads the record).
2. Cheap checks: admission (`429`), active run (`409 GENERATION_IN_PROGRESS`), model (`MODEL_NOT_FOUND`). Then a snapshot under a short lock (`NOT_FOUND`, `CONVERSATION_MALFORMED`).
3. **Unlocked preflight:** prompt assembly and the context budget (`422 CONTEXT_TOO_LARGE`).
4. **Under the lock:**
   - recheck the revision (one recompute, then `409 CONFLICT`) and the key
   - reserve the slot
   - write the operation record `pending` with before/after hashes
   - atomic user-block write (a new conversation and its first user block are one file creation)
   - mark the record `committed`
5. Release the lock, launch the generation, return `202 {conversationId, generationId, userMessageId, assistantMessageId}`.

- Every failure from step 4 on is `INTERNAL`. The pending record is then decided in-process by hashes (like startup recovery), so a retry with the same key gets a definite answer.
- `GET /api/operations/:operationKey` returns a committed result or 404.
- Rejected first sends create nothing: no conversation, no record.
- A committed send whose generation never launched (a crash between commit and launch) leaves the user block unanswered until Phase 6 adds generation recovery.
- **Terminal write (INV-07):** under the conversation lock the terminal sequence appends the reasoning block (if non-empty) and the assistant block exactly once. The block carries `status` (`complete`/`cancelled`/`failed`/`timed_out`), `provider="local"`, `model` and the terminal `time`. The write is idempotent by assistant id. A deleted conversation discards the write (logged, never recreated) and marks the record `terminalWritten`. The manager decides the terminal state first (INV-05 guard), persists, and only then publishes the terminal state and event with the new revision.
- **One active generation per conversation (INV-13)** is tracked by the manager (reservations included).

### Prompt assembly (`server/chat/prompt.ts`, contracts §4)

- The prompt is built from canonical storage only:
  - all system blocks first, in file order
  - user/assistant bodies in order; reasoning is never sent and empty assistant bodies are skipped
  - leading assistant history without a user turn is dropped
  - adjacent same-role messages are merged with a blank line (provider prompt only)
- **Budget** = model context − `MAX_OUTPUT_TOKENS`. `ProviderTokenCounter` counts group costs with llama-server `/tokenize` (cached by content) and verifies the **formatted** prompt with `/apply-template` + `/tokenize`. If tokenization is unavailable, `estimateCounter` uses 1 token per UTF-8 byte plus `TEMPLATE_OVERHEAD_TOKENS` per message; this never under-counts the probe's real counts (tested).
- **Prefix-stable truncation:** history groups (user + its responses), earliest fitting start `s`, and anchors where cumulative earlier-history tokens first reach each multiple of `CONTEXT_TRIM_STEP` (default 25% of the budget). The window starts at the first anchor ≥ `s` before the newest group, else at `s`. Tests show the window start and prompt prefix stay fixed across turns until history grows by about K. If the formatted count still exceeds the budget, the window moves to the next anchor. Volatile time values: none exist before Phase 10.

### UI

`/chat` has a conversation list, a new chat, open via `?c=<id>` (SSR transcript before JS), rename, delete and send. A send carries a fresh operation key and resends with the same key on network errors or `INTERNAL` (bounded), then reports an unknown outcome. The running generation comes from the conversation DTO's `activeGeneration`, so reloads re-observe it. Layout work is Phase 7.

## Authentication and authorization (Phase 4)

### Accounts (`server/storage/users.ts`, contracts §6)

- `DATA_DIR/<user-id>/user.json` is the canonical account: `{id, username, role, status, passwordHash, createdAt, updatedAt}`.
  - `passwordHash` never leaves the storage layer (`publicUser`), and no DTO carries it (tested).
  - Usernames are 3–32 characters of `[a-z0-9_.-]`, stored lowercase and unique case-insensitively, enforced under the registry lock (a concurrent registration test).
  - `_system/users.index.json` is a derived username map, rebuilt at startup and on a lookup miss (so accounts created by the CLI while the server runs work).
- Creating an account is the only operation that creates a user root directory. Startup recovery and every writer touch only directories that hold a `user.json`, so a leftover pre-auth demo directory is never read or modified (tested).
- **Passwords:** Argon2id via `argon2` with OWASP parameters (19 MiB, t=2, p=1), 10–256 characters. `PasswordHasher` bounds concurrency (`PASSWORD_HASH_CONCURRENCY`) with a bounded wait queue (`PASSWORD_HASH_QUEUE`); a full queue returns `429 RATE_LIMITED` (INV-62). Unknown users are verified against a dummy hash, so timing and error text are uniform.
- **First admin:** `npm run user:create -- --username <name> --admin` (or `node server/cli.ts user:create …` in the container). The password comes from a no-echo prompt or piped stdin; any `--password` argument is refused. `REGISTRATION_MODE=closed` (default) makes `POST /api/auth/register` return `403 REGISTRATION_CLOSED`.

### Sessions (`server/auth/sessions.ts`)

- A random 256-bit token lives in an `HttpOnly`, `SameSite=Lax`, `Path=/` cookie, named `chatui_session` on http, or `__Host-chatui_session` + `Secure` on https.
- Only `SHA-256(token)` is stored, as `_system/sessions/<hash>.json`, together with the user id, the role at issue, the CSRF synchronizer token, `lastSeenAt` and `absoluteExpiresAt`.
- **Expiry:** absolute (`SESSION_ABSOLUTE_TTL`) and idle (`SESSION_IDLE_TTL`; the idle stamp is written at most once a minute). Expired sessions are removed on read and by the startup/hourly sweep.
- **Every authenticated request reloads `user.json`** (`AuthService.resolveHash`): a missing, non-active, or role-changed account revokes the session immediately (INV-17). Login always issues a fresh session and revokes the presented one (fixation).
- **Logout and password change:**
  - Logout revokes the session server-side and clears the cookie.
  - Password change requires the current password, revokes **all** of the user's sessions, clears the cookie and requires a new login.
- Login and registration are rate-limited in-process per client address and per username (10 per 15 min, `429` + `Retry-After`).

### Policies in the route registry (INV-15, INV-16)

- Each route declares `auth: "public" | "user"` and `csrf: "none" | "token" | "origin"`.
- `buildApiRouter` resolves the session and enforces the policy **before** validation and the handler:
  - `user` → `401 UNAUTHENTICATED`
  - `token` → `X-CSRF-Token` must equal the session's synchronizer token (timing-safe; `403 CSRF_INVALID`), and `X-Expected-User` must equal the session user (`409 SESSION_CHANGED`) — both before any mutation (INV-59)
  - `origin` (login/registration) → `Origin` equals `PUBLIC_ORIGIN`, or `Sec-Fetch-Site: same-origin`
- Public routes: health, session status, login, register. Tests enumerate the registry, so a new route can't miss a policy:
  - every protected route returns 401 signed out
  - every `token` route rejects a missing token, a wrong token and a stale expected user
  - no request schema has an identity field, and route files never read `req.headers/query/body/params`
- **Identity (INV-14)** comes only from the session: handlers use `userOf(ctx).userId`. Services take `userId` as a required argument, so ownership is enforced at the storage/service boundary. Another user's conversation, operation or generation is a `404` (INV-15). Generations record their owner; snapshot, cancel and stream check it.

### Streams and limits (INV-62)

- SSE connections are bound to the opening session: revocation (logout, password change, disable, role change) closes them immediately via `SessionStore.onRevoked` → `SseConnections.closeSession`, and each heartbeat re-validates the session (expiry). Closing a stream never affects the generation (INV-06, tested).
- Caps: `MAX_SSE_PER_USER` / `MAX_SSE_TOTAL` (`429` before any stream bytes); `MAX_ACTIVE_GENERATIONS_PER_USER` (default 2) next to the global limit.

### Browser (INV-59)

- The root loader renders a browser-safe `SessionDto` `{user, csrfToken, registrationOpen}` into private no-store HTML; the cookie and its hash never appear.
- `app/lib/api.ts` (`apiFetch`) attaches the CSRF token and expected user to mutations. On `CSRF_INVALID` it refetches `/api/auth/session` once and retries once **only** if the account is unchanged, the authentication epoch is unchanged and the request is still current. Otherwise it discards the request, dispatches `chatui:account-changed` (the chat page clears its draft and live view and goes to sign-in) and throws. `SESSION_CHANGED` is handled the same way. Unit tests cover the retry, discard, superseded and SESSION_CHANGED paths.
- Pages: `/login` (validated `returnTo`: only `/chat…` and `/account`; anything else → `/chat`), `/register` (404 when closed), `/account` (change password), and sign out in the chat sidebar.

### Authenticated SSR (INV-54, INV-55, INV-57)

- An Express middleware resolves the real session for **every document request** before the React Router handler; the result is passed per request through the router context (`appContext.auth`) and is never module-global.
- `/chat` and `/account` loaders redirect signed-out requests to `/login?returnTo=…` (302) before reading anything. `/chat?c=<id>` loads only the signed-in user's conversation; another user's id renders "does not exist" without metadata.
- All documents are `Cache-Control: private, no-store`.
- `verify` checks, on the production build:
  - the redirect and a validated open-redirect attempt
  - private documents
  - cross-user HTML and API isolation
  - 20 concurrent document requests alternating two identities (never mixed)
  - logout → 401, and a disabled account's session → 401

### Preferences (INV-34)

- `DATA_DIR/<user-id>/preferences.json` (`server/storage/preferences.ts`) holds `pins`, `defaultProvider`, `defaultModel`, `historyImages` and `imageMaxEdge`. `null` means unset, and an explicit `0` is kept.
- Missing or corrupt files degrade to defaults field by field. Writes are atomic and under a per-user lock, and they preserve unknown fields.
- It is canonical (not an index) and never touched by index rebuilds. API: `GET`/`PATCH /api/preferences`; UI forms come in later phases.

## Container runtime (Phase 1b, INV-49)

Compose is the supported production path; host Node is for development.

- **Image** (`Dockerfile`): a multi-stage build on `node:24.21.0-trixie-slim` pinned by digest. `deps` runs `npm ci`; `build` runs `npm run build` (SSR server bundle and browser bundle); `prod-deps` runs `npm ci --omit=dev`. The runtime stage contains only `package.json`, production `node_modules`, `build/`, and the natively loaded `server/{cli,main,config,logger,loopback}.ts`. The one Express process serves the API, SSR documents and immutable assets.
- **User and filesystem:** runs as `node` (UID 1000). Application files are root-owned. `/data` is created `0700` and owned by `node`. `compose.yaml` adds `read_only: true` (tmpfs `/tmp`), `cap_drop: [ALL]`, `no-new-privileges`, `init: true` (signal forwarding and zombie reaping) and `restart: unless-stopped`.
- **Persistence:** `/data` is a named volume (`CHATUI_VOLUME`, default `chatui-data`), independent of the container lifecycle. `verify:compose` writes a test sentinel as the app user, recreates the container and reads it back. The application itself still writes nothing.
- **Podman:** rootless Podman works with the same `compose.yaml` (named volumes are labeled automatically). `compose.podman.yaml` shows a bind-mounted `./data` with a private SELinux label (`:Z`) and `userns_mode: keep-id` so host files stay owned by the operator. `verify:compose` exercises the `:Z` bind mount when SELinux is enforcing and reports NOT RUN otherwise.
- **Healthcheck and entrypoint:** `ENTRYPOINT ["node", "server/cli.ts"]`, default `CMD ["serve"]`. The healthcheck runs `server/cli.ts healthcheck`, which requests `GET /api/health` inside the container. It is declared in both `compose.yaml` and the `Dockerfile`, because Podman/buildah OCI-format images drop `HEALTHCHECK`. Future operator commands (`index:rebuild`, `user:create`, `user:reset-password`, `backup`, `restore`) are listed with the phase that introduces them and exit 2 until then.
- **Secrets:** there are none yet. `.env` is git-ignored and never baked into the image (`.dockerignore`). No secrets appear as command arguments.
- **CI** (`.github/workflows/ci.yml`): on every push and PR it runs format:check, lint, typecheck, test, build, verify and `npm audit --audit-level=high`, plus `verify:compose` on Docker and on rootless Podman (podman-compose). Actions are pinned by commit SHA with `contents: read` only. Images are built but never published.

## Configuration

Validated once at boot (`server/config.ts`); invalid values stop the process with a list of every problem. See `.env.example`.

| Variable                                            | Default                         | Rule                                                                                          |
| --------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `PORT`                                              | `3000`                          | integer 0–65535 (0 = ephemeral)                                                               |
| `DATA_DIR`                                          | `./data` (`/data` in the image) | must be an existing directory; nothing writes to it yet                                       |
| `NODE_ENV`                                          | `development`                   | `development` \| `production` \| `test`                                                       |
| `LOG_LEVEL`                                         | `info`                          | pino levels or `silent`                                                                       |
| `LISTEN_HOST`                                       | `127.0.0.1`                     | IP address. It must be loopback unless `CHATUI_CONTAINER=1`, which only the image sets        |
| `LLAMA_BASE_URL`                                    | unset                           | http(s) URL without credentials, query or fragment; unset = chat demo shows "no model server" |
| `LLAMA_API_KEY`                                     | unset                           | secret; sent only to the provider                                                             |
| `PROVIDER_TIMEOUT_MS`                               | `300000`                        | inactivity timeout per provider request (1 s – 1 h)                                           |
| `GENERATION_MAX_MS`                                 | `1800000`                       | whole-generation cap                                                                          |
| `DEFAULT_CONTEXT_TOKENS`                            | `8192`                          | used when the provider reports no context length                                              |
| `MAX_OUTPUT_TOKENS`                                 | `4096`                          | `max_tokens` per generation                                                                   |
| `MAX_ACTIVE_GENERATIONS`                            | discovered slots, else 1        | global admission limit                                                                        |
| `PROVIDER_MAX_RESPONSE_BYTES`                       | `16777216`                      | per provider response                                                                         |
| `OPERATION_RETENTION_MS`                            | `604800000` (7 days)            | ≥ 2 days                                                                                      |
| `CONTEXT_TRIM_STEP`                                 | 25% of the budget               | truncation anchor step in tokens                                                              |
| `TEMPLATE_OVERHEAD_TOKENS`                          | `16`                            | per-message overhead for the fallback estimate                                                |
| `PUBLIC_ORIGIN`                                     | `http://localhost:<PORT>`       | https origin, or http://localhost / 127.0.0.1 / [::1] only                                    |
| `TRUST_PROXY`                                       | `0`                             | proxy hops trusted for the client address                                                     |
| `REGISTRATION_MODE`                                 | `closed`                        | `closed` \| `open`                                                                            |
| `SESSION_ABSOLUTE_TTL`                              | 30 days                         | ms                                                                                            |
| `SESSION_IDLE_TTL`                                  | 7 days                          | ms                                                                                            |
| `MAX_ACTIVE_GENERATIONS_PER_USER`                   | `2`                             | per-user admission                                                                            |
| `MAX_SSE_PER_USER` / `MAX_SSE_TOTAL`                | `8` / `256`                     | stream caps                                                                                   |
| `PASSWORD_HASH_CONCURRENCY` / `PASSWORD_HASH_QUEUE` | `2` / `16`                      | hashing semaphore and bounded queue                                                           |
| `ALLOW_PRIVATE_PROVIDER_HOSTS`                      | `true`                          | loopback/private/unique-local/CGNAT provider hosts                                            |
| `PROVIDER_HOST_ALLOWLIST`                           | empty                           | comma-separated exact hostnames                                                               |
| `PROVIDER_LINK_LOCAL_EXCEPTIONS`                    | empty                           | `host=address:port` tuples (IPv6 in brackets)                                                 |

## Logging

Structured JSON (pino). Redacted at the top level and one level down: `authorization`, `cookie`, `set-cookie`, `password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `api_key`, `secret`, `csrfToken`, `x-csrf-token`, `x-api-key`, plus request/response header paths. Request logs record only id, method, path (no query string) and status.

## Assets and caching

All runtime JS/CSS/icons are built into `build/client` and served from the ChatUI origin. There are no CDN dependencies or web fonts (system font stack), `assetsInlineLimit: 0` avoids `data:` URIs, and no service worker is registered.

## Later sections

- Server-owned generation and replayable SSE: N/A until Phase 6.
- Core chat UI, TanStack Query, primitives decision record: N/A until Phase 7.
- Loading resilience: N/A until Phase 8.
- Performance budgets and instrumentation: N/A until Phase 9.
- Admin, mobile, uploads, continuity, rendering, component audit, security hardening, reliability, polish: N/A until Phases 10–18.
- Interactive artifacts: optional Phase 19, separately approved.

## Deviations from the written specification

- **React Router 8.4 instead of 7.** The project owner asked for the latest dependencies. v8 is the direct successor with the same Framework Mode SSR, route modules and `@react-router/express` adapter. Its breaking changes (ESM-only packages, always-on middleware, `RouterContextProvider` for load context, Node ≥ 22.22, React ≥ 19.2.7) don't affect the required architecture.
- **Node 24 LTS instead of 22.x.** The spec allows a newer supported LTS; 24.21.0 is the current Active LTS.
- **TypeScript 6.0.3 instead of 7.0.** typescript-eslint (required for type-aware linting) supports `<6.1`.
- **Workflow.** The project owner authorized autonomous phase execution with commits pushed to `main` on GitHub. The spec's plan-approval pause and local-only commits don't apply to this repository.

## Invariant register

Tests name the invariant in their title (e.g. `INV-01: …`). "Pending" rows are enforced and tested once their phase is executed.

| ID     | Invariant                                                                                                                                                                                                                   | Phase          | Enforcement                                                                                                                                                                 | Tests                                                                                                                        | Status                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| INV-01 | Every API error uses the canonical error contract; unhandled errors become `INTERNAL` with no internals exposed                                                                                                             | 1a             | `server/errors.ts` (`apiErrorHandler`, `toAppError`), `server/create-app.ts` (API/asset 404s)                                                                               | `tests/server/errors.test.ts`, `scripts/verify.ts`                                                                           | Implemented (1a)                                                                             |
| INV-02 | Every request body is schema-validated and unknown fields are rejected                                                                                                                                                      | 1a             | `server/validation.ts` (`parseRequest`, strict schemas; omitted parts must be empty), `server/registry.ts`                                                                  | `tests/server/errors.test.ts` (request validation)                                                                           | Implemented (1a)                                                                             |
| INV-03 | Responses are explicit DTOs; no server-only secrets, credential hashes, paths, or upstream bodies in any response (browser CSRF token per §5 is allowed)                                                                    | 1a             | `server/registry.ts` parses every handler result through its strict response DTO schema; `shared/api.ts`                                                                    | `tests/server/errors.test.ts`, `tests/server/registry.test.ts`                                                               | Implemented (1a)                                                                             |
| INV-04 | Provider credentials and raw provider payloads never reach the browser                                                                                                                                                      | 2              | `server/providers/llamacpp.ts` (normalized `ProviderError`, own messages), `server/generations/catalog.ts` + `shared/generations.ts` DTOs                                   | `tests/server/generations.test.ts` (INV-04, discovery, failure cases)                                                        | Implemented (2)                                                                              |
| INV-05 | A generation reaches exactly one terminal state                                                                                                                                                                             | 2              | `GenerationManager.finish()` single guarded transition                                                                                                                      | `tests/server/manager.test.ts` (cancel/complete race), `tests/server/generations.test.ts`                                    | Implemented (2)                                                                              |
| INV-06 | Closing an SSE connection never cancels a generation                                                                                                                                                                        | 2              | `server/generations/sse.ts` (disconnect only unsubscribes), `GenerationManager.observe`                                                                                     | `tests/server/generations.test.ts` (disconnect/reconnect), `tests/server/manager.test.ts`, `scripts/verify.ts` (reload)      | Implemented (2)                                                                              |
| INV-07 | The assistant message is written to canonical storage exactly once per generation                                                                                                                                           | 3              | `SendService.persistOutcome` (idempotent by assistant id, under lock), `GenerationManager.finish` single decision                                                           | `tests/server/conversations.test.ts` (INV-08/INV-07), `tests/server/manager.test.ts` (race: one persisted outcome)           | Implemented (3)                                                                              |
| INV-08 | The user message is durable before `202` is returned                                                                                                                                                                        | 3              | `SendService.commit` (atomic write + committed record before return)                                                                                                        | `tests/server/conversations.test.ts` (file read right after 202)                                                             | Implemented (3)                                                                              |
| INV-09 | `formatVersion: 1` round-trips exactly (§3.6)                                                                                                                                                                               | 3              | `server/storage/markdown.ts`                                                                                                                                                | `tests/storage/markdown.test.ts` (examples + fast-check properties)                                                          | Implemented (3)                                                                              |
| INV-10 | Malformed conversations are never modified by the application and never break other conversations                                                                                                                           | 3              | `ConversationStore.get/rename`, `SendService.readExisting`, index `malformed` entries                                                                                       | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`, `scripts/verify.ts`                                   | Implemented (3)                                                                              |
| INV-11 | The index is derived: deleting it and restarting loses nothing                                                                                                                                                              | 3              | `ChatIndex` (rebuild, dirty marker, reconcile)                                                                                                                              | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`, `scripts/verify.ts`                                   | Implemented (3)                                                                              |
| INV-12 | No filesystem path contains request-controlled input; all paths stay inside `DATA_DIR`                                                                                                                                      | 3              | `server/storage/paths.ts`, `canonicalUuid` route schemas                                                                                                                    | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`                                                        | Implemented (3)                                                                              |
| INV-13 | At most one non-terminal generation per conversation                                                                                                                                                                        | 3              | `GenerationManager.reserve/assertIdle`                                                                                                                                      | `tests/server/manager.test.ts`, `tests/server/conversations.test.ts`                                                         | Implemented (3)                                                                              |
| INV-14 | Identity comes only from server-side state (config in Phase 3, session thereafter)                                                                                                                                          | 3              | Phase 4: `AuthService.resolve` → `RouteContext.auth` / `userOf`, document `appContext.auth`                                                                                 | `tests/server/registry.test.ts` (INV-14 code check), `tests/server/auth.test.ts`                                             | Implemented (3, 4)                                                                           |
| INV-15 | A user can never read, modify, delete, or observe another user's resources (404)                                                                                                                                            | 4              | service functions take `userId`; `GenerationManager.require(id, userId)`; per-user directories                                                                              | `tests/server/auth.test.ts` (INV-15), `tests/server/registry.test.ts` (401 enumeration), `scripts/verify.ts`                 | Implemented (4)                                                                              |
| INV-16 | Every state-changing route requires a valid CSRF token or same-origin check                                                                                                                                                 | 4              | registry `csrf` policy → `AuthService.checkMutation` / `checkOrigin`                                                                                                        | `tests/server/registry.test.ts` (INV-16 enumeration)                                                                         | Implemented (4)                                                                              |
| INV-17 | Reducing a user's privileges or disabling them revokes all their sessions                                                                                                                                                   | 4              | `AuthService.resolveHash` (user reloaded per request; role/status mismatch revokes), `SessionStore.revokeUser`                                                              | `tests/server/auth.test.ts` (INV-17, password change)                                                                        | Implemented (4)                                                                              |
| INV-18 | Only server-validated `(providerId, modelId)` pairs are ever sent to a provider                                                                                                                                             | 5              | `ModelCatalog.resolve` in `SendService.accept` (before any mutation)                                                                                                        | `tests/server/providers.test.ts` (unknown provider/model, pair valid on A sent to B)                                         | Implemented (5)                                                                              |
| INV-19 | Every provider endpoint passes SSRF validation on every create/edit and at request time                                                                                                                                     | 5              | `server/providers/ssrf.ts` (`checkUrl` at load, `createSafeFetch` per request with pinning)                                                                                 | `tests/server/providers.test.ts` (INV-19 suite: categories, IPv4-mapped, exceptions, rebinding, redirects, load-time)        | Implemented (5; admin edits in Phase 10 reuse it)                                            |
| INV-20 | SSE replay never silently skips events; a too-old `Last-Event-ID` triggers a full resync                                                                                                                                    | 6              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 6                                                                              |
| INV-21 | After a restart, no generation remains non-terminal; partial output of a running generation is persisted once as `interrupted`, and a terminal-decided outcome is persisted once with its recorded status                   | 6              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 6                                                                              |
| INV-22 | Rendered Markdown never executes script or raw HTML                                                                                                                                                                         | 7              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 7                                                                              |
| INV-23 | A stale response never overwrites newer client state                                                                                                                                                                        | 8              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 8                                                                              |
| INV-24 | Admin authorization is enforced server-side on every admin route                                                                                                                                                            | 10             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 10                                                                             |
| INV-25 | Secrets are write-only: no API response ever contains a configured secret                                                                                                                                                   | 10             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 10                                                                             |
| INV-26 | There is always at least one active admin                                                                                                                                                                                   | 10             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 10                                                                             |
| INV-27 | Attachment bytes are never served as executable content; media type is sniffed, not trusted                                                                                                                                 | 12             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 12                                                                             |
| INV-28 | Attachment storage paths never derive from the uploaded filename                                                                                                                                                            | 12             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 12                                                                             |
| INV-29 | Independent critical startup requests never form an accidental serial waterfall                                                                                                                                             | 9              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 9                                                                              |
| INV-30 | Secondary startup work never blocks composer interactivity                                                                                                                                                                  | 9              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 9                                                                              |
| INV-31 | Prefetch and consume paths use the same canonical cache identity; prefetched data cannot bypass INV-23 stale-response protection                                                                                            | 9              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 9                                                                              |
| INV-32 | Streaming an assistant response never remounts the application shell or unrelated transcript/sidebar trees                                                                                                                  | 9              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 9                                                                              |
| INV-33 | Production client runtime assets are first-party and no service worker is registered                                                                                                                                        | 9              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 9                                                                              |
| INV-34 | Pinning/default model/history preferences are user-owned canonical state; an index rebuild never deletes them                                                                                                               | 4              | `server/storage/preferences.ts` (separate canonical file, per-user lock)                                                                                                    | `tests/server/auth.test.ts`, `tests/server/preferences.test.ts`                                                              | Implemented (4)                                                                              |
| INV-35 | Conversation edits/deletes/regeneration cannot resurrect superseded messages, responses or proposals                                                                                                                        | 13a            | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13a                                                                            |
| INV-36 | Full-text search is user-scoped, bounded, and tolerates individual malformed files                                                                                                                                          | 13a            | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13a                                                                            |
| INV-37 | Model tool calls cannot directly write approved memories; proposal acceptance/rejection is an authenticated user action                                                                                                     | 13b            | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13b                                                                            |
| INV-38 | Memory proposals use conditional create/update/delete against the memory revision in the generation's prompt snapshot and detect any change since that snapshot                                                             | 13b            | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13b                                                                            |
| INV-39 | Memories, proposals, artifacts and preferences never cross account boundaries or survive a wrong-account cache                                                                                                              | 13b, 13c       | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13b, 13c                                                                       |
| INV-40 | An artifact is captured only after successful complete generation, exactly once per `(assistantMessageId, captureIndex)`, persists independently of conversation deletion, and is never recreated after the user deletes it | 13c            | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13c                                                                            |
| INV-41 | Artifacts are read as inert source, never executed, and no stored name becomes a filesystem path                                                                                                                            | 13c            | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13c                                                                            |
| INV-42 | Import is bounded by compressed size, expanded bytes, entry count, depth and time; no traversal or silent canonical overwrite                                                                                               | 13d, 13e       | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13d, 13e                                                                       |
| INV-43 | Exports preserve canonical Markdown; portable user archives round-trip all user canonical stores (operator backup is INV-50)                                                                                                | 13d            | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 13d                                                                            |
| INV-44 | Audio/images are passed only to a server-verified model with the matching input modality                                                                                                                                    | 12             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 12                                                                             |
| INV-45 | Response math/code/Markdown never execute raw provider content or create unsafe links                                                                                                                                       | 14             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 14                                                                             |
| INV-46 | Incremental rendering preserves selection, focus, scroll intent and unaffected message identity                                                                                                                             | 14             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 14                                                                             |
| INV-47 | Menus/dialogs/selects have correct keyboard, focus, portal and screen-reader behavior                                                                                                                                       | 7, 15          | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 7, 15                                                                          |
| INV-48 | Composer preserves IME, Enter/Shift+Enter, draft and attachment semantics and cannot double-send                                                                                                                            | 15             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 15                                                                             |
| INV-49 | Compose is the supported production path; the canonical `/data` volume survives ordinary recreate and update                                                                                                                | 1b             | `Dockerfile`, `compose.yaml` (named `/data` volume, 127.0.0.1 publication), `compose.podman.yaml`                                                                           | `scripts/verify-compose.ts` (Docker and Podman in CI)                                                                        | Implemented (1b)                                                                             |
| INV-50 | Backup/restore operates on a complete verified single-process data snapshot; restore refuses nonempty state                                                                                                                 | 16             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 16                                                                             |
| INV-51 | Optional interactive artifact execution is opaque-origin sandboxed, credentialless, without same-origin access                                                                                                              | 19             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 19 (optional, separately approved)                                             |
| INV-52 | Feature capability is truthfully classified as implemented, provider-dependent, or future; UI never implies unsupported tools                                                                                               | 14             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 14                                                                             |
| INV-53 | The URL is the authoritative active-conversation identity; every protected route uses shared auth gating, and navigation preserves the persistent shell, draft, active generation and URL-backed overlay/back behavior      | 7              | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 7                                                                              |
| INV-54 | Phase 1a renders useful HTML before JS; from Phase 4 authorized documents SSR the actual shell/composer and appropriate transcript while unauthorized requests never expose private markup                                  | 1a, 4          | Phase 1a portion: `app/routes/home.tsx` loader + `app/entry.server.tsx` stream real HTML before JS                                                                          | `scripts/verify.ts` (raw HTML of `/` and `/chat`, JS-disabled browser)                                                       | 1a, 2 and 4 portions implemented (authorized shell/transcript SSR, login-safe redirects)     |
| INV-55 | SSR identities/render context (Phase 4) and server QueryClient (Phase 7) are per-request; private HTML/dehydrated data never cross users or enter shared caches                                                             | 4, 7           | per-request `res.locals.auth` → `appContext`; `private, no-store` in `app/entry.server.tsx`                                                                                 | `scripts/verify.ts` (concurrent identities, private documents)                                                               | 4 portion implemented; QueryClient pending Phase 7                                           |
| INV-56 | Hydration preserves pre-hydration draft/theme/markup (Phases 1–4) and avoids duplicate initial fetch after Query hydration (Phase 7)                                                                                        | 1a, 2, 7       | Phase 1a portion: `app/root.tsx` (`<Links nonce="">`, hydration marker), `useHydrated` in `app/routes/home.tsx`; theme via CSS `prefers-color-scheme` (no bootstrap script) | `scripts/verify.ts` (production + development hydration without warnings; text typed into `/chat` before hydration survives) | 1a and 2 portions implemented (uncontrolled composer); Query (Phase 7) pending               |
| INV-57 | SSR document routing preserves real HTTP statuses, API/assets boundary, URL/overlay semantics, server-owned generation and production Compose/CSP operation                                                                 | 1a, 4, 7       | Phase 1a portion: `server/create-app.ts` ordering (`/assets` → `/api` → static → documents), framework 404 status, CSP nonce via `server/csp.ts` + `app/entry.server.tsx`   | `tests/server/boundary.test.ts`, `tests/server/csp.test.ts`, `scripts/verify.ts`                                             | 1a portion implemented; Phase 4/7 and Compose portions pending                               |
| INV-58 | A generation-starting request is accepted at most once per operation key; a lost response is resolvable by key, and an expired or mismatched key never causes a fresh send                                                  | 3              | `SendService` (key first, in-flight serialization, recheck under lock), `OperationStore`, `GET /api/operations/:key`                                                        | `tests/server/conversations.test.ts` (INV-58 suite)                                                                          | Implemented (3)                                                                              |
| INV-59 | A request is never executed under a different user than the one that issued it; CSRF retries and expected-user checks never carry one account's mutation into another                                                       | 4              | `X-Expected-User` check in `checkMutation`; `app/lib/api.ts` epoch/same-user retry rule                                                                                     | `tests/client/api.test.ts`, `tests/server/auth.test.ts` (INV-59)                                                             | Implemented (4)                                                                              |
| INV-60 | Unfinished recovery state is durable, recovered in the documented order exactly once, and recovery never recreates or undoes a user deletion                                                                                | 3, 6, 13b, 13c | Phase 3 portion: `server/storage/recovery.ts` (`resolvePendingRecord`, startup order)                                                                                       | `tests/server/conversations.test.ts` (INV-60 crash cases)                                                                    | 3 portion implemented; generation checkpoints (6), proposals (13b), artifacts (13c) pending  |
| INV-61 | Account closure is exclusive: after it begins, no request, late writer or recovery step modifies or recreates that account's data                                                                                           | 10             | —                                                                                                                                                                           | —                                                                                                                            | Pending Phase 10                                                                             |
| INV-62 | Generation admission, SSE connections, observer queues, provider responses, password hashing and upload reservations are bounded; overload is rejected, not queued without limit                                            | 2, 4, 6, 12    | Phase 2 portion: global admission in `GenerationManager`, `PROVIDER_MAX_RESPONSE_BYTES` in `llamacpp.ts`, byte-bounded observer queue in `sse.ts`                           | `tests/server/generations.test.ts` (INV-62 admission, cap, slow observer)                                                    | 2 portion implemented; per-user limits (4), SSE connection caps (6) and uploads (12) pending |

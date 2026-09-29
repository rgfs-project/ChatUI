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
app/components/         shell UI: ConversationView, Composer, Sidebar, Message, Markdown, Dialogs, Overlay, SectionBoundary, SignedOutShell
app/lib/                browser/SSR helpers: auth store, API adapter, query keys/options, SSR prefetch, sends, live generation, paths, shell state, scroll intent
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
style-src 'self' 'nonce-<same>'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self';
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

Superseded by the Phase 7 core UI (see "Core UI (Phase 7)"). The composer stays a native, uncontrolled `<textarea>`, so text typed before hydration survives it; Send stays disabled until hydration (no no-JS send path).

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

## Production streaming and recovery (Phase 6)

### Replay (INV-20)

- Every SSE event has a per-generation, monotonically increasing `id`. Each generation keeps a ring buffer of its last `SSE_REPLAY_EVENTS` events (default **2000**). That covers several minutes of token deltas at typical local speeds (~20–60 events/s) while keeping memory bounded at roughly the size of a long reply.
- **Cursor:** the `Last-Event-ID` header (sent automatically by `EventSource` on reconnect) takes precedence over `?lastEventId=` (for a newly created observer), so an automatic reconnect never reuses a stale URL cursor. Both must be 1–15 decimal digits, otherwise `400 VALIDATION`. Authorization (session and owner) is checked before any replay; a cursor is never a credential.
- **No cursor** → `snapshot` (full state), then live events.
- **Cursor inside the window** → exactly the missed events, then live.
- **Cursor older than the window, unknown or in the future** → one `resync` event with the full snapshot, then live. There is never a silent gap.
- **Terminal generation:** the replay/snapshot is sent (it includes the terminal event when the cursor is in the window) and the stream closes.
- The client treats `resync` like `snapshot` (replace, then append deltas) and reconciles by `assistantMessageId`. The server guarantees exact replay, so the client does no deduplication.
- **Browser connection limits:** each tab holds at most one EventSource for its open conversation (closed on terminal state, navigation, logout and account change). Over HTTP/1.1 browsers allow about 6 connections per origin, shared by all tabs. Many tabs streaming at once can therefore stall new requests until a stream ends. An HTTP/2 TLS proxy (Caddy, Tailscale HTTPS) removes this limit, and the server caps streams per user and in total (INV-62).

### Checkpoints (`server/storage/checkpoints.ts`)

- `_system/generations/<generation-id>.json` records the owner, conversation, ids, operation key, provider/model, state, content/reasoning so far and the last event id. It is never read as conversation history.
- **States:** `running` → `terminal-decided` (outcome, final content and reasoning recorded before the Markdown write) → `terminal`.
- The `running` checkpoint is written in the same locked step as acceptance (after the operation record is `committed`). While running it is rewritten at most every `GENERATION_CHECKPOINT_MS` (default 1000 ms), and only when content changed, plus on every state transition. One timer serves all generations; a test asserts well under one write per token. Writes are atomic and serialized per generation.
- **Terminal sequence:** `terminal-decided` → canonical assistant write (idempotent by assistant id; INV-07) → operation `terminalWritten` → `terminal` → publish the state and the terminal event with the revision.
- Unfinished checkpoints are recovery state. Finalized ones are removed after `GENERATION_RETENTION_MS` (startup sweep); in-memory terminal generations are evicted after the same time.

### Restart policy (INV-21, INV-60)

- In-flight generations do not survive a restart.
- **Graceful shutdown** (an optimization only): stop admitting, abort provider streams, write the latest progress as `running` checkpoints, let terminal sequences already under way finish within 10 s, close observers.
- **Startup step 5** (after operation records, before indexes):
  - every `running` checkpoint → its partial reply and reasoning are appended once with `status=interrupted`
  - every `terminal-decided` checkpoint → its recorded status and content are written once
  - every committed operation with `terminalWritten: false` and no checkpoint → one empty `interrupted` reply

  Each case is idempotent by assistant id (an existing block is skipped) and never recreates a deleted or touches a malformed conversation. The operation's `terminalWritten` flag is set, and that flag, not the absence of a block, decides, so a reply the user deleted is never re-added. Tests simulate a crash at each acceptance step and at each terminal-sequence boundary.

### Lifecycle

- Cancellation, provider interruption (errors, early stream end) and timeouts (inactivity, `GENERATION_MAX_MS`) all go through the single guarded terminal decision.
- A generation without observers is not abandoned; it runs to completion.
- Deterministic tests cover:
  - an observer attaching during the terminal sequence (exactly one terminal event)
  - reconnect after the terminal event
  - cancel vs completion
  - two concurrent sends to one conversation (one `409 GENERATION_IN_PROGRESS`)
  - a disabled account (its generations are cancelled and its streams end)

### E2E

- `npm run test:e2e` builds, then runs Playwright against the production server with a paced mock provider, a temporary `DATA_DIR` and an account created with the CLI (`tests/e2e`). It covers reload mid-generation, a network drop and reconnect without duplicated or lost text, and cancel from the UI.
- CI runs it on every push.

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

Conversation list, draft, open, rename, delete and send now live in the Phase 7 shell (see "Core UI (Phase 7)"). A send carries a fresh operation key and resends with the same key on network errors or `INTERNAL` (bounded), then reports an unknown outcome. The running generation comes from the conversation DTO's `activeGeneration`, so reloads re-observe it.

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
- `app/lib/api.ts` (`apiFetch`) attaches the CSRF token and expected user to mutations. Session state lives in the auth store (`app/lib/auth-store.ts`), not in the adapter. Any `401 UNAUTHENTICATED` moves auth to `unauthenticated` once (see "State and loading"). On `CSRF_INVALID` it refetches `/api/auth/session` once and retries once **only** if the account is unchanged, the authentication epoch is unchanged and the request is still current. Otherwise it discards the request (the account boundary then purges the old account's state) and throws. `SESSION_CHANGED` is handled the same way. Unit tests cover the retry, discard, superseded, SESSION_CHANGED and expiry paths.
- Pages: `/login` (validated `returnTo`: only `/chat`, `/chat/<id>`, `/account` and `/settings`; anything else → `/chat`), `/register` (404 when closed), `/account` (change password), and sign out in Settings.

### Authenticated SSR (INV-54, INV-55, INV-57)

- An Express middleware resolves the real session for **every document request** before the React Router handler; the result is passed per request through the router context (`appContext.auth`) and is never module-global.
- The shared app-layout loader (every protected route, including the catch-all) and `/account` redirect signed-out requests to `/login?returnTo=…` (302) before reading anything. The return-to names the page, never the single-fetch `.data` endpoint (`documentPathOf`). `/chat/<id>` loads only the signed-in user's conversation; another user's id is a 404 "does not exist" without metadata.
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
| `GENERATION_CHECKPOINT_MS`                          | `1000`                          | checkpoint cadence while running                                                              |
| `GENERATION_RETENTION_MS`                           | `3600000`                       | terminal generations and finalized checkpoints kept                                           |
| `SSE_REPLAY_EVENTS`                                 | `2000`                          | replay ring buffer per generation                                                             |
| `PUBLIC_ORIGIN`                                     | `http://localhost:<PORT>`       | https origin, or http://localhost / 127.0.0.1 / [::1] only                                    |
| `TRUST_PROXY`                                       | `0`                             | proxy hops trusted for the client address                                                     |
| `REGISTRATION_MODE`                                 | `closed`                        | `closed` \| `open`; overridden by the admin setting once saved (Phase 10)                     |
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

- All runtime JS, CSS and icons are built into `build/client` and served from the ChatUI origin. There are no CDN dependencies and no web fonts (system font stack). `assetsInlineLimit: 0` avoids `data:` URIs, and no service worker is registered (INV-33).
- Hashed `/assets/*` files:
  - They get `Cache-Control: public, max-age=31536000, immutable`. Vite names every JS/CSS file by content hash, so changed content gets a new URL (`verify` checks every name is hashed).
  - Since Phase 9, `npm run build` also writes Brotli (q11) and gzip (level 9) variants (`scripts/compress-assets.ts`). `server/static-compressed.ts` serves the best one the browser accepts, honouring `q=0`, with `Vary: Accept-Encoding` and the same immutable caching. Nothing is compressed per request.
- Other static files are cached for 1 hour.
- Documents and `.data` route data are `private, no-store`.
- HTML and JSON are deliberately _not_ compressed in-process. They carry the CSRF token and user content next to reflected input (a BREACH risk), so compression of those is left to the TLS proxy's policy.

## Core UI (Phase 7)

### Routes and shell (INV-53)

- `app/routes.ts`: public `/`, `/login`, `/register`, `/account`; everything else sits under the persistent layout route `routes/app-layout.tsx`: `/chat` (redirects to `/chat/new`; the legacy `?c=<id>` goes to `/chat/<id>`), `/chat/new` (a draft), `/chat/:conversationId`, `/settings` and `/admin` (URL-backed overlays), and `*` (unmatched → framework 404).
- The layout loader is the single auth guard for all of them. Signed-in, it seeds the per-request QueryClient and returns `{dehydratedState, user}`. The layout component owns the shell: header (sidebar toggle with `aria-expanded`/`aria-controls`, brand, user, Settings), sidebar, main area and `ShellProvider` (drafts and model choice). Route changes re-render only the `<Outlet/>`.
- The URL is the only active-conversation identity: the conversation id comes from route params and every path is built by `app/lib/paths.ts` (ids encoded).
- `/chat/new` never creates anything. The first successful send returns the server-minted id and the client `navigate(paths.chat(id), {replace: true})`, so Back skips the empty draft.
- A missing conversation (unknown or another user's id) is a **data error** inside an existing route: the loader returns HTTP 404 (422 for a malformed file) with the shell intact and a "does not exist" state. An **unmatched URL** is a route error: the framework 404 page.
- Overlays: Settings/Admin links carry `state.background` (the current path). While an overlay route matches, the layout keeps rendering that conversation behind it (`inert`) and the overlay renders in a Radix Dialog. Close, Escape and Back all return to it (`navigate(-1)`). A directly loaded or reloaded overlay has no background: it opens over `/chat/new` and closing replaces the URL with `/chat/new`. `/admin` is a 404 unless the server session says admin; there is no admin API yet (Phase 10).
- Drafts (per conversation key, tab memory only) and the last `(provider, model)` per conversation (falling back to the last-used pair) live in `ShellProvider`, so they survive navigation. The server validates every selection.

### Rendering pipeline

- Stored Markdown → `Message` (memo) → `Markdown` (memo on `text`) → `react-markdown` with `remark-gfm`, `skipHtml` (raw HTML is dropped, never parsed), `rehype-sanitize` (GitHub schema) and `urlTransform=safeUrl`. Only `http(s):`, `mailto:`, `#` and same-origin `/` paths survive; `javascript:`, `data:`, `vbscript:` and protocol-relative URLs are removed (INV-22).
- Links render with `target="_blank" rel="noopener noreferrer"`. Images never load: a text placeholder is shown (uploads are Phase 12). Code blocks get a language label, a copy button and horizontal scroll inside the block (`.code-block pre { overflow-x: auto }`).
- Rendering is read-only: stored Markdown is never rewritten. Math and richer rendering are Phase 14.
- The live reply renders through the same `Markdown` component on every delta. CommonMark treats an unclosed fence as a code block to the end of input, and GFM tables and lists render row by row, so unfinished fences, tables and lists are stable and never flip layout at their close.
- Reasoning renders in a collapsed `<details>`, styled apart from the answer. Stored statuses `cancelled`, `failed`, `timed_out` and `interrupted` show a badge.
- Isolation: stored messages are memoized by props, so a streaming token re-renders only the growing live message. The sidebar is memoized by `(userId, hidden)` and reads its own query. Test-only render/mount counters (`app/lib/render-counters.ts`, compiled in only when `MODE === "test"`) prove that deltas cause no message remounts or re-renders and no sidebar re-render (INV-32 groundwork; Phase 9 owns the budget). Messages stay in normal document flow; there is no virtualization (Phase 9 makes this an explicit contract).

### Scroll intent (`app/lib/use-scroll-pin.ts`)

- The transcript is its own scroll container (`.app-shell` is a `100dvh` grid with `overflow: hidden`; every flex/grid child that must shrink has `min-height: 0`/`min-width: 0`), so the document never scrolls. It is focusable (`tabIndex=0`, `role=region`) so keyboard users can scroll it.
- Pinned means within `PIN_THRESHOLD` (48 px) of the bottom. Scroll origin is tracked explicitly rather than by frame timing. Our own scrolls and content growth only move the viewport down, so these count as user intent and unpin: upward movement, an upward wheel, a touch drag, or ArrowUp/PageUp/Home/Shift+Space. Reaching the bottom again re-pins.
- Following happens in a layout effect keyed by a content version (stored message count, live reply id/state/error and text lengths). A `ResizeObserver` on the container and its list catches every other height change (status lines, the live reply swapped for its stored copy). Both run before paint, so a pinned transcript never shows a lagging frame.
- When unpinned and new content arrives, a "Jump to latest" button appears. It smooth-scrolls and re-pins.

### Client server state: TanStack Query

- **One layer.** One browser `QueryClient` per page load (`app/root.tsx`, `useState(createQueryClient)`): `staleTime` 30 s, one retry, no refetch on focus. One adapter (`apiJson` → `apiFetch`: CSRF token, `X-Expected-User`, epoch, same-user-only CSRF refetch-and-retry). One key factory (`queryKeys` in `app/lib/query.ts`): `["session"]` and `["user", userId, "conversations" | "conversation", id | "generation", id | "models" | "preferences"]`. Every user-scoped key carries the account id. Components never run their own fetch lifecycles: mutations go through `useMutation`/`apiJson` and invalidate by key. The terminal SSE event invalidates the conversation and the list; rename, delete and send invalidate the list.
- **SSR bootstrap.** `prefetchForRequest(seed)` (`app/lib/server-query.ts`) creates a fresh `QueryClient` per document or data request, never module-global. The layout loader seeds `models` (critical, 2.5 s budget; may be omitted). The conversation list is secondary and is loaded by the sidebar after hydration (Phase 8). The conversation loader seeds `conversation(id)`. Only successful queries whose key family is on `DEHYDRATE_ALLOWLIST` (conversations, conversation, models, preferences: browser-safe DTOs) are dehydrated; session/CSRF data, generations and errors never are. Each route passes its state through `HydrationBoundary` with identical keys.
- **After hydration** the browser reuses the seeded data (fresh for `staleTime`) and makes no duplicate initial fetch (tested). Render functions never touch browser globals on the server.
- **Account boundary** (`useAccountBoundary`, driven by the auth store): when the authenticated account changes (sign-in, sign-out, switch, or a session expiring mid-use) the previous account's in-flight queries are aborted, its queries removed and pending mutations dropped. The first render keeps the SSR seed.
- Keys for preferences exist for Phase 8 and later; Phases 12–13 add their own families.

### Interactive primitives decision record (INV-47; audited in Phase 15)

| Control                            | Choice                                                                             | Reason                                                                                                                       | Bundle cost (gzip, measured from the production build)                                                                                                 | SSR / hydration                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menus (conversation actions)       | Radix `DropdownMenu`                                                               | Roving focus, typeahead, Escape, focus return, collision-aware positioning and portal layering are hard to get right by hand | Menu + Floating UI ship inside the ≈ 20 KB `app-layout` chunk (together with the shell and sidebar code) and reuse the shared Dialog-layer chunk below | Renders only the trigger on the server; content mounts in a portal after interaction, so nothing to hydrate                                                                                       |
| Dialogs (rename, delete, overlays) | Radix `Dialog`                                                                     | Focus trap and restoration, `aria-modal`, outside content hidden from AT, scroll lock, Escape                                | ≈ 14 KB shared chunk (Dialog + focus scope, dismissable layer, portal, presence, `react-remove-scroll`)                                                | Closed dialogs render nothing. SSR-opened overlays (`/settings`) render in a portal after mount. The scroll lock's injected `<style>` carries the CSP nonce (`get-nonce` + `style-src 'nonce-…'`) |
| Model selector                     | Native `<select>` with `<optgroup>` per provider                                   | Fully accessible and keyboard-operable for free, works before hydration, no portal needed                                    | 0                                                                                                                                                      | Server-rendered with the seeded models; uncontrolled until the user picks                                                                                                                         |
| Popovers                           | None yet                                                                           | No control needs one in this phase; Radix `Popover` is the default when one does                                             | —                                                                                                                                                      | —                                                                                                                                                                                                 |
| Tooltips                           | Native `title` + `aria-label` on icon buttons                                      | Accessible name first; hover hint is progressive. A Radix `Tooltip` is reconsidered in Phase 15/18                           | 0                                                                                                                                                      | Static markup                                                                                                                                                                                     |
| Sidebar drawer                     | Native `<button aria-expanded aria-controls>` + CSS grid (`hidden` on the `<nav>`) | Desktop collapse needs no focus management; the mobile drawer (Phase 11) will reuse Radix `Dialog`                           | 0                                                                                                                                                      | Starts expanded on the server; state is client-only                                                                                                                                               |
| Toasts                             | `role="status" aria-live="polite"` region in the composer                          | Send/refresh outcomes are short, local status text; no toast stack is needed yet                                             | 0                                                                                                                                                      | Empty on the server                                                                                                                                                                               |
| Composer                           | Native `<textarea>` (contracts §13)                                                | Uncontrolled, so pre-hydration typing survives; Enter sends, Shift+Enter adds a newline, IME composition is respected        | 0                                                                                                                                                      | Server-rendered                                                                                                                                                                                   |

Wrappers live in `app/components/Dialogs.tsx` and `Overlay.tsx` and are styled with the semantic CSS tokens; there is no styled component suite. A dialog opened from a menu item returns focus to the menu trigger (`returnFocus`), because Radix would otherwise restore it to the unmounted item. Tests: `tests/client/primitives.test.tsx` covers keyboard open, arrows, Escape, focus return, focus trap, `aria-hidden` outside content, the portal outside the clipping ancestor, and the labelled navigation landmark. `tests/e2e/ui.spec.ts` checks in the browser that the menu is unclipped, on top (hit-tested) and outside the sidebar DOM.

### CSP for injected styles

`style-src` is `'self' 'nonce-<per-response>'` (no `unsafe-inline`). Radix's scroll lock injects one `<style>`. `app/entry.client.tsx` reads the nonce from a nonce'd script's `.nonce` property and passes it to `get-nonce`'s `setNonce` before hydration. Development keeps `'unsafe-inline'` for Vite.

### Tests

- Component (Vitest + Testing Library, jsdom): Markdown XSS and streaming prefixes (`markdown.test.tsx`), scroll intent (`scroll-pin.test.tsx`), streaming state transitions, malformed/missing states, keyboard send/newline, drafts across navigation and render counters (`conversation-view.test.tsx`), Query isolation/allowlist/no-refetch/account boundary (`query.test.tsx`), primitives (`primitives.test.tsx`), path builders (`paths.test.ts`).
- Browser (Playwright, `tests/e2e/ui.spec.ts`, against a seeded 200-message conversation and a paced `mock-long` Markdown answer):
  - independent transcript scroll; no viewport jumps while streaming pinned (sampled after every paint)
  - scrolled-up stays put, then jump to latest
  - find-in-page reaches an older message
  - sidebar collapse; unclipped menus
  - INV-53: deep-link reload, overlay Back/Forward/Escape, direct overlay load, draft URL replacement, missing vs unmatched, expired-session return-to, account switch
- E2E signs in once per account and reuses Playwright storage state (login is rate limited).

## State and loading (Phase 8)

### Startup dependency graph (contracts §9.2; INV-29 is verified in Phase 9)

```text
document request
 └─ session middleware ............ critical, first by necessity (authorization precedes any private read)
     ├─ root loader: session DTO .. critical, synchronous
     ├─ layout loader: models ..... critical (validates the model selection), ≤ 2.5 s budget, catalog stale-while-revalidate
     └─ chat loader: conversation . critical, includes activeGeneration (so the stream is observed at once)
         (these loaders run concurrently in React Router's loader pass)
HTML streams: shell + authorized transcript + native composer (typing works before JS)
hydrate (no refetch of seeded queries)
 ├─ SSE for the active generation ..... critical, starts right after hydration
 └─ GET /api/conversations (sidebar) .. secondary, never awaited by the server, never gates the composer
```

- Classification. The critical path is: session, the active conversation, its active generation, and enough model state to establish a selection. Secondary: the full conversation list, settings not on the active surface, provider detail, and (later) admin data.
- No session waterfall on the client: the session comes from SSR. Nothing waits on a `/api/auth/session` round trip before starting other requests.
- On client navigations the layout guard is not re-run (`shouldRevalidate`). Each route's own data request carries the auth check, and a 401 there (or from any API call) opens re-authentication instead of navigating. Explicit revalidation after re-authentication re-runs every loader.
- Evidence:
  - `tests/client/startup.test.tsx` drives the real loaders through React Router's static handler with controllable services. Models and the conversation both start before either resolves, two 150 ms dependencies finish in about 150 ms, and the list is never called.
  - `tests/e2e/state.spec.ts` holds the list response open under throttled networking and proves the composer sends and stores a reply meanwhile.

### Auth state (contracts §5, §12)

- `app/lib/auth-store.ts` is an external store with an explicit `unknown | authenticated | unauthenticated` status, the session DTO, the authentication epoch and `expired` (whose session ended mid-use).
- `useAuth()` derives the state from the root loader's session until the browser store is initialized. SSR and the hydration render therefore agree, and neither a login form nor a neutral placeholder ever flashes (tested with a DOM observer).
- `unknown` renders a neutral placeholder with no private content. It is reachable only when no server session is known.
- `applySession` is used for SSR bootstrap, revalidation and login. The epoch increments when the account changes; the same user re-authenticating keeps it. `expire()` handles a 401 once. `signedOut()` handles explicit sign-out.

### Request lifecycle and INV-23

- One adapter (`apiFetch`) and one set of `queryOptions` factories (`queries.*` in `app/lib/query.ts`: identical key and fetcher for every consumer). Each fetcher takes the query's `AbortSignal`.
- TanStack Query deduplicates identical in-flight queries. It aborts a query whose observers unmount or whose key changes (rapid conversation switching), and `invalidateQueries` cancels an in-flight refetch before starting a new one.
- React Router aborts a superseded navigation's data request and never commits it.
- The account boundary aborts and drops the previous account's work on every identity transition.
- SSE events are applied only for the generation currently observed; a late event from a superseded stream is ignored.
- Retries: only network failures and 5xx get one retry; 4xx answers, expiry and account changes are final.
- No per-component fetch lifecycles, no `useRef` run-once flags, and mutations are only started by user events, so Strict Mode double-mounting never duplicates one (tested).

### Optimistic sends (contracts §4.1 client rules)

- A send is a TanStack mutation (`app/lib/send.ts`, key `["user", id, "send"]`). Its variables carry a client-temporary message id, the operation key and the auth epoch.
- The optimistic message is rendered from mutation state (`useMutationState`), so there is no second source of truth. A pending send shows "Sending…". An accepted send stays visible until the conversation contains its `userMessageId`; then only the stored copy is shown.
- Outcomes:
  - **Rejected:** a contract error other than `INTERNAL`, including a 401 before acceptance. The message is removed, the text returns to the composer (and its draft), and the error is shown.
  - **Unknown:** `INTERNAL`, a network error or a non-contract response. The identical request (same bytes, same key) is resent with 1 s, 2 s and 3 s backoff.
  - **Outcome unknown:** `OPERATION_EXPIRED` or exhausted retries. The bubble offers "Refresh conversation", which looks the key up with `GET /api/operations/:key`: a hit reconciles; a miss says it was probably not saved and offers "Edit and resend", where the user sends explicitly with a new key.
  - An account change or expiry during retries discards the send.
- A new key is never minted for an unresolved send.

### Session expiry mid-use (contracts §12)

- Any 401 (API call, route data, or a closed SSE stream followed by a session check) moves auth to `unauthenticated` once.
- In response, the account boundary aborts and removes the account's queries and mutations. The layout stops rendering private content (sidebar, transcript, composer) and opens the re-authentication dialog (Radix Dialog, not dismissible, no document navigation).
- Drafts live only in the shell's tab memory, and the shell state is keyed by the account the tab belongs to (kept through the expiry).
  - Re-authenticating as the same user remounts the views and restores the draft.
  - Another identity changes the key: shell state is discarded, the URL is replaced with `/chat/new`, and the cache is purged.
  - The "Sign-in page" link, explicit logout, reload or tab close all leave the shell, so the draft is gone.
- Nothing is written to browser storage (tested in jsdom and in the browser).

### Error boundaries and empty states

- Boundaries:
  - The shell has the layout route's `ErrorBoundary` ("Try again" reloads).
  - The sidebar and the main area each have a `SectionBoundary` (`react-error-boundary` + `QueryErrorResetBoundary`). "Try again" resets that section's queries and re-renders it; navigating resets the main section.
  - Query errors that are not render failures show inline with a retry (transcript load failure, conversation list failure, model list failure).
- Empty states:
  - no conversations (sidebar)
  - no provider configured (send disabled)
  - all providers unavailable (explained, with Retry forcing discovery via `?refresh=1`)
  - unreachable providers with a stale list (warning; sending allowed, the server validates)
  - an empty conversation

### Future cache integrations

Phase 12 and each Phase 13 subphase add their own `queries.*` entries (keys under `["user", id, …]`), mutation invalidation and account-switch tests. No keys exist yet for absent features.

## Performance architecture (Phase 9)

No router or rendering-mode change: this phase measured and optimized the Framework Mode SSR app built since Phase 1.

### Critical path and bundle boundaries

- The startup graph is the Phase 8 one (see "State and loading"). A slow model endpoint can hold the document for at most `MODEL_BUDGET_MS` (2.5 s); the transcript is never held.
- Critical chat route: entry + root + `routes/app-layout` + `routes/chat-conversation` (and its split `clientLoader` chunk). It contains the shell, the basic Markdown transcript renderer, the composer, the model selector and generation controls, plus React, React Router and TanStack Query.
- Loaded on demand and never modulepreloaded (checked in `tests/e2e/perf.spec.ts`):
  - `ConversationMenu` (Radix DropdownMenu + Floating UI). The sidebar list only renders after hydration; a same-looking placeholder trigger records a click until the chunk arrives.
  - `Dialogs` (Radix Dialog + scroll lock), prefetched when a conversation menu opens.
  - `ReauthDialog`, loaded only after a session expires.
  - The route chunks for `/settings` and `/admin`.
- Public and sign-in pages no longer load TanStack Query: the provider moved from the root to the chat shell. The browser QueryClient is a page-level singleton, so remounting the shell keeps the cache, and the account boundary tracks the cache's account at module level.
- Markdown: GFM is registered parse-only (`app/lib/remark-gfm-parse.ts`), because `remark-gfm` also registers the Markdown serializer, which ChatUI never uses.
- There is no syntax highlighter yet. Math and other heavy renderers arrive in Phase 14, and only load when a message needs them.
- Chunk failures:
  - A route module that fails to load makes React Router reload the document. This is the standard recovery for deploy skew; it's tested, and the reloaded app works.
  - A lazy interaction chunk that fails shows the section boundary; its "Try again" reloads the page, because a failed module import can't be retried in place.

### Query and prefetch identity (INV-31, INV-23)

- `queries.*` pairs each key with its fetcher once. The view, the route `clientLoader` and the intent prefetch all use `queries.conversation`.
- Client navigation to `/chat/:id` goes through the route's `clientLoader`, which reads the page QueryClient: cached data renders at once; otherwise `client.query()` either joins an in-flight request or starts one. No `.data` round trip is made for it.
- Intent prefetch (`app/lib/prefetch.ts`):
  - Desktop hover (80 ms) or keyboard focus on a sidebar conversation. Touch never triggers it.
  - At most one speculation, sent at `priority: "low"`. A new intent or leaving aborts it unless a navigation has claimed it.
  - React Router's `prefetch="intent"` fetches only route chunks: data prefetch is skipped for routes with a `clientLoader`, and the layout opts out via `shouldRevalidate`.
- A refetch cancels an in-flight speculation, so an old prefetch answering last can't overwrite newer data (tested).

### Performance marks (contracts §9.5)

- `app/lib/perf.ts` defines the marks.
  - Document marks: `chatui:navigation-start` (t = 0), `shell-painted` (the server HTML's first contentful paint), `hydration-complete`, `composer-interactive` (hydrated, a server-known model, controls usable) and `conversation-visible`.
  - Send-path marks: `generation-accepted` (202), `stream-open` (SSE ready), `first-assistant-event` (first reasoning/content), `first-assistant-paint` and `generation-complete`.
  - Measures: `chatui:ComposerTTI` and `chatui:FirstAssistantEvent`.
- Each mark fires at most once per event, and send-path marks only for generations accepted in this document. Details hold opaque UUIDs only.
- Development exposes `chatuiPerf()` in the console. Production keeps the marks in the Performance timeline and exports nothing; there is no RUM SDK.
- Server TTFB comes from Navigation Timing. Provider latency is separate: `stream-open → first-assistant-event` is provider time, `first-assistant-event → first-assistant-paint` is frontend time.
- `scripts/perf-trace.ts` (`npm run perf:trace`) is a deterministic before/after trace. It uses the E2E fixture (200-message conversation, mock provider) with 4× CPU and 1.6 Mbit/s / 150 ms throttling, and reports median TTFB, FCP, DCL, hydration, ComposerTTI, the send path and transferred bytes.

### Budget

- `performance-budget.json` records, per route group, the gzip level 9 JS the manifest says a cold visit loads (`critical-chat-js`, `new-chat-js`, `login-js`), plus `critical-css` and `all-client-js`. The tolerance is 10%.
- `npm run perf:check` (`scripts/perf-check.ts`) reads only build output and is deterministic.
- `verify` runs it and also proves that a halved budget fails.
- Raising a budget requires an explanation in that phase's report.

### Streaming render cost and transcript

- Messages stay in normal document flow; there is no virtualization (contracts §9.2).
- Render/mount counters prove that streaming Markdown tokens into a 200-message conversation re-render only the growing reply. The shell, sidebar and older messages don't re-render or remount (INV-32). Find-in-page reaches older messages (unit and E2E).

### Prompt-prefix stability

- `tests/server/prompt-prefix.test.ts` sends 32 turns through the real app to the mock provider and compares formatted (template-applied) prompts. Each prompt extends the previous one, except at anchored window moves (fewer than a quarter of turns, after truncation begins).
- `scripts/probe-prefix.ts` measures reuse against a live llama.cpp server (results in the Phase 9 report).

## Administration (Phase 10)

### Authorization model (INV-24)

- The route registry has three policies: `public`, `user` and `admin`. `admin` routes (`/api/admin/*`) answer 401 when signed out and 403 `FORBIDDEN` for non-admins.
- The role comes from the **fresh** `user.json` on every request (`AuthService.resolve`). A session whose stored role no longer matches the account is revoked, so a demoted admin is locked out on the next request.
- UI hiding is cosmetic. The `/admin` document route is a 404 for non-admins.
- Admin request bodies may name a _target_ account (`role`, `userId`); the acting identity always comes from the session. The registry identity test enforces this, and every other route rejects `role` by strict schema.

### Users (INV-17, INV-26)

- DTO: `{id, username, role, status, createdAt, conversationCount}` (never `passwordHash`).
- Admins can create users with an initial password, set a new password (which revokes every session), and change role and status.
- Any reduction (admin→user, active→disabled) revokes all the account's sessions (closing their streams) and cancels and **forgets** its generations. Later reads or streams of those ids are 404.
- Last-admin protection: `UserStore.updateChecked` checks and writes under the registry lock, so demoting, disabling or deleting the last active admin (self included) fails with `409 LAST_ADMIN`.

### Account closure (contracts §6, INV-61)

`DELETE /api/admin/users/:id` requires typing the username. `AccountAdmin` then runs:

1. Under the registry lock, set `status: "closing"`. From here on sessions are invalid and logins fail.
2. Revoke sessions, which closes their SSE streams.
3. `generations.cancelAndForgetUser`: cancel, wait for every generation to settle, then forget them. A terminal write for a closing account throws `AccountClosedError`; the manager records it as _skipped_ (a `terminal` checkpoint) instead of retrying. This step never holds the barrier.
4. Take the per-user `UserBarrier` **exclusively** (it waits for in-flight shared holders; new shared requests queue behind it). `UserStore.detach` renames the user directory into `_system/deleting/<id>-<uuid>` and rebuilds the username index.
5. Release the barrier, delete that user's generation checkpoints (they live in `_system/generations`), and remove the renamed directory.

Writer rules:

- Every write into a user directory goes through `AccountWrites.run(userId, …)` (`server/storage/account.ts`): it holds the barrier shared and rechecks that the account exists and isn't `closing`.
- This covers conversation writes and deletes (including their index updates), operation records, preferences and admin index rebuilds. The guard is never nested, which would deadlock behind a queued exclusive.
- A writer that loses the race aborts with `AccountClosedError`. `mkdir` happens only after that check and never recreates a removed user root.
- Future writers (uploads in Phase 12; memories, imports and exports in Phase 13) must use the same guard.

Startup (`resumeClosures`, before recovery reads any account): any `closing` account is finished, and leftovers in `_system/deleting/` are removed. Both crash points are tested.

### Providers (INV-19, INV-25)

- `ProviderAdmin` edits `_system/providers.json`:
  - create, edit and remove, all atomic under a lock
  - after each write the registry is reloaded in-process (`installProviders`) and discovery restarts
- Every create or edit re-runs the full SSRF validation: `checkUrl` (scheme, no credentials) and `resolveChecked` (every resolved address against the policy, metadata always denied). A refused URL is `400 ENDPOINT_NOT_ALLOWED`. "Test connection" lists models through the same SSRF-guarded client and reports our own failure class.
- Secrets are write-only: the edit DTO takes `apiKey` (replace), `clearApiKey: true`, or neither (keep). Responses only say `hasApiKey`. The key lives only in the 0600 file.
- `samplingExtensions` (default `true`) marks llama.cpp-style servers. When `false`, `topK`, `minP` and `repeatPenalty` overrides are rejected.
- Bootstrap happens on a clean volume only: `providers.json` is written once from `LLAMA_BASE_URL`/`LLAMA_API_KEY`. After that the file (including admin edits) wins on every restart; the environment is ignored.

### Instance and model settings (`_system/settings.json`, `server/admin/settings.ts`)

- The file is `{version: 1, registrationMode?, defaultModel?, timezone?, generation?: {maxActivePerUser?, maxOutputTokens?}, models: [...]}`, written atomically after strict validation.
- A missing file means defaults. A corrupt one means defaults plus a `problem` shown to admins; it is never silently rewritten.
- Each `models` entry `{providerId, modelId, hidden?, temperature?, topP?, topK?, minP?, repeatPenalty?, systemPrompt?, timeContext?}` is range-validated.
- Changes apply live:
  - `registrationMode` overrides `REGISTRATION_MODE`
  - `generation.maxActivePerUser` overrides the per-user admission limit
  - `generation.maxOutputTokens` is the reserved output (context budget and `max_tokens`)
- Visibility: hidden `(providerId, modelId)` pairs are removed from `/api/models` and the SSR model seed for non-admins and fail `MODEL_NOT_FOUND` on send. Admins still see and use them. `defaultModel` is offered to the composer after the per-conversation and last-used choices.
- Prompts (contracts §4 item 3):
  - A model's `systemPrompt` becomes the first system message.
  - Only server-owned variables are allowed: `{{username}}`, `{{date}}`, `{{timezone}}`, expanded once from server values. Admin-supplied template text is the only thing expanded; user and memory text never is.
  - `{{time}}` is rejected in system prompts. `timeContext` instead prepends `[Context: the current time is HH:MM (zone).]` to the **newest** user message only, so the prompt prefix stays stable (tested: the system prefix is identical a minute apart).
- Sampling values reach llama.cpp as `temperature`, `top_p`, `top_k`, `min_p` and `repeat_penalty`.
- Revisions (§4.1): the resolved settings hash (template, expanded instructions, sampling, time-context flag) is captured in step 1 and rechecked under the lock in step 3. A change recomputes once; a second change is `CONFLICT`.

### Audit (`_system/audit/<yyyy-mm>.jsonl`)

- One fsynced JSON line per admin mutation: `{time, actor: {id, username}, action, target: {type, id?, label?}, outcome, code?, fields?}`.
- `fields` lists changed field _names_ only. Passwords, keys, prompts and message content are never recorded (tested with sentinels).
- `GET /api/admin/audit` returns the newest entries.

### UI and operator commands

- `/admin` is a URL-backed overlay with Radix Tabs (Users, Providers, Models, Settings, Maintenance, Audit log). Destructive actions need confirmation, and deletion requires typing the username.
- The route chunk, its CSS and Radix Tabs load only when an admin opens it. The Settings link prefetches it on intent, for admins only. A normal user's cold chat load makes no admin API request and loads no admin chunk (E2E). `perf:check` budgets `admin-route-js` separately.
- Operator CLI, also exercised in `verify:compose`:
  - `user:create --username <name> [--admin]`
  - `user:reset-password --username <name>` (password from the prompt or stdin, never argv; revokes sessions)
  - `index:rebuild` (offline)
- In Compose: `docker compose exec chatui node server/cli.ts …` (`index:rebuild` via `docker compose run --rm --no-deps chatui index:rebuild` with the service stopped; `run` uses the image entrypoint `node server/cli.ts`). Backup and restore arrive in Phase 16.

## Later sections

- Mobile, uploads, continuity, rendering, component audit, security hardening, reliability, polish: N/A until Phases 11–18.
- Interactive artifacts: optional Phase 19, separately approved.

## Deviations from the written specification

- **React Router 8.4 instead of 7.** The project owner asked for the latest dependencies. v8 is the direct successor with the same Framework Mode SSR, route modules and `@react-router/express` adapter. Its breaking changes (ESM-only packages, always-on middleware, `RouterContextProvider` for load context, Node ≥ 22.22, React ≥ 19.2.7) don't affect the required architecture.
- **Node 24 LTS instead of 22.x.** The spec allows a newer supported LTS; 24.21.0 is the current Active LTS.
- **TypeScript 6.0.3 instead of 7.0.** typescript-eslint (required for type-aware linting) supports `<6.1`.
- **Workflow.** The project owner authorized autonomous phase execution with commits pushed to `main` on GitHub. The spec's plan-approval pause and local-only commits don't apply to this repository.

## Invariant register

Tests name the invariant in their title (e.g. `INV-01: …`). "Pending" rows are enforced and tested once their phase is executed.

| ID     | Invariant                                                                                                                                                                                                                   | Phase          | Enforcement                                                                                                                                                                                                                                                                                                            | Tests                                                                                                                                                                                                                                                                                 | Status                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| INV-01 | Every API error uses the canonical error contract; unhandled errors become `INTERNAL` with no internals exposed                                                                                                             | 1a             | `server/errors.ts` (`apiErrorHandler`, `toAppError`), `server/create-app.ts` (API/asset 404s)                                                                                                                                                                                                                          | `tests/server/errors.test.ts`, `scripts/verify.ts`                                                                                                                                                                                                                                    | Implemented (1a)                                                                             |
| INV-02 | Every request body is schema-validated and unknown fields are rejected                                                                                                                                                      | 1a             | `server/validation.ts` (`parseRequest`, strict schemas; omitted parts must be empty), `server/registry.ts`                                                                                                                                                                                                             | `tests/server/errors.test.ts` (request validation)                                                                                                                                                                                                                                    | Implemented (1a)                                                                             |
| INV-03 | Responses are explicit DTOs; no server-only secrets, credential hashes, paths, or upstream bodies in any response (browser CSRF token per §5 is allowed)                                                                    | 1a             | `server/registry.ts` parses every handler result through its strict response DTO schema; `shared/api.ts`                                                                                                                                                                                                               | `tests/server/errors.test.ts`, `tests/server/registry.test.ts`                                                                                                                                                                                                                        | Implemented (1a)                                                                             |
| INV-04 | Provider credentials and raw provider payloads never reach the browser                                                                                                                                                      | 2              | `server/providers/llamacpp.ts` (normalized `ProviderError`, own messages), `server/generations/catalog.ts` + `shared/generations.ts` DTOs                                                                                                                                                                              | `tests/server/generations.test.ts` (INV-04, discovery, failure cases)                                                                                                                                                                                                                 | Implemented (2)                                                                              |
| INV-05 | A generation reaches exactly one terminal state                                                                                                                                                                             | 2              | `GenerationManager.finish()` single guarded transition                                                                                                                                                                                                                                                                 | `tests/server/manager.test.ts` (cancel/complete race), `tests/server/generations.test.ts`                                                                                                                                                                                             | Implemented (2)                                                                              |
| INV-06 | Closing an SSE connection never cancels a generation                                                                                                                                                                        | 2              | `server/generations/sse.ts` (disconnect only unsubscribes), `GenerationManager.observe`                                                                                                                                                                                                                                | `tests/server/generations.test.ts` (disconnect/reconnect), `tests/server/manager.test.ts`, `scripts/verify.ts` (reload)                                                                                                                                                               | Implemented (2)                                                                              |
| INV-07 | The assistant message is written to canonical storage exactly once per generation                                                                                                                                           | 3              | `SendService.persistOutcome` (idempotent by assistant id, under lock), `GenerationManager.finish` single decision                                                                                                                                                                                                      | `tests/server/conversations.test.ts` (INV-08/INV-07), `tests/server/manager.test.ts` (race: one persisted outcome)                                                                                                                                                                    | Implemented (3)                                                                              |
| INV-08 | The user message is durable before `202` is returned                                                                                                                                                                        | 3              | `SendService.commit` (atomic write + committed record before return)                                                                                                                                                                                                                                                   | `tests/server/conversations.test.ts` (file read right after 202)                                                                                                                                                                                                                      | Implemented (3)                                                                              |
| INV-09 | `formatVersion: 1` round-trips exactly (§3.6)                                                                                                                                                                               | 3              | `server/storage/markdown.ts`                                                                                                                                                                                                                                                                                           | `tests/storage/markdown.test.ts` (examples + fast-check properties)                                                                                                                                                                                                                   | Implemented (3)                                                                              |
| INV-10 | Malformed conversations are never modified by the application and never break other conversations                                                                                                                           | 3              | `ConversationStore.get/rename`, `SendService.readExisting`, index `malformed` entries                                                                                                                                                                                                                                  | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`, `scripts/verify.ts`                                                                                                                                                                                            | Implemented (3)                                                                              |
| INV-11 | The index is derived: deleting it and restarting loses nothing                                                                                                                                                              | 3              | `ChatIndex` (rebuild, dirty marker, reconcile)                                                                                                                                                                                                                                                                         | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`, `scripts/verify.ts`                                                                                                                                                                                            | Implemented (3)                                                                              |
| INV-12 | No filesystem path contains request-controlled input; all paths stay inside `DATA_DIR`                                                                                                                                      | 3              | `server/storage/paths.ts`, `canonicalUuid` route schemas                                                                                                                                                                                                                                                               | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`                                                                                                                                                                                                                 | Implemented (3)                                                                              |
| INV-13 | At most one non-terminal generation per conversation                                                                                                                                                                        | 3              | `GenerationManager.reserve/assertIdle`                                                                                                                                                                                                                                                                                 | `tests/server/manager.test.ts`, `tests/server/conversations.test.ts`                                                                                                                                                                                                                  | Implemented (3)                                                                              |
| INV-14 | Identity comes only from server-side state (config in Phase 3, session thereafter)                                                                                                                                          | 3              | Phase 4: `AuthService.resolve` → `RouteContext.auth` / `userOf`, document `appContext.auth`                                                                                                                                                                                                                            | `tests/server/registry.test.ts` (INV-14 code check), `tests/server/auth.test.ts`                                                                                                                                                                                                      | Implemented (3, 4)                                                                           |
| INV-15 | A user can never read, modify, delete, or observe another user's resources (404)                                                                                                                                            | 4              | service functions take `userId`; `GenerationManager.require(id, userId)`; per-user directories                                                                                                                                                                                                                         | `tests/server/auth.test.ts` (INV-15), `tests/server/registry.test.ts` (401 enumeration), `scripts/verify.ts`                                                                                                                                                                          | Implemented (4)                                                                              |
| INV-16 | Every state-changing route requires a valid CSRF token or same-origin check                                                                                                                                                 | 4              | registry `csrf` policy → `AuthService.checkMutation` / `checkOrigin`                                                                                                                                                                                                                                                   | `tests/server/registry.test.ts` (INV-16 enumeration)                                                                                                                                                                                                                                  | Implemented (4)                                                                              |
| INV-17 | Reducing a user's privileges or disabling them revokes all their sessions                                                                                                                                                   | 4              | Registry `admin` policy re-reads the role; `AccountAdmin.change`/`setPassword` revoke sessions; reductions cancel and forget generations                                                                                                                                                                               | `tests/server/admin.test.ts` (disable cancels generation, observers closed, 404 afterwards; password reset revokes)                                                                                                                                                                   | Implemented                                                                                  |
| INV-18 | Only server-validated `(providerId, modelId)` pairs are ever sent to a provider                                                                                                                                             | 5              | `ModelCatalog.resolve` in `SendService.accept` (before any mutation)                                                                                                                                                                                                                                                   | `tests/server/providers.test.ts` (unknown provider/model, pair valid on A sent to B)                                                                                                                                                                                                  | Implemented (5)                                                                              |
| INV-19 | Every provider endpoint passes SSRF validation on every create/edit and at request time                                                                                                                                     | 5              | `ProviderAdmin.validateUrl` (checkUrl + resolveChecked) on every create/edit/test; request-time pinning via `createSafeFetch`                                                                                                                                                                                          | `tests/server/providers.test.ts`, `tests/server/admin.test.ts` (create/edit/test SSRF)                                                                                                                                                                                                | Implemented                                                                                  |
| INV-20 | SSE replay never silently skips events; a too-old `Last-Event-ID` triggers a full resync                                                                                                                                    | 6              | `GenerationManager.observe` (ring buffer, `resync`), cursor rules in `server/routes/generations.ts`                                                                                                                                                                                                                    | `tests/server/streaming.test.ts` (INV-20), `scripts/verify.ts` (reconnect), `tests/e2e/streaming.spec.ts`                                                                                                                                                                             | Implemented (6)                                                                              |
| INV-21 | After a restart, no generation remains non-terminal; partial output of a running generation is persisted once as `interrupted`, and a terminal-decided outcome is persisted once with its recorded status                   | 6              | `recoverGenerations` in `server/storage/recovery.ts`; `GenerationManager.shutdown`                                                                                                                                                                                                                                     | `tests/server/streaming.test.ts` (INV-21 / INV-60)                                                                                                                                                                                                                                    | Implemented (6)                                                                              |
| INV-22 | Rendered Markdown never executes script or raw HTML                                                                                                                                                                         | 7              | `app/components/Markdown.tsx`: `skipHtml`, `rehype-sanitize`, `safeUrl` scheme allowlist, hardened links, image placeholders                                                                                                                                                                                           | `tests/client/markdown.test.tsx` (`<script>`, `<img onerror>`, `javascript:`/`data:` links, HTML in fences)                                                                                                                                                                           | Implemented (Phase 14 extends rendering)                                                     |
| INV-23 | A stale response never overwrites newer client state                                                                                                                                                                        | 8              | Query keys per identity + AbortSignal in every fetcher, `invalidateQueries` cancel-refetch, React Router navigation abort, account-boundary cancellation, SSE events filtered by observed generation id, epoch-tagged sends                                                                                            | `tests/client/state.test.tsx` (reordered responses, rapid switching), `tests/client/query.test.tsx` (expiry aborts), `tests/e2e/state.spec.ts` (rapid switching with random latency)                                                                                                  | Implemented                                                                                  |
| INV-24 | Admin authorization is enforced server-side on every admin route                                                                                                                                                            | 10             | Registry `admin` policy on every `/api/admin/*` route (fresh user record); `/admin` route loader 404 for non-admins                                                                                                                                                                                                    | `tests/server/admin.test.ts` (every admin route: 401/403/disabled 401/admin), `tests/server/registry.test.ts`, `tests/e2e/admin.spec.ts`                                                                                                                                              | Implemented                                                                                  |
| INV-25 | Secrets are write-only: no API response ever contains a configured secret                                                                                                                                                   | 10             | Provider DTO exposes `hasApiKey` only; `apiKey`/`clearApiKey` write-only edit semantics; audit records field names only                                                                                                                                                                                                | `tests/server/admin.test.ts` (write-only key, sentinel exposure across every route, header and log line)                                                                                                                                                                              | Implemented                                                                                  |
| INV-26 | There is always at least one active admin                                                                                                                                                                                   | 10             | `UserStore.updateChecked` under the registry lock; `LAST_ADMIN` for demote/disable/delete (self included)                                                                                                                                                                                                              | `tests/server/admin.test.ts`                                                                                                                                                                                                                                                          | Implemented                                                                                  |
| INV-27 | Attachment bytes are never served as executable content; media type is sniffed, not trusted                                                                                                                                 | 12             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 12                                                                             |
| INV-28 | Attachment storage paths never derive from the uploaded filename                                                                                                                                                            | 12             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 12                                                                             |
| INV-29 | Independent critical startup requests never form an accidental serial waterfall                                                                                                                                             | 9              | Classified startup graph: session middleware, then models and conversation loaders concurrently; list deferred                                                                                                                                                                                                         | `tests/client/startup.test.tsx` (gated overlap, 150 ms + 150 ms ≈ 150 ms, hanging models bounded), `tests/e2e/state.spec.ts`                                                                                                                                                          | Implemented                                                                                  |
| INV-30 | Secondary startup work never blocks composer interactivity                                                                                                                                                                  | 9              | Sidebar list secondary (post-hydration), composer gated only by session + model; interaction chunks lazy                                                                                                                                                                                                               | `tests/client/state.test.tsx` (held list), `tests/e2e/state.spec.ts` (held list, slow network)                                                                                                                                                                                        | Implemented                                                                                  |
| INV-31 | Prefetch and consume paths use the same canonical cache identity; prefetched data cannot bypass INV-23 stale-response protection                                                                                            | 9              | `queries.*` shared by view, `clientLoader` and intent prefetch; one speculation, low priority, abortable                                                                                                                                                                                                               | `tests/client/prefetch.test.tsx`                                                                                                                                                                                                                                                      | Implemented                                                                                  |
| INV-32 | Streaming an assistant response never remounts the application shell or unrelated transcript/sidebar trees                                                                                                                  | 9              | Memoized Message/Markdown/Sidebar, persistent shell, render counters                                                                                                                                                                                                                                                   | `tests/client/conversation-view.test.tsx` (200-message streaming), `tests/e2e/ui.spec.ts`                                                                                                                                                                                             | Implemented                                                                                  |
| INV-33 | Production client runtime assets are first-party and no service worker is registered                                                                                                                                        | 9              | First-party build assets, no CDN, no service worker                                                                                                                                                                                                                                                                    | `tests/e2e/perf.spec.ts` (origins, SW), `scripts/verify.ts`                                                                                                                                                                                                                           | Implemented                                                                                  |
| INV-34 | Pinning/default model/history preferences are user-owned canonical state; an index rebuild never deletes them                                                                                                               | 4              | `server/storage/preferences.ts` (separate canonical file, per-user lock)                                                                                                                                                                                                                                               | `tests/server/auth.test.ts`, `tests/server/preferences.test.ts`                                                                                                                                                                                                                       | Implemented (4)                                                                              |
| INV-35 | Conversation edits/deletes/regeneration cannot resurrect superseded messages, responses or proposals                                                                                                                        | 13a            | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13a                                                                            |
| INV-36 | Full-text search is user-scoped, bounded, and tolerates individual malformed files                                                                                                                                          | 13a            | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13a                                                                            |
| INV-37 | Model tool calls cannot directly write approved memories; proposal acceptance/rejection is an authenticated user action                                                                                                     | 13b            | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13b                                                                            |
| INV-38 | Memory proposals use conditional create/update/delete against the memory revision in the generation's prompt snapshot and detect any change since that snapshot                                                             | 13b            | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13b                                                                            |
| INV-39 | Memories, proposals, artifacts and preferences never cross account boundaries or survive a wrong-account cache                                                                                                              | 13b, 13c       | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13b, 13c                                                                       |
| INV-40 | An artifact is captured only after successful complete generation, exactly once per `(assistantMessageId, captureIndex)`, persists independently of conversation deletion, and is never recreated after the user deletes it | 13c            | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13c                                                                            |
| INV-41 | Artifacts are read as inert source, never executed, and no stored name becomes a filesystem path                                                                                                                            | 13c            | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13c                                                                            |
| INV-42 | Import is bounded by compressed size, expanded bytes, entry count, depth and time; no traversal or silent canonical overwrite                                                                                               | 13d, 13e       | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13d, 13e                                                                       |
| INV-43 | Exports preserve canonical Markdown; portable user archives round-trip all user canonical stores (operator backup is INV-50)                                                                                                | 13d            | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 13d                                                                            |
| INV-44 | Audio/images are passed only to a server-verified model with the matching input modality                                                                                                                                    | 12             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 12                                                                             |
| INV-45 | Response math/code/Markdown never execute raw provider content or create unsafe links                                                                                                                                       | 14             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 14                                                                             |
| INV-46 | Incremental rendering preserves selection, focus, scroll intent and unaffected message identity                                                                                                                             | 14             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 14                                                                             |
| INV-47 | Menus/dialogs/selects have correct keyboard, focus, portal and screen-reader behavior                                                                                                                                       | 7, 15          | Primitive decision record (Core UI): Radix `DropdownMenu`/`Dialog` wrappers, native `<select>`, focus return to menu triggers                                                                                                                                                                                          | `tests/client/primitives.test.tsx`, `tests/e2e/ui.spec.ts` (unclipped, on-top portal)                                                                                                                                                                                                 | Phase 7 controls implemented; audit pending Phase 15                                         |
| INV-48 | Composer preserves IME, Enter/Shift+Enter, draft and attachment semantics and cannot double-send                                                                                                                            | 15             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 15                                                                             |
| INV-49 | Compose is the supported production path; the canonical `/data` volume survives ordinary recreate and update                                                                                                                | 1b             | `Dockerfile`, `compose.yaml` (named `/data` volume, 127.0.0.1 publication), `compose.podman.yaml`                                                                                                                                                                                                                      | `scripts/verify-compose.ts` (Docker and Podman in CI)                                                                                                                                                                                                                                 | Implemented (1b)                                                                             |
| INV-50 | Backup/restore operates on a complete verified single-process data snapshot; restore refuses nonempty state                                                                                                                 | 16             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 16                                                                             |
| INV-51 | Optional interactive artifact execution is opaque-origin sandboxed, credentialless, without same-origin access                                                                                                              | 19             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 19 (optional, separately approved)                                             |
| INV-52 | Feature capability is truthfully classified as implemented, provider-dependent, or future; UI never implies unsupported tools                                                                                               | 14             | —                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                     | Pending Phase 14                                                                             |
| INV-53 | The URL is the authoritative active-conversation identity; every protected route uses shared auth gating, and navigation preserves the persistent shell, draft, active generation and URL-backed overlay/back behavior      | 7              | `app/routes.ts` layout route + shared loader guard, `app/lib/paths.ts`, `ShellProvider`, `Overlay` (`state.background`), draft URL replacement                                                                                                                                                                         | `tests/e2e/ui.spec.ts` (INV-53 routing), `tests/client/paths.test.ts`, `tests/client/conversation-view.test.tsx` (drafts), `scripts/verify.ts`                                                                                                                                        | Implemented (mobile Back cases with Phase 11)                                                |
| INV-54 | Phase 1a renders useful HTML before JS; from Phase 4 authorized documents SSR the actual shell/composer and appropriate transcript while unauthorized requests never expose private markup                                  | 1a, 4          | Phase 1a portion: `app/routes/home.tsx` loader + `app/entry.server.tsx` stream real HTML before JS                                                                                                                                                                                                                     | `scripts/verify.ts` (raw HTML of `/` and `/chat`, JS-disabled browser)                                                                                                                                                                                                                | 1a, 2 and 4 portions implemented (authorized shell/transcript SSR, login-safe redirects)     |
| INV-55 | SSR identities/render context (Phase 4) and server QueryClient (Phase 7) are per-request; private HTML/dehydrated data never cross users or enter shared caches                                                             | 4, 7           | per-request `res.locals.auth` → `appContext`; `private, no-store` in `app/entry.server.tsx`; `prefetchForRequest` (fresh client per request) + `DEHYDRATE_ALLOWLIST`; `useAccountBoundary`                                                                                                                             | `scripts/verify.ts` (concurrent identities, private documents), `tests/client/query.test.tsx` (two concurrent users, allowlist, account switch), `tests/e2e/ui.spec.ts` (account switch), `scripts/verify.ts` (interleaved A/B sentinel across documents, route data and error pages) | Implemented                                                                                  |
| INV-56 | Hydration preserves pre-hydration draft/theme/markup (Phases 1–4) and avoids duplicate initial fetch after Query hydration (Phase 7)                                                                                        | 1a, 2, 7       | `app/root.tsx` (`<Links nonce="">`, hydration marker), `useHydrated`; uncontrolled composer; `HydrationBoundary` with identical keys + 30 s `staleTime`; the account boundary keeps the SSR seed on first render; theme via CSS `prefers-color-scheme`                                                                 | `scripts/verify.ts` (hydration without warnings, text typed before hydration survives), `tests/client/query.test.tsx` (no duplicate initial fetch)                                                                                                                                    | Implemented                                                                                  |
| INV-57 | SSR document routing preserves real HTTP statuses, API/assets boundary, URL/overlay semantics, server-owned generation and production Compose/CSP operation                                                                 | 1a, 4, 7       | `server/create-app.ts` ordering (`/assets` → `/api` → static → documents); framework 404 for unmatched routes; loader-set 404/422 for missing/malformed conversations; CSP nonce for scripts and injected styles (`server/csp.ts`, `app/entry.client.tsx`); `.data` route data private, no-store (`handleDataRequest`) | `tests/server/boundary.test.ts`, `tests/server/csp.test.ts`, `scripts/verify.ts`, `scripts/verify-compose.ts`, `tests/e2e/ui.spec.ts`, `tests/e2e/perf.spec.ts`                                                                                                                       | Implemented through Phase 9                                                                  |
| INV-58 | A generation-starting request is accepted at most once per operation key; a lost response is resolvable by key, and an expired or mismatched key never causes a fresh send                                                  | 3              | `SendService` (key first, in-flight serialization, recheck under lock), `OperationStore`, `GET /api/operations/:key`                                                                                                                                                                                                   | `tests/server/conversations.test.ts` (INV-58 suite)                                                                                                                                                                                                                                   | Implemented (3)                                                                              |
| INV-59 | A request is never executed under a different user than the one that issued it; CSRF retries and expected-user checks never carry one account's mutation into another                                                       | 4              | `X-Expected-User` check in `checkMutation`; `app/lib/api.ts` epoch/same-user retry rule                                                                                                                                                                                                                                | `tests/client/api.test.ts`, `tests/server/auth.test.ts` (INV-59)                                                                                                                                                                                                                      | Implemented (4)                                                                              |
| INV-60 | Unfinished recovery state is durable, recovered in the documented order exactly once, and recovery never recreates or undoes a user deletion                                                                                | 3, 6, 13b, 13c | Phase 3 portion: `server/storage/recovery.ts` (`resolvePendingRecord`, startup order)                                                                                                                                                                                                                                  | `tests/server/conversations.test.ts` (INV-60 crash cases)                                                                                                                                                                                                                             | 3 portion implemented; generation checkpoints (6), proposals (13b), artifacts (13c) pending  |
| INV-61 | Account closure is exclusive: after it begins, no request, late writer or recovery step modifies or recreates that account's data                                                                                           | 10             | `UserBarrier` + `AccountWrites` guard on every user-directory writer; closure sequence in `AccountAdmin`; terminal writes skipped for closing accounts; `resumeClosures` at startup                                                                                                                                    | `tests/server/admin.test.ts` (deletion, deletion during a generation, in-flight vs. late writer, both crash points)                                                                                                                                                                   | Implemented for current writers; Phases 12–13 writers must use the guard                     |
| INV-62 | Generation admission, SSE connections, observer queues, provider responses, password hashing and upload reservations are bounded; overload is rejected, not queued without limit                                            | 2, 4, 6, 12    | Phase 2 portion: global admission in `GenerationManager`, `PROVIDER_MAX_RESPONSE_BYTES` in `llamacpp.ts`, byte-bounded observer queue in `sse.ts`                                                                                                                                                                      | `tests/server/generations.test.ts` (INV-62 admission, cap, slow observer)                                                                                                                                                                                                             | 2 portion implemented; per-user limits (4), SSE connection caps (6) and uploads (12) pending |

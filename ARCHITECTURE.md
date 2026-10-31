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
- The public status page (`app/routes/status.tsx`, `/status`) renders the server health result into the HTML. Its loader calls the internal health service through the per-request router context and never makes an HTTP call back to its own server.
- Hydration safety: `useHydrated()` (`useSyncExternalStore`) returns `false` on the server and during hydration and `true` afterwards, so the first client render matches the server HTML. `<Links nonce="">` prevents a nonce hydration mismatch, because browsers hide nonce values from the DOM and stylesheets don't need a nonce. Elements that must carry the nonce (the Phase 7a scroll-position script) get it from `NonceContext`, provided only by `entry.server`, and suppress that one attribute mismatch.
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
style-src 'self' 'nonce-<same>'; style-src-attr 'none'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self';
worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'
```

No `unsafe-inline` or `unsafe-eval`. The style nonce (Phase 7a) admits exactly one kind of inline `<style>`: the scroll-lock element that Radix modal dialogs insert (`react-remove-scroll`). `entry.client` reads the nonce from a framework `<script>` (its `nonce` property) and hands it to that library through `__webpack_nonce__`; style attributes stay blocked by `style-src-attr 'none'` (Radix positions popovers through the CSSOM, which CSP does not restrict). Development only adds `'unsafe-inline'` for styles (Vite-injected styles) and `connect-src ws://localhost:* ws://127.0.0.1:*` (HMR). Other headers: `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, COOP/CORP `same-origin`. HSTS is left to the TLS-terminating proxy deployment introduced with authentication (Phase 4).

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

Phase 2 introduced a single `/chat` demo page. Phase 7a replaced it with the full interface described in "Chat interface (Phase 7a)"; the constraints set here still hold: a native uncontrolled `<textarea>` usable before JavaScript, Send disabled until hydration (no no-JS send path), a 2.5 s model-discovery budget for SSR, and `EventSource` observation. Since Phase 4 every chat route requires a session.

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

## Chat interface (Phase 7a)

### Routes and continuity (INV-53)

```text
/                      → 302 /chat/new (signed in) or /login
/status                public status page (Phase 1a)
/login, /register      public
/chat, /chat?c=<id>    → 301 /chat/new, /chat/<id> (old links)
/account               → 301 /settings/account
app-layout (protected: one auth guard for every child, catch-all included)
├── /chat/new                 the draft (no server conversation)
├── /chat/:conversationId     a conversation (404 data error when missing; 422 when malformed)
├── /settings/:section?       URL-backed overlay (general, account, shortcuts)
├── /admin                    reserved overlay: server role gate, 404 for non-admins (Phase 10)
└── *                         404 page inside the shell
```

- **One persistent shell.** `app-layout.tsx` renders the sidebar, header, transcript and composer. Chat routes only name the conversation (`handle.kind = "chat"`); overlays (`"overlay"`) render on top of it; other pages (`"page"`) replace only the main column. Navigation, overlays and streaming never remount the shell (render-probe tests).
- **The URL is the identity.** The displayed conversation is `params.conversationId`, or for an overlay the conversation in its router state (`background`). No second active-conversation state exists.
- **Paths** come from `app/lib/paths.ts`; ids are encoded. Overlays opened in-app push `{ background }` state, so Back closes them and Forward reopens them over the same chat. A direct link or reload opens them over the draft, and closing goes to `/chat/new`. Settings sections replace each other, so one Back still closes Settings.
- **Drafts** are tab memory only (`app/chat/drafts.ts`), keyed by user and conversation, never browser storage. The first send navigates to the server-issued id with `replace`, so Back skips the empty draft. Sign-out and account changes clear every draft.

### Server state: TanStack Query (INV-55, INV-56)

- **Key factory** (`app/lib/query/keys.ts`): `["session"]`, and `["u", userId, resource, …]` for `conversations`, `conversation` (its result carries the revision), `models`, `preferences` and `generation`. The user id in every private key is the account boundary.
- **Query definitions** (`app/lib/query/queries.ts`) pair each key with its fetcher. A conversation is fetched as a _result_ (`{ok, conversation} | {ok:false, code}`), so not-found and malformed are displayable, dehydratable outcomes.
- **One fetch adapter** (`apiFetch`/`apiJson` in `app/lib/api.ts`) adds the CSRF token and expected user and runs the same-user-only CSRF retry. Sends carry operation keys (contracts §4.1).
- **SSR seed.** The root loader and the protected layout loader each create a fresh `QueryClient` for the request (`makeQueryClient()`), fill it from internal services through `services.bootstrap` (the same DTO builders the API routes use, `server/services/bootstrap.ts`), and return `dehydrateAllowed(client)`. The layout loads the conversation list, preferences, models (2.5 s budget) and the URL's conversation concurrently. The server render uses a per-render client (`useState` in `root.tsx`); the browser has exactly one (`getBrowserQueryClient`).
- **Allowlist:** only successful `session`, `conversations`, `conversation`, `models` and `preferences` queries are dehydrated; never `generation`, never errors, never keys outside the factory.
- **No duplicate initial fetch:** hydrated data is fresh for 30 s (`STALE_TIME_MS`) and window-focus refetch is off. The root never revalidates (`shouldRevalidate`). After hydration the layout's `clientLoader` replaces its server loader: it checks the cached session, starts the secondary queries and awaits only the active conversation, so React Router keeps no second loader cache.
- **Account boundary:** `applySession` (`app/lib/session.ts`) moves the adapter's identity and the session query together; a different user purges every `["u", …]` query. Logout and `chatui:account-changed` purge the cache, clear drafts and go to sign-in.

### Generation observation and rendering (INV-06, INV-32)

- The observer (`useGenerationObserver`) is mounted by the chat controller for the displayed conversation's active generation, independent of the component that shows it. It writes `snapshot`/`resync`/`state`/`delta`/`terminal` into the `generation` query. Closing it never cancels.
- `LiveReply` is the only subscriber to deltas. Stored messages (`Message`, memoized), the transcript list, sidebar, header and composer do not re-render on tokens (`tests/client/render-isolation.test.tsx` counts renders and mounts).
- A live reply renders only for its own conversation (the generation records `conversationId`) and until the stored copy with the same assistant id is in the transcript.
- Terminal events invalidate the conversation and the list; the stored message replaces the live one in place.

### Markdown (INV-22)

- `app/chat/markdown.tsx`: `react-markdown` + `remark-gfm`, no `rehype-raw`, so raw HTML in model output is escaped text.
- URLs go through `safeUrl`: react-markdown's filter plus an allowlist of `http:`, `https:` and `mailto:`. A link with any other scheme is shown unlinked. Links open with `rel="noopener noreferrer"`.
- Images are never loaded (CSP `img-src 'self'`); their alt text is shown as a link.
- Code blocks have a language label, Copy, and scroll horizontally inside the block; tables scroll inside a wrapper. Syntax highlighting and math are Phase 14.
- Unfinished fences, tables, lists and emphasis render at every prefix (tests stream them chunk by chunk). Rendering never changes stored Markdown.

### Scroll intent

- `app/chat/scroll-intent.ts` is a pure state machine (`pinned`, `hasNew`) plus a hook. Only user scrolls change pinning: positions the code scrolls to are recorded, and their scroll events are ignored. Content growth (a `ResizeObserver` on the thread) follows only while pinned; otherwise it raises "Jump to latest". Sending re-pins.
- Opening a chat starts at its latest message without a jump: the server HTML carries a nonce'd one-line script after the transcript that scrolls it before first paint, and client navigations do the same in a layout effect.

### Interactive primitives: decision record (INV-47)

| Control                                 | Choice                                                                                | Why                                                                                | Bundle                                     | SSR / hydration                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| Menus (chat row, chat options, profile) | Radix DropdownMenu (`app/ui/menu.tsx`)                                                | Roving focus, typeahead, Escape, focus return, collision-aware portal positioning  | One shared package with the model selector | Trigger renders on the server; content only when open, in a portal |
| Model selector                          | Radix DropdownMenu radio groups, one per provider (`app/chat/model-picker.tsx`)       | Grouped, checkable single choice; same keyboard model as other menus               | Shared                                     | Server renders the trigger with the selected model's name          |
| Dialogs (rename, Settings, admin)       | Radix Dialog (`app/ui/dialog.tsx`)                                                    | Focus trap, inert background, Escape, focus restoration                            | ~1 package                                 | Overlays open from the URL render on the server as open dialogs    |
| Confirmations                           | Radix AlertDialog (`ConfirmProvider`)                                                 | `alertdialog` role, Cancel gets initial focus; replaces `window.confirm`           | Shares Dialog's internals                  | Client only                                                        |
| Tooltips                                | Radix Tooltip (`app/ui/tooltip.tsx`)                                                  | Hover and keyboard focus; supplementary only, every trigger has an accessible name | Small                                      | Client only                                                        |
| Desktop sidebar collapse                | Native button + CSS, cookie `chatui_sidebar`                                          | No widget semantics needed                                                         | 0                                          | Server renders the collapsed state, so there is no flash           |
| Narrow-window sidebar                   | Native overlay + backdrop (interim); Radix Dialog drawer planned for Phase 11         | Phone layout is Phase 11                                                           | 0                                          | Client only                                                        |
| Toasts                                  | Native: one polite `role="status"` and one `role="alert"` region (`app/ui/toast.tsx`) | Announce without taking focus; no queue features needed                            | 0                                          | Client only                                                        |
| Composer                                | Native `<textarea>` (contracts §13)                                                   | IME, pre-hydration typing, mobile keyboards                                        | 0                                          | Uncontrolled; server-rendered                                      |

- A dialog opened from a menu item returns focus to that menu's trigger: the item records its trigger and the dialog claims it on open (`claimMenuOpener`).
- Every control is styled only through semantic tokens; there is no styled component suite.
- Verified in `tests/e2e/chat-ui.spec.ts`: keyboard open, arrow focus, Escape and focus return for the model menu; focus trap, Escape and focus return for the rename dialog; ARIA snapshot of the open menu.
- **Phase 15 audit** (`docs/primitives-audit.md`): every surface checked by axe-core (WCAG 2.2 A/AA) and keyboard, nesting, route-change and residue tests. No primitive was replaced; eight defects were fixed in place. Controlled dialogs return focus to the menu trigger or to the element that had focus when they opened, recorded in a layout effect before Radix moves focus.

### Composer (Phase 15, INV-48)

- The native `<textarea>` stays; a rich editor is out of scope until a structured-input requirement is approved.
- **Think:** a pill next to + (`aria-pressed`, on by default, kept for the tab), shown when the selected model has the `reasoning` capability. Sends and regenerations carry `think`; the server keeps it only for reasoning models and sends `chat_template_kwargs.enable_thinking` (UNVERIFIED, `docs/provider-notes.md`). It is part of the payload hash only when present, so older operation records keep their hash.
- **Dictation** (`app/chat/dictation.ts`): the browser's `SpeechRecognition`, offered only where it exists; finished phrases go in at the caret. The first use says the browser may send the audio to its vendor; ChatUI never receives audio.
- **Rich paste** (`app/chat/html-to-markdown.ts`): clipboard HTML with structure (headings, emphasis, links, lists, quotes, code, tables) is read from an inert DOMParser document and inserted as Markdown through the editing commands, so Undo removes it. Unstructured HTML, code-editor copies and anything over 1 MB paste as plain text.

### Chrome, selection and shortcuts

- Chrome is not selectable (`user-select: none` on the body). Messages, code, inputs and Settings values opt back in with `.selectable`. Ctrl/⌘+A outside a field selects only the conversation.
- Shortcuts: Ctrl/⌘+Shift+O (new chat) and Ctrl/⌘+Shift+S (sidebar), listed in Settings → Keyboard shortcuts.
- Time separators ("Today 3:06 PM") are rendered on the server in the browser's locale and time zone, taken from validated hint cookies (`chatui_tz`, `chatui_locale`; else UTC and `Accept-Language`). Hydration starts from the server's values, and the browser updates the cookies for the next document.

### Slash commands (reference UI)

- Typing `/` (optionally followed by a filter) as the whole composer text opens a listbox above the composer, as wide as it. The textarea keeps focus and its textbox role (a textarea cannot take the combobox role): `aria-controls` names the list and `aria-activedescendant` the active option while it is open. Arrows move, Enter or Tab runs, → opens the model list, ← goes back, and Escape hides the menu until the text changes.
- Commands: **Model** (opens the model list, with a check on the current model and "Not loaded" notes), **Read aloud** (the last reply, where speech is supported), **Rename chat** and **New chat** (inside a chat). A chosen command clears the slash.

### Visual tokens and measurement audit

- `app/styles/tokens.css` holds the measured values from the rebuild plan (§5–7): the system font stack, the type scale, the layout sizes and the light/dark colours. Components use only these custom properties. The accent is the plan's **orange** option (`#f26b1d` light, `#c85512` dark), with the user bubble mixed from it by the plan's formula.
- `tests/e2e/measurements.spec.ts` compares computed sizes and colours of the shell, transcript, composer, suggestions, menus, dialogs, code blocks and tables at 1920×1080 against `tests/e2e/measurements.json`, in light and dark. Later phases keep it green; a changed value needs a reason in that phase's report.

### Performance (Phase 9)

- **No migration.** The Phase 1 Framework Mode SSR, the Phase 4 authenticated documents and the Phase 7 per-request Query dehydration are unchanged. Phase 9 measured and trimmed them.
- **Bundle boundaries.**
  - The critical chat route is entry + root + protected layout + chat route module, measured from `build/client/.vite/manifest.json` (static imports and linked CSS).
  - Settings, admin, login, register and status are separate route chunks.
  - KaTeX and highlight.js are dynamic imports (Phase 14).
  - Browser code imports runtime helpers only from schema-free shared modules (`@shared/generation-state`). Importing them from `@shared/generations` had pulled Zod into the client: removing it cut 24 KB gzip.
- **Budget** (`performance-budget.json`, `scripts/perf-check.ts`, `npm run perf:check`, part of `verify` and so of CI): gzip-9 bytes per route and category, with a 10 % tolerance. It is offline and deterministic. Raising a budget needs a reason in a phase report. The sign-in route must not load the chat layout chunk.
- **Intent prefetch** (`app/lib/prefetch.ts`, INV-31):
  - Mouse hover or keyboard focus on a sidebar row prefetches that conversation after 120 ms, through the same query definition navigation uses, so the click reuses it.
  - Touch never prefetches. At most two speculative fetches run at once. Leaving cancels a pending or unobserved fetch.
  - `storeConversation` cancels in-flight fetches before writing, so a late prefetch can't overwrite newer data (INV-23).
- **Marks** (`app/lib/perf.ts`, contracts §9.5):
  - Marks: `navigation-start` (time 0), `shell-painted` (first contentful paint), `hydration-complete`, `composer-interactive` (hydrated and a server-valid model known), `conversation-visible`, `generation-accepted`, `first-assistant-event` and `generation-complete`.
  - Each fires once (generation marks once per generation id). Marks carry only timestamps and an opaque generation id.
  - `window.__chatuiPerf()` summarises them, including ComposerTTI and FirstAssistantEvent. Nothing is sent anywhere.
- **Caching and assets:** content-hashed assets are `immutable` for a year; documents are `private, no-store`. Assets are first-party, the font stack is the system one, and no service worker is registered (verify checks all of these, INV-33).
- **Transcript:** normal document flow, no virtualization (contracts §9.2). Render probes show tokens don't re-render or remount unrelated UI (INV-32), and find-in-page reaches old messages.
- **Prompt prefix:** a test asserts that, unless the truncation window moves, each prompt starts with the previous prompt's messages, so a local provider reprocesses only the new turn.

### Response rendering (Phase 14)

- **One renderer, separate concerns** (`app/chat/markdown.tsx`, `app/chat/render/`): GFM Markdown with no raw HTML, math, highlighted read-only code and tables. Nothing executes model content.
- **Math** (`render/math.tsx`):
  - `remark-math`, rendered by KaTeX with `output: "mathml"`. The browser draws native MathML, so there are no KaTeX fonts or CSS and no CSP change. The semantic markup keeps the TeX in an annotation.
  - `trust` is off and `maxSize`/`maxExpand` are bounded, so `\href` and `\url` never link. Malformed math throws and shows inert source.
  - Display math has Copy LaTeX.
  - Display-only normalisation outside code fences: a whole line of `\[…\]` becomes a display block, and `\(…\)` inline. Inline math that starts with an amount ("$5 and $10") stays text.
- **Code** (`render/code.tsx`): highlight.js `lib/common`. Its output escapes the source and adds only `hljs-*` spans. Unknown languages, and the moment before the chunk arrives, show plain preformatted text. Syntax colours are tokens (plan §7, light and dark).
- **Tables** (`render/table.tsx`): Copy as tab-separated text (pastes into spreadsheets as cells) and Expand (dialog). Tools show on hover/focus, and always on phones.
- **Read aloud** (`app/chat/read-aloud.ts`): the browser's `speechSynthesis`, offered only where it exists (INV-52), one reply at a time, with Markdown and code stripped from the spoken text.
- **Lazy and first-party.** KaTeX and highlight.js are dynamic imports (`render/lazy.ts`), requested only when content needs them. The server and hydration render the plain fallback, so they agree. `verify` checks that neither library is in the chat page's initial JavaScript.
- **Streaming stability (INV-46).** Unfinished fences, tables, lists and math render at every prefix (tests stream them). Scroll intent counts a scroll as the reader's only right after wheel, touch, pointer or scroll-key input, so scroll anchoring or a late-loading renderer changing heights above never unpins the reader.

### Mobile (Phase 11)

- **Device, not width.** The root loader marks phones (`isPhone`: `Sec-CH-UA-Mobile: ?1` or a phone user agent; iPads and tablets excluded) and `root.tsx` renders `<html data-phone>`, so the phone layout is decided before paint. A sideways phone keeps it; a narrow desktop window doesn't get it.
- **Phone layout** (`app/styles/phone.css`), following plan §6:
  - The sidebar becomes a 260 px drawer.
  - The header is solid and has no title: menu button left, New chat next to it (never on the draft).
  - The thread has 16 px gutters.
  - The composer always has two rows (text above; `+` and send below).
  - On the new-chat screen the greeting is centred and the suggestions sit above the composer.
  - Dialogs are bottom sheets; Settings is full screen with 20 px gutters.
  - `env(safe-area-inset-*)` is honoured.
- **Narrow desktop windows** (≤ 767 px): the same drawer, the title hidden; otherwise the desktop layout.
- **Drawer** (`app/chat/drawer.tsx`): a Radix Dialog holding the sidebar, with:
  - a focus trap and an inert background
  - Escape and backdrop dismissal
  - focus returned to the menu button
  - closing on navigation
- **Keyboard and viewport.** The viewport meta has `interactive-widget=resizes-content` and `viewport-fit=cover`, and the shell is `100dvh`, so the on-screen keyboard shrinks the layout and the composer stays visible with no JavaScript measuring. A `ResizeObserver` on the transcript keeps a pinned reader at the bottom through resizes, which never count as user scrolling.
- **Touch.**
  - Controls are 44 × 44 to the finger: rows and menu items are 44 px tall on phones. Icon buttons keep their 36 px look with a 44 px hit area (`::after`), spaced 8 px apart so the areas don't overlap.
  - Row menus are always visible (no hover).
  - Tooltips never show on phones.
  - Wide code and tables scroll inside themselves; the page never scrolls sideways.

### Loading and resilience (Phase 8)

- **Startup dependency graph.** All of these start concurrently in the document request (a unit test asserts that every load starts before the first one ends):
  - **Critical:** the session (root loader), the URL's conversation, preferences, and models (2.5 s discovery budget).
  - **Secondary:** the conversation list. It has a 300 ms budget, so a slow list can never hold the shell or composer; the browser fetches it after hydration.
  - Server-side QueryClients never retry, so a document never waits out a retry delay.
  - After hydration the layout's `clientLoader` awaits only the target conversation.
- **Auth state.** Identity is known before any private byte (SSR), so there is no `unknown` flash: the server sends either the authenticated shell or a redirect. After hydration the session query is authoritative.
- **Request lifecycle (INV-23).**
  - TanStack Query dedupes identical in-flight requests, cancels superseded refetches and keys every conversation by id, so a late response for chat A can't render in chat B.
  - Mutation responses go through `storeConversation`, which never replaces a newer cached version (`updatedAt`).
  - Model choice is local state.
- **Optimistic sends.**
  - The message appears at once as "Sending…" with its operation key.
  - Any contract error except `INTERNAL` rolls it back and restores the draft.
  - A network error, no response or a bare 5xx resends with the same key (bounded).
  - `OPERATION_EXPIRED` or exhausted retries mark it "Not sure this was sent", with a "Check the conversation" action. A new key is never minted for it.
- **Session expiry.**
  - Triggers: the shared adapter reports the first 401 for the signed-in user (`SESSION_EXPIRED_EVENT`, once per session). A stream that closes without a terminal event probes `/api/auth/session`.
  - The shell purges user-scoped queries and replaces the chat surfaces with an in-app dialog; there is no document navigation.
  - Drafts stay in tab memory (`draftStore`, keyed by user). Re-signing in as the same user restores them. "Use another account", a different identity, logout or reload discards them. They are never written to browser storage.
- **Error boundaries:**
  - the protected layout's route `ErrorBoundary` (shell level, Retry revalidates)
  - `app/ui/error-boundary.tsx` around the sidebar and the transcript (Retry re-renders and refetches)
- **Empty states:**
  - no chats (sidebar)
  - no models ("An admin needs to add a model server")
  - every provider unreachable
  - each with Try again
- **Chat switching:** navigations longer than 250 ms show a small spinner over the transcript; the previous chat stays visible until the next one is ready.

### Appearance and settings (Phase 7b)

- **Appearance** (`app/lib/appearance.ts`): theme (light by default, dark, system), accent (six options, orange by default), interface text size 12–18 (14 reference), code text size 11–16 (12 default) and reduce motion. One validated cookie, `chatui_appearance` (`theme.accent.ui.code.motion`), is read by the root loader. `root.tsx` renders it as `<html data-theme data-accent data-ui-size data-code-size data-motion>`, so the first paint is right without a bootstrap script. Changes apply immediately by setting those attributes and the cookie; invalid values fall back field by field.
- **Tokens:** `app/styles/themes.css` swaps the token values per attribute. Accent bubbles follow the plan formula. The interface size zooms the body (CSS `zoom`); the shell height compensates. Code sizes set `--text-code`/`--lh-code`. `data-motion="reduce"` removes transitions in addition to `prefers-reduced-motion`.
- **Settings registry** (`app/settings/`): each section is data (`SettingsSection` of `SettingsRow`s with label and keywords), so later phases add sections in one place. The Settings overlay searches rows across all sections. Sections: General, Appearance, Account, Keyboard shortcuts. Value pickers with a fixed short list use native `<select>`, radio groups and a `role="switch"` checkbox (added to the decision record).
- **Layout** follows the owner's reference screenshot: conversation title in the header (the model menu shows only on the draft), the model choice in the composer's `+` menu (Phase 12 adds attachments there), the disclaimer above the composer, and the profile row with the name only.
- **Pages:** sign-in and sign-up (registration closed → "Ask an admin to create one"), the status page and the root error document share one centred card style.
- **Demo:** `npm run demo` (`scripts/demo.ts`) builds if needed, seeds `./demo-data` once (accounts `demo` admin and `demo2`, sample chats as canonical Markdown), starts the mock model limited to friendly models and serves the production build on port 3000.

### E2E suite

`npm run test:e2e` seeds two accounts and a 200-message conversation (written as canonical Markdown before the server starts) and signs in once, reusing the session (logins are rate-limited per address). Suites:

- `routing.spec.ts`: INV-53 cases and the duplicate-fetch check
- `chat-ui.spec.ts`: independent transcript scroll, find-in-page, scroll intent while streaming Markdown, sidebar collapse, portal menus, Ctrl+A, INV-47, rename/delete
- `streaming.spec.ts`: reload, network drop, cancel, reply stays in its own chat
- `measurements.spec.ts`: the visual audit

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

A send carries a fresh operation key and resends with the same key on network errors or `INTERNAL` (bounded), then reports an unknown outcome. The running generation comes from the conversation DTO's `activeGeneration`, so reloads re-observe it. The interface itself is described in "Chat interface (Phase 7a)".

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

- Each route declares `auth: "public" | "user" | "admin"` and `csrf: "none" | "token" | "origin"`.
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
- Pages: `/login` (validated `returnTo`: only `/chat/new`, `/chat/<uuid>`, `/settings[/<section>]` and `/admin`; anything else → `/chat/new`), `/register` (404 when closed). Password change and log out live in Settings (`/account` redirects to `/settings/account`).

### Authenticated SSR (INV-54, INV-55, INV-57)

- An Express middleware resolves the real session for **every document request** before the React Router handler; the result is passed per request through the router context (`appContext.auth`) and is never module-global.
- The protected layout (`app/routes/app-layout.tsx`) redirects signed-out requests to `/login?returnTo=…` (302) before reading anything; every protected route, including the catch-all, is a child of it. `/chat/<id>` loads only the signed-in user's conversation; another user's id renders "does not exist" with HTTP 404 and no metadata.
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

## Administration (Phase 10)

### Authorization (INV-24, INV-26)

- Admin routes declare `auth: "admin"` in the registry. The guard reads the role from the account record loaded for this request (not from the session), so a demotion takes effect on the next request. A non-admin gets `403 FORBIDDEN`; no session gets `401`. The check runs before validation and the handler, and the registry tests enumerate every admin route.
- The `/admin/:section?` route chunk loads lazily. Its loader returns the same 404 as an unknown page for non-admins, and chat startup never imports admin code or calls admin APIs (`tests/e2e/admin.spec.ts`).
- Last admin: demoting, disabling or deleting the last active admin (including oneself) fails with `409 LAST_ADMIN`; the count runs under the users lock. Reducing an account (demote, disable, password set) revokes its sessions and cancels its generations.

### Settings (`server/admin/settings.ts`)

- `_system/settings.json` is canonical, written atomically under one lock, and re-read at startup; persisted admin edits win over the environment. It holds the registration-mode override, default model, notice, an output-token cap (never above `MAX_OUTPUT_TOKENS`), the instance time zone and per-model entries (hidden, sampling, system prompt).
- Its revision (SHA-256 of the bytes) is a prompt-relevant revision: send acceptance rechecks it under the conversation lock (contracts §4.1).
- **Hidden models** are left out of `/api/models` for members and give `MODEL_NOT_FOUND` on send; admins still see and use them.
- **System prompts** allow only `{{username}}`, `{{date}}`, `{{timezone}}` and `{{time}}` (validated on save) and are expanded once, in a single pass. `{{time}}` never enters the system prefix: it becomes a short context line before the newest user message, so the prompt prefix stays reusable between turns.
- **Sampling** (temperature, top_p, top_k, min_p, repeat_penalty) is range-checked and sent to the provider per request.
- `GET /api/instance` gives every signed-in user the notice and default model. The notice is a dismissable banner; dismissal is a cookie holding the notice hash, so the server render hides it too. The instance default comes after the user's own default model.

### Providers (INV-19, INV-25)

- Provider CRUD writes `_system/providers.json` and reloads providers in process; in-flight generations keep their provider object.
- Every create, edit and test runs the full SSRF policy, including DNS resolution (`resolveChecked`), so a hostname resolving to a metadata or link-local address is rejected (`400 ENDPOINT_NOT_ALLOWED`).
- API keys are write-only: DTOs carry `hasApiKey`, an edit without a key keeps the stored one, and a test sweep checks every response, header and log line for the configured secret.

### Account closure (INV-61)

1. Mark the account `closing`; sign-in and every request for it fail from then on.
2. Revoke its sessions (closing its streams), cancel its generations and wait for them to drain.
3. Rename the account directory into `_system/deleting/`, then remove it and its index entries.

A crash at any step leaves a `closing` record or a `deleting` entry that `recoverClosures()` completes before the server is ready. Writers create directories with `ensureDirUnder(accountRoot, dir)`, which throws `AccountGoneError` instead of recreating a removed account root, and `persistOutcome` skips closing accounts. Deletion from the UI requires typing the username.

### Audit log (`server/admin/audit.ts`)

Admin actions append one JSON line to `_system/audit/YYYY-MM.jsonl`: `{at, actor, action, target, outcome, detail}`. Lines never contain passwords, keys or message content. The Audit section reads the newest entries of a month.

### Maintenance

- `POST /api/admin/maintenance/rebuild-index` rebuilds one account's derived index, or all of them.
- `npm run user:reset-password -- --username <name>` reads the new password from stdin and revokes the account's sessions: recovery when no admin can sign in.

## Attachments (Phase 12)

### Storage and lifecycle (contracts §1, §7, INV-28)

- `DATA_DIR/<user>/attachments/<attachment-uuid>/blob` and `meta.json` (`{version, id, ownerId, conversationId, messageId, filename, mediaType, kind, size, sha256, createdAt, width, height}`). The server mints the UUID; the filename is display metadata only. It has its last path segment kept and control/bidi characters removed. Browser-escaped `"`, CR and LF are restored to readable characters.
- **Upload** (`AttachmentStore.ingest`):
  1. Check the concurrency cap (`MAX_UPLOADS_PER_USER`, else `429`) and reserve quota from the request length (`QUOTA_EXCEEDED` before any byte is stored).
  2. Stream to `.blob.<random>.tmp` inside the attachment's own directory. The size limit is checked on every chunk, and the first byte over aborts with `413`.
  3. Sniff the type, `fsync`, rename to `blob`, and write `meta.json` last.

  Any failure removes the directory. A directory without `meta.json` is an incomplete upload and is removed at startup. Multipart parsing (`server/attachments/upload.ts`, busboy) accepts exactly one `file` part.

- **Linking** happens inside send acceptance (§4.1). Step 1 checks ownership and pending state. Step 3 rechecks them under the attachment locks, which come after the conversation lock (ascending ids). Step 4 then writes the user block with `attachments="…"` (format v1, unchanged), links each `meta.json`, and marks the operation committed. A rejected send leaves the attachments pending.
- **Recovery** (startup step 7, `reconcile`):
  - Pending attachments referenced by a persisted message are linked (a crash between the Markdown and the link).
  - Linked attachments whose conversation file is gone are removed (a crash between deleting the Markdown and its files). A malformed conversation counts as present.
  - Pending uploads older than `ATTACHMENT_PENDING_TTL` are removed. An hourly sweep repeats this, each one under its lock.
- **Deletion:** deleting a conversation removes its Markdown first, then its linked files. A pending upload can be deleted; a linked one is `409`. Account deletion removes everything with the directory.

### Types and serving (INV-27)

- **Accepted:** PNG, JPEG, WebP, GIF; WAV, MP3, FLAC; UTF-8 text with an allowed extension (plain text, Markdown, CSV/TSV, JSON, common source files).
- **Sniffing** (`sniff.ts`) checks magic bytes and structure: PNG IHDR and IEND, the JPEG start-of-frame, the WebP/WAV RIFF size, two consecutive MP3 frame headers, and FLAC STREAMINFO. A truncated or malformed file is `415`, and an image over `MAX_IMAGE_PIXELS` is `413`.
- **Hints:** the extension and the client's `Content-Type` are hints that must agree with the bytes. SVG, HTML and XML (even renamed to `.txt`), PDF, executables and unknown types are rejected.
- **Text** must be valid UTF-8 without NUL bytes.
- `GET /api/attachments/:id/content` sends:
  - the sniffed type, `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and `Cross-Origin-Resource-Policy: same-origin`;
  - `Cache-Control: private, no-cache` with an ETag;
  - `inline` only for the four raster image types (`?download=1` forces a download);
  - ranges for audio seeking.

  It is a registry `raw` route: errors are the JSON contract, never SSR HTML (INV-57, verify). Another user's attachment is a `404` everywhere.

### Prompts (contracts §4, §7, INV-44)

- `prepareExpansion` (`server/attachments/expand.ts`) turns user blocks into typed OpenAI-compatible parts:
  - text first (the body, then each text file inlined as a fenced block labelled with its name);
  - then `image_url` (data URL) and `input_audio` (`{data, format}`) parts.

  A message without media stays a plain string, so text-only prompts are byte-identical to before.

- Text files over `MAX_INLINE_TEXT_BYTES` are cut at a character boundary with a visible marker. The stored file is never changed.
- Images and audio in the **new** message need the server-verified modality (`422 MODEL_CAPABILITY_UNSUPPORTED` before anything is stored). **Earlier** media become a one-line text note when the model lacks the modality, when the user's `historyImages` preference is `omit` (images only), or beyond the `MAX_PROMPT_MEDIA_PARTS` most recent parts. Switching models therefore keeps working.
- A missing file is skipped with a warning log.
- Each media part counts `MEDIA_TOKEN_RESERVE` tokens in both counters; exact counting templates the text alone and adds the reserves.
- `historyImages` is a prompt-relevant revision, rechecked under the lock.

### Browser

- **Composer:** "Add photos and files" in the `+` menu opens the picker from the menu click (a genuine user activation); paste and drag-and-drop over the chat also attach.
- **Uploads:** each file uploads immediately (XHR for progress through `apiUpload`, with the same CSRF headers) into a per-draft store in tab memory (`composer-files.ts`).
- **Chips** show a preview (a `blob:` URL; `img-src` allows `blob:`), progress, errors and Remove, which cancels the upload or deletes the pending copy.
- **Sending** is blocked while a file uploads, fails, or needs a modality the selected model lacks; the model menu marks such models.
- **Downscaling:** images are shrunk in the browser to `imageMaxEdge` (default 2048 px, 0 = never) when that makes them smaller, which also drops EXIF metadata. The server still checks everything.
- **Account change** aborts uploads and forgets the files.
- **Transcript:** the conversation DTO carries attachment metadata (`missing: true` placeholders), never bytes. Thumbnails use stored dimensions (no layout shift) and `loading="lazy"`; audio uses `preload="none"`; text files are download chips.
- **Image viewer:** a separate lazy chunk with its own CSS. It supports zoom, pan, pinch, previous/next, swipe, download and Escape, and returns focus to the thumbnail. The next image replaces the current one only after it decodes, so there is no flash.
- **Tests:** `perf.spec.ts` and verify check that the viewer is not in the chat page's initial JS.

## Library and profile (Phase 12b)

### Library (`/library`)

- **Listing:** a page route (inside the shell, not an overlay) listing `GET /api/attachments`, the user's files with usage and limits.
- **Controls:** search, a type filter (All, Images, Audio, Documents), sort and view (list or grid) live in the URL query, so they survive reloads and Back. The list shows each file's chat (by title, from the cached conversation list); grid cards show image previews (lazy).
- **Library uploads:** "New" → Upload files posts to `/api/attachments?to=library`. These files are `saved`: they never expire (the pending TTL skips them), are never linked, and can't be sent in a message (`409`), so a saved file can't be deleted by deleting a chat. Attaching a Library file to a message is not supported yet.
- **Deletion:** a saved or pending file can be deleted (confirmation dialog). A file that belongs to a chat can't be deleted on its own, so a message never loses a file behind the user's back (contracts §7). Delete the chat instead; its menu offers Go to chat.
- **Viewer:** images open in the shared lazy viewer.

### Profile (`/profile`, `server/profile/`)

- **Storage:** `DATA_DIR/<user>/profile/profile.json` (`{version, photo: {mediaType, size, sha256, updatedAt} | null, shape}`) and `profile/photo`. Both are canonical, written under a per-user profile lock.
- **Photo upload:** the browser crops to a square (drag, zoom) and uploads a 512 × 512 JPEG with `PUT /api/profile/photo`. The server streams it with a 5 MB limit and sniffs the bytes (PNG, JPEG or WebP only; GIF and SVG are refused). It renames the photo into place, then writes the record. A failed upload keeps the previous photo.
- **Photo serving:** `GET /api/profile/photo?v=<version>` serves it inline with the sniffed type, `nosniff`, the sandbox CSP and `private, no-cache`.
- **Shapes:** circle, flower, rounded square, oval and cookie (`PATCH /api/profile`). Flower and cookie are same-origin SVG masks (`public/shapes/`); the others are CSS.
- **Rendering:** the profile DTO (`photoVersion`, `shape`) is dehydrated with every document, so the sidebar avatar is rendered by the server with no flash.
- **Statistics:** `GET /api/profile/stats?timeZone=` reads every conversation (`computeStats`, a pure function).
  - Chats, your messages, replies, files.
  - Current and longest streaks of calendar days in the user's time zone; the current streak survives a quiet today.
  - 53 weeks of daily counts, the busiest weekday and hour, and the most used model.
  - The result is cached per user until the index changes, the hour changes or another time zone is asked for. The page shows counts, an activity grid (it opens at the newest weeks on narrow screens) and insights.
- **Bundles:** Library and Profile are route chunks with their own CSS. The chat page loads neither; the shared photo-shape list is zod-free.

## Conversation operations (Phase 13a, contracts §4.2)

### Turn grammar (`server/chat/turns.ts`)

`analyzeTurns` reads the blocks as leading system blocks, then exchanges (one user block and its optional response: a reasoning block and its assistant block). A mid-conversation system block ends the open exchange and belongs to none. A response with no open user turn before it (a leading assistant, a second response after one user) is an **irregular region**: edit, delete and regenerate refuse to touch one (`422 VALIDATION`) and the file is left unchanged.

### Mutations (`server/chat/mutations.ts`, INV-35)

Every mutation runs under the conversation lock and checks, in order: the file exists (`404`), parses (`CONVERSATION_MALFORMED`), has no running reply (`GENERATION_IN_PROGRESS`) and is at the expected revision (`CONFLICT`).

- **Edit** keeps the user block's id and time, replaces its text (it may keep or drop its files, never add), and removes every later block. No reply starts; the browser chains a regenerate.
- **Delete exchange** removes exactly the user block and its response; system blocks and other exchanges stay.
- **Regenerate** (`SendService.regenerate`, `202`) contacts the provider first (`catalog.contact`), checks the model's capabilities against the turn's media, preflights the prompt up to the turn, then re-checks the revision under the lock and commits with fresh message ids. It is idempotent by operation key, like a send. A crash after its commit recovers like any interrupted reply.
- **Clear history** deletes every conversation (Markdown, then its files) and empties pins; memories and other preferences stay.
- Files of removed user turns are deleted after the Markdown write (contracts §7: a crash can leave an orphan, which startup reconciliation removes, never a dangling reference).

### Search (`server/chat/search.ts`, INV-36)

`GET /api/search?q=` reads only the caller's conversations, matches titles and message text case-insensitively, and returns at most 50 chats (first match as a 160-character snippet with the match offsets) and 20 files by name. Text is cached per user and file stamp. A malformed file is listed by title and never fails the search.

### Browser

- `ConversationOpsProvider` (`app/chat/conversation-ops.tsx`) holds edit, regenerate, delete and pin. Its callbacks are stable and read the latest state through a ref, so memoized messages don't re-render while a reply streams (INV-32). Actions that change history hide while a reply runs (`.thread[data-running] .needs-idle`).
- The search dialog is a lazy chunk (Ctrl/⌘+K, also from the body when nothing has focus). Opening a chat result passes `{query, messageId}` in the location state; `useSearchMarks` scrolls to the message and marks every match once with the CSS Custom Highlight API (no DOM changes).
- Pins live in preferences (INV-34). The sidebar shows a folding Pinned section in pin order and Recents without them; deleting a chat removes its pin.
- Settings and Administration are full-window pages (`app/settings/page-layout.tsx`): a navigation column (Back to chat, search, sections) beside a column of grouped cards.

## Memories and the shared tool loop (Phase 13b, D2)

### Contract amendment (D2, settled 2026-10-29)

Contracts §4.3 allowed one bounded continuation for memory proposals and no general tools. D2 replaces that with **one shared tool loop**, built once for memory proposals and the general tools:

- **Offer.** Tools are offered only to a provider whose `capabilities.tools` is `true` (configuration; see `docs/provider-notes.md`). Other models are unaffected.
- **Tools.** Read-only general tools that act only on the requesting user's data: `search_chats`, `read_chat`, `list_files`, `read_file` (text files), `get_current_time`, `calculate` (an interpreter, never `eval`). Proposal-only memory tools: `remember`, `update_memory`, `forget_memory`. `create_file` joins in 13c.
- **Rounds.** At most `MAX_TOOL_ROUNDS` (3) rounds of calls per generation, 8 calls per round, 16 per generation, 8 KB of arguments per call, 6,000 characters per result. The request after the last round offers no tools, so the loop always ends. Each follow-up gets only the remaining output tokens and time, and is skipped when its messages (plus the tool schemas, which count against the prompt budget) don't fit the context.
- **Degrade.** A provider that rejects the follow-up (`http` or context errors before any output) ends the reply `complete` with the text so far. Invalid calls (unknown tool, malformed or oversized arguments, unresolvable memory target, over a cap, incomplete) get a fixed result, are never run, and never change the terminal status.
- **Storage.** Tool-call and result messages exist only in generation memory; Markdown holds the visible text only (text before the calls and each follow-up joined by one blank line; reasoning likewise). The stored format gains one optional assistant attribute, `tools="name,name"` (1–16 distinct names matching `^[a-z][a-z0-9_]{0,31}$`, order of first use), shown as chips. Files without it parse as before; nothing is replayed on later turns.
- **Events.** SSE adds `tool` (`{callId, name, state}`) and `proposals` (non-actionable previews); the snapshot carries both; the terminal event lists actionable `proposalIds` only for a `completed` reply that was written.

### Memories (`server/storage/memories.ts`, contracts §12)

`memories/<uuid>.md` with front matter `formatVersion: 1`, `id`, `name`, `createdAt`, `updatedAt`, then the body. Names are 1–64 characters with no line breaks or controls, unique by NFC case-folding under the per-user memory-store lock. Each note is at most 2,000 characters; at most 200 notes and 100,000 characters in total. The revision is the SHA-256 of the file bytes; update and delete are conditional on it. The prompt includes whole notes in name-then-id order until `MEMORY_PROMPT_BUDGET` (6,000 characters); the rest are marked "Not used in replies" in Settings. The included notes are the generation's snapshot.

### Proposals (`server/storage/proposals.ts`, `server/memory/service.ts`)

- `proposals/<conversation-uuid>.json` holds valid and suppressed suggestions with provenance (generation, call index, source user and assistant ids, provider, model), the resolved target and its snapshot revision, a content hash, status `pending | accepted | rejected | invalid | suppressed`, a `stale` flag and an acceptance intent. At most 8 per generation and 200 per conversation.
- **Suppression.** A call whose operation, target and content hash match a pending, rejected or suppressed one in the conversation, or whose effect already matches the note, is `suppressed` (not shown).
- **Terminal sequence.** Staged suggestions ride in the `terminal-decided` checkpoint; the assistant block is written, then the suggestions idempotently by `(generationId, callIndex)`, all under the conversation lock then the sidecar lock. Recovery repeats this for a decided `completed` outcome and discards the staged suggestions of anything else.
- **Acceptance** (sidecar lock → memory-store lock): the change is planned against the snapshot revision (a changed or missing note marks the suggestion `stale` and returns `409`), recorded as an intent with the exact bytes and before/after hashes, applied atomically, then finalized. Accepting twice is idempotent. Startup step 6 and conversation deletion resolve intents: after-hash → finalize; before-hash → apply and finalize; anything else → stale, reported in the log.
- **Lifecycle.** Edit, regenerate and delete-exchange mark pending suggestions of removed turns `invalid`. Deleting a conversation resolves its intents, then deletes the Markdown, its files, the sidecar and its pin. Accepted notes are never rolled back.

### Browser

Saved replies show tool chips and suggestion cards (Save / Dismiss; "Saved to memory", "Dismissed", "No longer applies", or a stale note). A complete reply with no text but suggestions says "The answer was not generated" and keeps Regenerate. The live reply shows tool chips as calls run. Settings → Memory lists, adds, edits and deletes notes.

## Source artifacts (Phase 13c, INV-40, INV-41)

### Capture convention

A reply's files come from two sources, in this order, with consecutive capture indexes and at most 8 per reply:

1. `create_file` calls (the D2 tool loop; `filename` and `content`), staged by the tool session.
2. Fenced blocks whose info string carries `file=<name>` (for example ` ```ts file=hello.ts `, or `file="two words.md"`), parsed from the reply's visible text when it completes. Unclosed fences and other fenced blocks are never captured.

Names are 1–100 characters (`[A-Za-z0-9][A-Za-z0-9._ -]*`, no `..`, no separators) with a supported text extension (`txt md json csv html css js mjs ts tsx jsx py svg xml yaml yml toml ini sh sql java c h cpp go rs rb php`). Each file is at most 512 KB and a user's files at most 50 MB together; captures over a cap are skipped. There is no upload endpoint for artifacts.

### Storage and the terminal sequence

- `artifacts/<id>/{blob,meta.json}`. The id is server-minted and deterministic for the capture key (a UUID-shaped SHA-256 of user, assistant message id and capture index), so recovery finds what it created.
- Only a `completed` outcome stages captures; they ride in the `terminal-decided` checkpoint. Under the conversation lock the sequence is: assistant block → proposals → captures (bytes, then unfinalized metadata; an existing key is kept) → finalization → `terminal` checkpoint.
- Recovery repeats it only from a decided checkpoint and never scans old replies. Startup removes artifact directories without metadata.
- Only finalized artifacts are listed, served or deletable, so a user can never delete one that recovery could recreate. Once the checkpoint is `terminal` (or evicted), a deleted artifact never returns.
- Artifacts survive their chat's deletion (the backlink shows "Its chat was deleted"); account deletion removes them with the user directory.

### Serving and browser

- `GET /api/artifacts` and `/api/artifacts/:id` (metadata with `conversationAvailable`); `GET /api/artifacts/:id/source[?download=1]` as inert text; `DELETE /api/artifacts/:id`. Another account's id is a 404.
- Replies list their files as cards. A card opens the lazily loaded source panel (its own JS and CSS chunk; cold and warm open times are measured in `tests/e2e/perf.spec.ts`), which shows the text highlighted with Copy, Download and a link to the chat. The Library's "From replies" view lists, opens, downloads and deletes them.

### Import representation (for Phase 13d)

A portable archive holds each artifact as `artifacts/<id>/meta.json` (the fields above, `finalized: true`) plus `artifacts/<id>/blob`, with the blob's SHA-256 in the manifest. On import the importer re-validates the name, type, size and checksum, mints a new id from the importing user and the original capture key, keeps the backlink only if that conversation is imported too, and writes bytes before finalized metadata. An existing id is never overwritten.

## Export and import (Phase 13d, INV-42, INV-43)

### Single-chat export

`GET /api/conversations/:id/export` returns the file's exact bytes (`text/markdown`, attachment disposition), including a malformed file as it is; nothing is parsed and reserialized. It carries no attached files or files from replies; the archive does. The chat header's Share menu offers it ("Download as Markdown") and "Copy as text".

### The export barrier

`KeyedLocks` takes a per-user barrier before any user-scoped lock (`conversation`, `preferences`, `memories`, `proposals`, `attachment`, `artifact`, `operations`, `profile`, `import`). Canonical mutations hold it shared; it is re-entrant within one async context (AsyncLocalStorage), so nested locks never wait on it. The export holds it exclusively and is writer-first: new shared holders wait, existing ones drain.

### Portable archive (`GET /api/export`)

A ZIP (`server/portability/zip.ts`, deflate, UTF-8 names) with:

```text
manifest.json                       format "chatui-archive", version 1, exportedAt,
                                    entries [{path, size, sha256}], conversations [{id, malformed, activeGeneration}]
chats/<id>.md                       exact bytes
attachments/<id>/{meta.json,blob}   linked and Library files (pending uploads excluded)
artifacts/<id>/{meta.json,blob}     finalized files from replies
memories/<id>.md
proposals/<conversation-id>.json    all statuses
preferences.json
```

- **Snapshot.** The small files are read while the barrier is held exclusively, and each blob's size and SHA-256 are recorded from its metadata. Then the barrier is released, the blobs are copied and verified, and a changed or missing blob fails the export with a retryable `409`.
- **Running replies.** A chat whose reply is running is exported as accepted (the user block) and marked.
- **Excluded.** Accounts, sessions, providers, instance settings, audit, checkpoints, operation records, staging and derived indexes are never included.
- **Building.** The archive is built in `import-staging/export-*.zip`, streamed, then deleted.

### Import (`POST /api/import` → preview, `POST /api/import/:id/commit`, `DELETE /api/import/:id`)

- **Staging.** The upload streams into `<user>/import-staging/upload-*.zip` (bounded), then moves to `import-staging/<importId>/archive.zip`. The destination is always the session's user; archive owner ids never choose a path.
- **Preflight.** Before anything is written:
  - the ZIP rules (INV-42);
  - the manifest must list exactly the archive's files, each with a matching size and SHA-256;
  - only known paths are accepted;
  - every attachment, artifact, memory and sidecar is parsed and validated.

  The preview reports new, present (identical) and conflicting items, malformed chats, memories with their status, skipped items and the idempotency key (SHA-256 of the sorted `path:sha256` list). It also flags whether that key was imported before (`import-staging/imported.json`, last 100).

- **Plan** (repeated at commit against the current data):
  - **Matching.** Items match by original id: identical → skipped as present; different → conflict, skipped by default or imported as a copy with a new id. Nothing is overwritten.
  - **Attachments.** Attachments follow their chat. A taken id, or a copied chat, gives the attachment a new id, and the chat's Markdown is rewritten through parse/serialize (reported).
  - **Malformed chats.** A malformed chat is imported raw only when nothing about it needs a new id; otherwise it is skipped.
  - **Memories.** Imported only when selected. Names stay unique by the NFC case-folded rule, so a copy that would duplicate a name is skipped.
  - **Artifacts.** Artifacts are independent: a skipped chat leaves a dead backlink (the nil UUID).
  - **Suggestions.** Suggestions follow their chat. Unresolved ones, or ones whose target memory isn't imported, become `invalid`; nothing is auto-approved.
  - **Preferences.** Pins of imported chats merge in. Default model and image options change only if the user chooses.
- **Commit.** The commit holds the barrier shared (the `import:<user>` lock) and checks the storage quota and that no target exists. It writes `journal.json` listing every file it will create (plus the previous `preferences.json`), creates them, merges preferences, marks the journal `committed`, rebuilds the chat index and removes the staging directory.
- **Recovery** (contracts §2 step 3):
  - a `committing` journal is rolled back (created files and directories removed, preferences restored);
  - a `committed` one is only cleaned up;
  - export and upload temp files go;
  - staged archives older than 24 h go.

  Account deletion removes staging with the user directory; Phase 16's backup must run recovery first.

- **Bounds** (`DEFAULT_IMPORT_LIMITS`):
  - archive 2 GiB;
  - 50,000 entries, 100 MiB per entry, 4 GiB expanded in total;
  - ratio 100:1 for entries over 1 MB;
  - path depth 3;
  - 10 minutes per preview or commit.
- **Browser.** Settings → Data controls has Export (a download link), Import (file picker → lazily loaded dialog with upload progress, cancel, conflict choice, memory selection, settings choice, confirmation and a report) and Delete all chats. Only the user's own query keys are refreshed after a commit.

## Temporary chats (Phase 13f)

- **Registry.** `<user>/temporary.json` (`{version: 1, chats: {id: createdAtMs}}`, `server/storage/temporary.ts`) lists temporary chats. It is canonical per-user state behind the `temporary:<user>` lock (so the export barrier applies), loaded at startup before recovery, and kept in memory. The chats are ordinary Markdown in `chats/`.
- **Creation.** `temporary: true` on a send without `conversationId` (anything else is `400`). The id is registered under the conversation lock before the first write, so the chat is never listed. The flag is part of the payload hash.
- **Left out of:**
  - the conversation list (`conversationSummaries`);
  - search (chats and their files);
  - the Library listing;
  - exports (chats, their files and sidecars);
  - memory: no memory section in the prompt; the tool loop offers general tools only, so no memory suggestions and no `create_file`, and a call to an unoffered tool is invalid;
  - files from replies: no capture, in the terminal sequence or in recovery.
- **Deletion.**
  - The browser deletes a temporary chat when you leave it (another chat, New chat, or `pagehide` with `fetch(..., {keepalive: true})`), decided by comparing the previous and current chat rather than in an effect cleanup, which Strict Mode runs on mount.
  - Deletion follows the normal order and also removes the registry entry.
  - A chat left open (closed tab, crash) is deleted by the sweep once it is 24 h old, at startup and hourly.
- **Browser.** A "Temporary chat" toggle on the new-chat screen (with an explanation instead of the greeting); a "Temporary" badge in the header; no Pin.

## Projects (Phase 13g)

- **Storage.** Projects are user-owned organization, like pins, so they live in `preferences.json`: `projects` (`[{id, name, createdAt}]`, display order, at most 100) and `chatProjects` (conversation id → project id; a chat is in at most one). The sanitizer drops placements that point to unknown projects. They are dehydrated with the preferences, so the sidebar renders on the server.
- **Endpoints** (`server/chat/projects.ts`, `server/routes/projects.ts`), each answering with the updated preferences:
  - `POST /api/projects`;
  - `PATCH /api/projects/:id`;
  - `DELETE /api/projects/:id` (its chats stay, out of any project);
  - `PUT /api/conversations/:id/project` (`{projectId | null}`; temporary chats are refused).

  Names are one line of 1–60 characters, unique by NFC case-folding. `PATCH /api/preferences` can't change projects.

- **Lifecycle.** Deleting a chat removes its placement, as it does its pin (`PreferencesStore.removePins`).
- **Portability.** The archive carries them in `preferences.json`. Import adds projects whose id is new (a clashing name gets " (imported)") and keeps the placement of imported chats; existing projects and placements are never changed.
- **Browser.**
  - A folding Projects section in the sidebar with "New project" and folder rows. Each row folds open to its chats and opens automatically when it holds the open chat; its menu has Rename and Delete.
  - Recents leaves out chats that are in a project.
  - "Move to project…" in the chat row menu, the chat header menu and the `/` menu opens a dialog listing projects, "New project…" (create and move) and "Remove from project".

## Intelligent UI, reasoning label and reply actions (Phase 14b)

### Interactive blocks (`docs/threat-model-14b.md`, D3)

- A fenced block with the info string `ui` is parsed by `app/chat/ui/parse.ts` into nine allowlisted node types: callout, card, text, steps/list, tabs, stats, chart, quiz, progress, divider. Two input forms are accepted: statement form (one statement per line, children indented) and JSON form (validated into the same tree).
- **Never evaluated.** No `eval`, `Function`, HTML or template engine is involved. Every string is a React text node. No styles, URLs, images, links or text fields come from the block. Tones are an enum and chart geometry is ChatUI's own.
- **Bounds:** 20,000 characters of source, 300 nodes, depth 4, 1,000 characters per string, 12 tabs, 8 quiz options, 40 chart points, 24 stats. Over a bound, or unreadable, the block shows as code.
- **Streaming.** While a reply streams only finished lines are parsed, and half-written JSON is "not ready" (shown as code).
- **Rendering.** The renderer (`app/chat/ui/blocks.tsx`, with its own JS and CSS chunk) loads only when a reply contains a block; until then, and during SSR, the source shows as code. Each block sits in a labelled frame with `overflow: hidden` and `contain: content`. Interaction (tabs with arrow keys, quiz answers) stays in component state.
- **Setting.** Settings → Appearance → "Interactive blocks" (`preferences.uiBlocks`, on by default) turns rendering off. The stored Markdown is never changed.

### "Thought for …"

The manager records when the first reasoning and the first answer text arrive. The assistant block stores the difference in the optional attribute `thought=<ms>` (an unquoted whole number up to a day; a format amendment like `tools`; recovery writes it from the decided checkpoint). The DTO's `thoughtMs` gives the reasoning label "Thought for 12s" (or "Thought" when not recorded). While streaming the label reads "Thinking…" and then "Thought".

### Reply actions

Copy, Good/Bad response (`aria-pressed` toggles), Share reply (the system share sheet, else copy), Read aloud, Regenerate, and More (…) with "Answered by <model>" and "Copy as plain text". Feedback is stored in `preferences.feedback` (assistant message id → `up`/`down`, at most 2,000, newest kept). It is set through `PUT /api/conversations/:id/messages/:messageId/feedback`, which checks that the reply exists in the user's chat; `PATCH /api/preferences` can't change it.

### Optimistic switches

A switch bound to query data keeps the user's choice in local state until the save returns. TanStack notifies subscribers a tick later, and a controlled input would otherwise snap back for a moment.

## Security review (Phase 16)

The review, with each control's code and test and the open exceptions, is in [SECURITY.md](SECURITY.md). Phase 16 added:

- **Per-account rates:** a route declares `rateLimit: "generation" | "upload" | "admin"`. The registry guard takes one hit after authentication and CSRF pass (`server/auth/route-limits.ts`, fixed one-minute windows, per process) and answers `RATE_LIMITED` with `Retry-After`.
- **Service-boundary authorization for admin operations:** `AdminService` re-reads the actor's account and requires an active admin.
- **`Permissions-Policy`** on every response (`server/csp.ts`): only the microphone (dictation), clipboard writes and full screen, for this origin.
- **HTTP server limits** (`server/http-server.ts`): 16 KB headers, 30 s to send them, `REQUEST_TIMEOUT_MS`, `MAX_CONNECTIONS`.
- **Malformed URLs:** an undecodable path parameter is `VALIDATION`; an undecodable document path is a plain 400 before the framework router.
- **One path constructor:** artifact, import-staging and temporary-chat paths moved into `DataPaths`.
- **DTO lint rule:** `res.json()` only in the registry and the error contract.
- **Offline backup/restore** (`server/backup.ts`, CLI `backup`/`restore`): the running server keeps `_system/server.lock` fresh (30 s heartbeat, stale after 90 s, removed on clean shutdown), and both commands refuse while it is fresh. `backup` runs startup recovery through the server bundle, then copies the canonical files with a SHA-256 manifest. `restore` verifies everything before writing into an empty `DATA_DIR`, then runs recovery once.

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

- Reliability (invariant audit) and visual polish: Phases 17–18.
- Interactive artifacts: optional Phase 19, separately approved.

## Deviations from the written specification

- **React Router 8.4 instead of 7.** The project owner asked for the latest dependencies. v8 is the direct successor with the same Framework Mode SSR, route modules and `@react-router/express` adapter. Its breaking changes (ESM-only packages, always-on middleware, `RouterContextProvider` for load context, Node ≥ 22.22, React ≥ 19.2.7) don't affect the required architecture.
- **Node 24 LTS instead of 22.x.** The spec allows a newer supported LTS; 24.21.0 is the current Active LTS.
- **TypeScript 6.0.3 instead of 7.0.** typescript-eslint (required for type-aware linting) supports `<6.1`.
- **Phase order and scope** follow `docs/ROADMAP.md` (the package is partly outdated). Phase 7 runs as 7a (core chat) and 7b (settings appearance, auth and status pages, demo). Visual tokens and an automated measurement audit start in 7a rather than Phase 18; the accent is orange (the project owner's choice) instead of a monochrome palette.
- **Stored-format amendments (format version stays 1):** assistant blocks may carry `tools="…"` (13b) and `thought=<ms>` (14b). Older files parse unchanged.
- **D2 general tools (Phase 13b).** One shared tool loop replaces §4.3's single proposal continuation; see "Memories and the shared tool loop". The stored format gains the optional `tools` attribute on assistant blocks (format version stays 1).
- **`/` opens the chat**, redirecting to `/chat/new` or `/login`; the Phase 1a status page moved to `/status`.
- **Attachments (Phase 12).**
  - Earlier media the model can't take (missing modality, `historyImages: omit`, or beyond `MAX_PROMPT_MEDIA_PARTS`) become a text note instead of a rejection, so a conversation with images can continue on a text model. Only the new message's media must match the model.
  - A message may consist of attachments alone (empty text).
  - `meta.json` adds `version`, `width` and `height` to the contract's fields.
  - Raw control characters in a multipart filename make the request invalid (`400`).
- **Library and profile (Phase 12b).** These are additions to the package; the storage layout gains `profile/` (canonical) next to `attachments/`. Library uploads are `saved` attachments, outside the pending/linked lifecycle of contracts §7.
- **Workflow.** The project owner authorized autonomous phase execution with commits pushed to `main` on GitHub. The spec's plan-approval pause and local-only commits don't apply to this repository.

## Invariant register

Tests name the invariant in their title (e.g. `INV-01: …`). "Pending" rows are enforced and tested once their phase is executed.

| ID     | Invariant                                                                                                                                                                                                                   | Phase           | Enforcement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Tests                                                                                                                                                                                                                                                                                         | Status                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| INV-01 | Every API error uses the canonical error contract; unhandled errors become `INTERNAL` with no internals exposed                                                                                                             | 1a              | `server/errors.ts` (`apiErrorHandler`, `toAppError`), `server/create-app.ts` (API/asset 404s)                                                                                                                                                                                                                                                                                                                                                                                                                                               | `tests/server/errors.test.ts`, `scripts/verify.ts`                                                                                                                                                                                                                                            | Implemented (1a)                                                 |
| INV-02 | Every request body is schema-validated and unknown fields are rejected                                                                                                                                                      | 1a              | `server/validation.ts` (`parseRequest`, strict schemas; omitted parts must be empty), `server/registry.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                  | `tests/server/errors.test.ts` (request validation)                                                                                                                                                                                                                                            | Implemented (1a)                                                 |
| INV-03 | Responses are explicit DTOs; no server-only secrets, credential hashes, paths, or upstream bodies in any response (browser CSRF token per §5 is allowed)                                                                    | 1a              | `server/registry.ts` parses every handler result through its strict response DTO schema; `shared/api.ts`; ESLint `dtoRestriction`: only the registry and the error contract write JSON                                                                                                                                                                                                                                                                                                                                                      | `tests/server/errors.test.ts`, `tests/server/registry.test.ts`                                                                                                                                                                                                                                | Implemented (1a)                                                 |
| INV-04 | Provider credentials and raw provider payloads never reach the browser                                                                                                                                                      | 2               | `server/providers/llamacpp.ts` (normalized `ProviderError`, own messages), `server/generations/catalog.ts` + `shared/generations.ts` DTOs                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/server/generations.test.ts` (INV-04, discovery, failure cases)                                                                                                                                                                                                                         | Implemented (2)                                                  |
| INV-05 | A generation reaches exactly one terminal state                                                                                                                                                                             | 2               | `GenerationManager.finish()` single guarded transition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tests/server/manager.test.ts` (cancel/complete race), `tests/server/generations.test.ts`                                                                                                                                                                                                     | Implemented (2)                                                  |
| INV-06 | Closing an SSE connection never cancels a generation                                                                                                                                                                        | 2               | `server/generations/sse.ts` (disconnect only unsubscribes), `GenerationManager.observe`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/server/generations.test.ts` (disconnect/reconnect), `tests/server/manager.test.ts`, `scripts/verify.ts` (reload)                                                                                                                                                                       | Implemented (2)                                                  |
| INV-07 | The assistant message is written to canonical storage exactly once per generation                                                                                                                                           | 3               | `SendService.persistOutcome` (idempotent by assistant id, under lock), `GenerationManager.finish` single decision                                                                                                                                                                                                                                                                                                                                                                                                                           | `tests/server/conversations.test.ts` (INV-08/INV-07), `tests/server/manager.test.ts` (race: one persisted outcome)                                                                                                                                                                            | Implemented (3)                                                  |
| INV-08 | The user message is durable before `202` is returned                                                                                                                                                                        | 3               | `SendService.commit` (atomic write + committed record before return)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/server/conversations.test.ts` (file read right after 202)                                                                                                                                                                                                                              | Implemented (3)                                                  |
| INV-09 | `formatVersion: 1` round-trips exactly (§3.6)                                                                                                                                                                               | 3               | `server/storage/markdown.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `tests/storage/markdown.test.ts` (examples + fast-check properties)                                                                                                                                                                                                                           | Implemented (3)                                                  |
| INV-10 | Malformed conversations are never modified by the application and never break other conversations                                                                                                                           | 3               | `ConversationStore.get/rename`, `SendService.readExisting`, index `malformed` entries                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`, `scripts/verify.ts`                                                                                                                                                                                                    | Implemented (3)                                                  |
| INV-11 | The index is derived: deleting it and restarting loses nothing                                                                                                                                                              | 3               | `ChatIndex` (rebuild, dirty marker, reconcile)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`, `scripts/verify.ts`                                                                                                                                                                                                    | Implemented (3)                                                  |
| INV-12 | No filesystem path contains request-controlled input; all paths stay inside `DATA_DIR`                                                                                                                                      | 3               | `server/storage/paths.ts`, `canonicalUuid` route schemas; artifact, import-staging and temporary-chat paths also built there (Phase 16)                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/storage/storage.test.ts`, `tests/server/conversations.test.ts`, `tests/server/security.test.ts` (every constructor)                                                                                                                                                                    | Implemented (3)                                                  |
| INV-13 | At most one non-terminal generation per conversation                                                                                                                                                                        | 3               | `GenerationManager.reserve/assertIdle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tests/server/manager.test.ts`, `tests/server/conversations.test.ts`                                                                                                                                                                                                                          | Implemented (3)                                                  |
| INV-14 | Identity comes only from server-side state (config in Phase 3, session thereafter)                                                                                                                                          | 3               | Phase 4: `AuthService.resolve` → `RouteContext.auth` / `userOf`, document `appContext.auth`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/server/registry.test.ts` (INV-14 code check), `tests/server/auth.test.ts`                                                                                                                                                                                                              | Implemented (3, 4)                                               |
| INV-15 | A user can never read, modify, delete, or observe another user's resources (404)                                                                                                                                            | 4               | service functions take `userId`; `GenerationManager.require(id, userId)`; per-user directories                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/server/auth.test.ts` (INV-15), `tests/server/registry.test.ts` (401 enumeration), `scripts/verify.ts`                                                                                                                                                                                  | Implemented (4)                                                  |
| INV-16 | Every state-changing route requires a valid CSRF token or same-origin check                                                                                                                                                 | 4               | registry `csrf` policy → `AuthService.checkMutation` / `checkOrigin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/server/registry.test.ts` (INV-16 enumeration)                                                                                                                                                                                                                                          | Implemented (4)                                                  |
| INV-17 | Reducing a user's privileges or disabling them revokes all their sessions                                                                                                                                                   | 4               | `AuthService.resolveHash` (user reloaded per request; role/status mismatch revokes), `SessionStore.revokeUser`                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/server/auth.test.ts` (INV-17, password change)                                                                                                                                                                                                                                         | Implemented (4)                                                  |
| INV-18 | Only server-validated `(providerId, modelId)` pairs are ever sent to a provider                                                                                                                                             | 5               | `ModelCatalog.resolve` in `SendService.accept` (before any mutation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/server/providers.test.ts` (unknown provider/model, pair valid on A sent to B)                                                                                                                                                                                                          | Implemented (5)                                                  |
| INV-19 | Every provider endpoint passes SSRF validation on every create/edit and at request time                                                                                                                                     | 5               | `server/providers/ssrf.ts` (`checkUrl` at load, `createSafeFetch` per request with pinning)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/server/providers.test.ts` (INV-19 suite: categories, IPv4-mapped, exceptions, rebinding, redirects, load-time)                                                                                                                                                                         | Implemented (5; admin edits in Phase 10 reuse it)                |
| INV-20 | SSE replay never silently skips events; a too-old `Last-Event-ID` triggers a full resync                                                                                                                                    | 6               | `GenerationManager.observe` (ring buffer, `resync`), cursor rules in `server/routes/generations.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/server/streaming.test.ts` (INV-20), `scripts/verify.ts` (reconnect), `tests/e2e/streaming.spec.ts`                                                                                                                                                                                     | Implemented (6)                                                  |
| INV-21 | After a restart, no generation remains non-terminal; partial output of a running generation is persisted once as `interrupted`, and a terminal-decided outcome is persisted once with its recorded status                   | 6               | `recoverGenerations` in `server/storage/recovery.ts`; `GenerationManager.shutdown`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `tests/server/streaming.test.ts` (INV-21 / INV-60)                                                                                                                                                                                                                                            | Implemented (6)                                                  |
| INV-22 | Rendered Markdown never executes script or raw HTML                                                                                                                                                                         | 7               | `app/chat/markdown.tsx` (no `rehype-raw`, `safeUrl` scheme allowlist, no image loads, `rel=noopener noreferrer`)                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/client/markdown.test.tsx`                                                                                                                                                                                                                                                              | Implemented (7a)                                                 |
| INV-23 | A stale response never overwrites newer client state                                                                                                                                                                        | 8               | TanStack Query per-key cancellation/dedupe; `storeConversation` version guard (`app/lib/query/queries.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                  | `tests/client/resilience.test.tsx`, `tests/e2e/resilience.spec.ts` (rapid switching)                                                                                                                                                                                                          | Implemented (8)                                                  |
| INV-24 | Admin authorization is enforced server-side on every admin route                                                                                                                                                            | 10              | `server/registry.ts` (`auth: "admin"` checks the role from the fresh account record before validation; `403 FORBIDDEN`), `app/routes/admin.tsx` loader 404s non-admins                                                                                                                                                                                                                                                                                                                                                                      | `tests/server/admin.test.ts` (INV-24 suite: 401/403 per admin route, escalation rejected, demotion locks out), `tests/server/registry.test.ts`, `tests/e2e/admin.spec.ts`                                                                                                                     | Implemented (10)                                                 |
| INV-25 | Secrets are write-only: no API response ever contains a configured secret                                                                                                                                                   | 10              | Provider secrets stored write-only in `_system/providers.json`; DTOs expose `hasApiKey` only (`server/admin/service.ts`, `shared/admin.ts`)                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/server/admin.test.ts` (SSRF/secrets, secret exposure sweep over responses, headers and logs)                                                                                                                                                                                           | Implemented (10)                                                 |
| INV-26 | There is always at least one active admin                                                                                                                                                                                   | 10              | `AdminService.updateUser/deleteUser` count active admins under the users lock (`409 LAST_ADMIN`)                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/server/admin.test.ts` (INV-26)                                                                                                                                                                                                                                                         | Implemented (10)                                                 |
| INV-27 | Attachment bytes are never served as executable content; media type is sniffed, not trusted                                                                                                                                 | 12              | `server/attachments/sniff.ts` (magic bytes and structure; extension and client type must agree; SVG/HTML/XML and unknown types rejected), `server/attachments/serve.ts` (sniffed `Content-Type`, `nosniff`, `sandbox; default-src 'none'` CSP, download disposition except the four raster image types)                                                                                                                                                                                                                                     | `tests/server/attachments.test.ts` (INV-27 spoofing, serving headers), verify                                                                                                                                                                                                                 | Implemented (12)                                                 |
| INV-28 | Attachment storage paths never derive from the uploaded filename                                                                                                                                                            | 12              | `AttachmentStore` mints the attachment UUID; `DataPaths.attachmentDir` accepts only UUIDs; the filename is sanitized display metadata (`displayName`)                                                                                                                                                                                                                                                                                                                                                                                       | `tests/server/attachments.test.ts` (INV-28 hostile filenames)                                                                                                                                                                                                                                 | Implemented (12)                                                 |
| INV-29 | Independent critical startup requests never form an accidental serial waterfall                                                                                                                                             | 9               | concurrent loader queries (`app/routes/app-layout.tsx`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/client/query-ssr.test.ts` (start order)                                                                                                                                                                                                                                                | Implemented (8, 9)                                               |
| INV-30 | Secondary startup work never blocks composer interactivity                                                                                                                                                                  | 9               | 300 ms budget for the conversation list; server-rendered composer; `composer-interactive` mark                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/client/query-ssr.test.ts`, `tests/e2e/resilience.spec.ts`, `tests/e2e/perf.spec.ts`                                                                                                                                                                                                    | Implemented (8, 9)                                               |
| INV-31 | Prefetch and consume paths use the same canonical cache identity; prefetched data cannot bypass INV-23 stale-response protection                                                                                            | 9               | `app/lib/prefetch.ts` (same `conversationQuery`), `storeConversation` cancels in-flight fetches                                                                                                                                                                                                                                                                                                                                                                                                                                             | `tests/client/prefetch.test.ts`, `tests/e2e/perf.spec.ts`                                                                                                                                                                                                                                     | Implemented (9)                                                  |
| INV-32 | Streaming an assistant response never remounts the application shell or unrelated transcript/sidebar trees                                                                                                                  | 9               | `LiveReply` is the only delta subscriber; memoized `Message`/`Transcript`/`Sidebar`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/client/render-isolation.test.tsx`                                                                                                                                                                                                                                                      | Implemented (7a, 9)                                              |
| INV-33 | Production client runtime assets are first-party and no service worker is registered                                                                                                                                        | 9               | Vite build served from the ChatUI origin; no SW code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `scripts/verify.ts` (third-party URLs, SW count, immutable assets)                                                                                                                                                                                                                            | Implemented (1a, 9)                                              |
| INV-34 | Pinning/default model/history preferences are user-owned canonical state; an index rebuild never deletes them                                                                                                               | 4               | `server/storage/preferences.ts` (separate canonical file, per-user lock)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `tests/server/auth.test.ts`, `tests/server/preferences.test.ts`, `tests/server/mutations.test.ts` (pins: deleting a chat removes only its pin; clear history keeps every other preference)                                                                                                    | Implemented (4, 13a)                                             |
| INV-35 | Conversation edits/deletes/regeneration cannot resurrect superseded messages, responses or proposals                                                                                                                        | 13a             | `server/chat/turns.ts` (turn grammar, irregular regions refused), `server/chat/mutations.ts` (edit truncates later blocks, delete removes exactly one exchange; checks under the conversation lock: idle, current revision), `SendService.regenerate` (fresh provider contact, fresh message ids, revision re-checked before commit, idempotent by operation key); removed turns' files deleted after the Markdown write                                                                                                                    | `tests/server/mutations.test.ts` (truncation, stale revision, irregular regions, regenerate ids and idempotency, crash after a regeneration commit), `tests/e2e/conversation-ops.spec.ts`                                                                                                     | Implemented (13a)                                                |
| INV-36 | Full-text search is user-scoped, bounded, and tolerates individual malformed files                                                                                                                                          | 13a             | `server/chat/search.ts` (`SearchService`: the caller's files only, query ≤ 200 chars, ≤ 50 chats and 20 files, 160-char snippets, per-user text cache keyed by file stamp; malformed files skipped and listed by title)                                                                                                                                                                                                                                                                                                                     | `tests/server/mutations.test.ts` (per-user, bounded, malformed file), `tests/e2e/conversation-ops.spec.ts` (search dialog, jump and marks)                                                                                                                                                    | Implemented (13a)                                                |
| INV-37 | Model tool calls cannot directly write approved memories; proposal acceptance/rejection is an authenticated user action                                                                                                     | 13b             | `server/tools/session.ts` stages memory tool calls as proposals only (never a memory write); `MemoryService.accept/reject` behind authenticated, CSRF-checked routes (`server/routes/memories.ts`)                                                                                                                                                                                                                                                                                                                                          | `tests/server/memories.test.ts` (recorded only, accept/reject, other account 404), `tests/e2e/memory.spec.ts`                                                                                                                                                                                 | Implemented (13b)                                                |
| INV-38 | Memory proposals use conditional create/update/delete against the memory revision in the generation's prompt snapshot and detect any change since that snapshot                                                             | 13b             | Proposals record the target note's id and revision from the prompt snapshot (`memorySnapshot`); `MemoryService.accept` re-checks it under the sidecar then memory-store lock and refuses on any change (`stale`); notes omitted by `MEMORY_PROMPT_BUDGET` are invalid targets; acceptance intents carry before/after hashes                                                                                                                                                                                                                 | `tests/server/memories.test.ts` (stale note conflict, omitted-note target, interrupted acceptance with a changed note)                                                                                                                                                                        | Implemented (13b)                                                |
| INV-39 | Memories, proposals, artifacts and preferences never cross account boundaries or survive a wrong-account cache                                                                                                              | 13b, 13c        | Memories, proposal sidecars and artifacts live under the owner's UUID directory (UUID-only names via `DataPaths` and `artifactId`); every route takes the user from the session and another account's ids return 404; client keys are user-scoped (`qk.memories`, `qk.artifacts`) and purged with the account's cache                                                                                                                                                                                                                       | `tests/server/memories.test.ts` (ownership, tools read only the caller's chats), `tests/server/artifacts.test.ts` (cross-user 404 on metadata, source and delete)                                                                                                                             | Implemented (13b, 13c)                                           |
| INV-40 | An artifact is captured only after successful complete generation, exactly once per `(assistantMessageId, captureIndex)`, persists independently of conversation deletion, and is never recreated after the user deletes it | 13c             | `GenerationManager` stages captures (`create_file`, then `file=` fences) only for `completed` and records them in the `terminal-decided` checkpoint; `ArtifactStore.captureUnlocked` runs inside the terminal sequence under the conversation lock, keyed by `(assistantMessageId, captureIndex)` with a deterministic server-minted id, bytes then metadata, then `finalizeUnlocked`; only finalized artifacts are listable or deletable; recovery repeats the keyed capture from a decided checkpoint only; no scan of historical content | `tests/server/artifacts.test.ts` (convention fixtures, crash before creation, crash before finalization then delete and checkpoint eviction, unfinished replies, metadata-less cleanup, chat deletion keeps files)                                                                            | Implemented (13c)                                                |
| INV-41 | Artifacts are read as inert source, never executed, and no stored name becomes a filesystem path                                                                                                                            | 13c             | `/api/artifacts/:id/source` always sends `text/plain; charset=utf-8`, `nosniff`, `sandbox; default-src 'none'` and an RFC 6266 disposition; the panel renders the text through `CodeBlock` (no HTML rendering); names are validated display strings and never part of a path                                                                                                                                                                                                                                                                | `tests/server/artifacts.test.ts` (headers, XSS payload as text, name rules), `tests/e2e/source-artifacts.spec.ts` (nothing renders or runs)                                                                                                                                                   | Implemented (13c)                                                |
| INV-42 | Import is bounded by compressed size, expanded bytes, entry count, depth and time; no traversal or silent canonical overwrite                                                                                               | 13d, 13e        | `server/portability/zip.ts` (central directory only; no links, encryption or ZIP64; safe relative paths ≤ 3 segments; entry count, entry size, total expanded size and ratio caps; inflation capped per entry and CRC-checked) and `server/portability/import.ts` (archive size cap, wall-clock deadline, manifest must list exactly the files with matching sizes and SHA-256, known paths only, full preflight before any write, never overwrite, journaled commit rolled back at startup)                                                | `tests/server/portability.test.ts` (traversal, absolute, backslash, symlink, ZIP bomb, too many entries, bad checksum, unknown file, not a ZIP, too large, time limit, interrupted commit rollback, ownership)                                                                                | Implemented (13d; 13e reuses it)                                 |
| INV-43 | Exports preserve canonical Markdown; portable user archives round-trip all user canonical stores (operator backup is INV-50)                                                                                                | 13d             | `GET /api/conversations/:id/export` sends the stored bytes unparsed (malformed included); `server/portability/export.ts` copies chats, attachment and artifact metadata, memories, proposal sidecars and preferences under the exclusive per-user export barrier (`KeyedLocks.barrier`), then copies and verifies blobs; the importer restores them with consistent remapping                                                                                                                                                               | `tests/server/portability.test.ts` (exact bytes, manifest and checksums, full round trip into another account, barrier window, deleted blob, running reply, identical skip, conflicts and remapping, dependencies, malformed, memory names, idempotency key), `tests/e2e/portability.spec.ts` | Implemented (13d)                                                |
| INV-44 | Audio/images are passed only to a server-verified model with the matching input modality                                                                                                                                    | 12              | `SendService` rejects images/audio in the new message for a model without the modality (`422 MODEL_CAPABILITY_UNSUPPORTED`, before any write); `prepareExpansion` sends earlier media only to a capable model (else a text note)                                                                                                                                                                                                                                                                                                            | `tests/server/attachments.test.ts` (INV-44, earlier images), `tests/e2e/attachments.spec.ts` (capability warning)                                                                                                                                                                             | Implemented (12)                                                 |
| INV-45 | Response math/code/Markdown never execute raw provider content or create unsafe links                                                                                                                                       | 14              | `app/chat/render/math.tsx` (MathML output, `trust: false`, bounded), `render/code.tsx` (escaped highlight output), `markdown.tsx` (no raw HTML, `safeUrl`)                                                                                                                                                                                                                                                                                                                                                                                  | `tests/client/rendering.test.tsx`, `tests/client/markdown.test.tsx`                                                                                                                                                                                                                           | Implemented (14)                                                 |
| INV-46 | Incremental rendering preserves selection, focus, scroll intent and unaffected message identity                                                                                                                             | 14              | memoized messages; delta-only live reply; input-driven scroll intent (`app/chat/scroll-intent.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                          | `tests/client/render-isolation.test.tsx`, `tests/e2e/chat-ui.spec.ts` (streaming scroll intent)                                                                                                                                                                                               | Implemented (14)                                                 |
| INV-47 | Menus/dialogs/selects have correct keyboard, focus, portal and screen-reader behavior                                                                                                                                       | 7, 15           | Radix wrappers in `app/ui/` (menu, dialog, confirm, tooltip); `useReturnFocus` / `claimMenuOpener`; custom slash listbox; audit and decision record (`docs/primitives-audit.md`)                                                                                                                                                                                                                                                                                                                                                            | `tests/e2e/chat-ui.spec.ts` (INV-47 block), `tests/e2e/primitives.spec.ts`, `tests/e2e/a11y.spec.ts` (axe)                                                                                                                                                                                    | Implemented (Phase 15 audit done)                                |
| INV-48 | Composer preserves IME, Enter/Shift+Enter, draft and attachment semantics and cannot double-send                                                                                                                            | 15              | `app/chat/composer.tsx` (uncontrolled textarea cleared synchronously, `sending` guard in `chat-context.tsx`, `isComposing` check), `html-to-markdown.ts`, `dictation.ts`                                                                                                                                                                                                                                                                                                                                                                    | `tests/client/composer.test.tsx`, `tests/client/composer-extras.test.tsx`, `tests/e2e/composer.spec.ts` (real IME composition, rapid double send, focus through SSE, rich paste)                                                                                                              | Implemented                                                      |
| INV-49 | Compose is the supported production path; the canonical `/data` volume survives ordinary recreate and update                                                                                                                | 1b              | `Dockerfile`, `compose.yaml` (named `/data` volume, 127.0.0.1 publication), `compose.podman.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                           | `scripts/verify-compose.ts` (Docker and Podman in CI)                                                                                                                                                                                                                                         | Implemented (1b)                                                 |
| INV-50 | Backup/restore operates on a complete verified single-process data snapshot; restore refuses nonempty state                                                                                                                 | 16              | `server/backup.ts` (checksum manifest, unknown files refused, empty target only), `server/storage/instance-lock.ts` (offline check), CLI `backup`/`restore` run startup recovery                                                                                                                                                                                                                                                                                                                                                            | `tests/server/backup.test.ts`, `scripts/verify.ts` (CLI round trip), `scripts/verify-compose.ts`                                                                                                                                                                                              | Implemented                                                      |
| INV-51 | Optional interactive artifact execution is opaque-origin sandboxed, credentialless, without same-origin access                                                                                                              | 19              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                                                                             | Pending Phase 19 (optional, separately approved)                 |
| INV-52 | Feature capability is truthfully classified as implemented, provider-dependent, or future; UI never implies unsupported tools                                                                                               | 14              | read aloud only with `speechSynthesis`; later-phase controls not shown before their phase                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/client/rendering.test.tsx`                                                                                                                                                                                                                                                             | Implemented (14)                                                 |
| INV-53 | The URL is the authoritative active-conversation identity; every protected route uses shared auth gating, and navigation preserves the persistent shell, draft, active generation and URL-backed overlay/back behavior      | 7               | `app/routes.ts` (protected layout incl. catch-all), `app/routes/app-layout.tsx` (route-derived id, overlays), `app/lib/paths.ts`, `app/chat/drafts.ts`                                                                                                                                                                                                                                                                                                                                                                                      | `tests/e2e/routing.spec.ts`, `tests/client/api.test.ts` (return-to), `scripts/verify.ts`                                                                                                                                                                                                      | Implemented (7a)                                                 |
| INV-54 | Phase 1a renders useful HTML before JS; from Phase 4 authorized documents SSR the actual shell/composer and appropriate transcript while unauthorized requests never expose private markup                                  | 1a, 4           | Phase 1a portion: `app/routes/home.tsx` loader + `app/entry.server.tsx` stream real HTML before JS                                                                                                                                                                                                                                                                                                                                                                                                                                          | `scripts/verify.ts` (raw HTML of `/` and `/chat`, JS-disabled browser)                                                                                                                                                                                                                        | Implemented (1a, 2, 4, 7a); mutation-audited (Phase 17)          |
| INV-55 | SSR identities/render context (Phase 4) and server QueryClient (Phase 7) are per-request; private HTML/dehydrated data never cross users or enter shared caches                                                             | 4, 7            | per-request `appContext`; fresh `makeQueryClient()` per loader and per server render; `dehydrateAllowed`; user id in every private key; `applySession` purge                                                                                                                                                                                                                                                                                                                                                                                | `tests/client/query-ssr.test.ts`, `scripts/verify.ts` (concurrent identities), `tests/e2e/routing.spec.ts` (account switch)                                                                                                                                                                   | Implemented (4, 7a)                                              |
| INV-56 | Hydration preserves pre-hydration draft/theme/markup (Phases 1–4) and avoids duplicate initial fetch after Query hydration (Phase 7)                                                                                        | 1a, 2, 7        | uncontrolled composer; `HydrationBoundary` with identical keys; 30 s stale time; root `shouldRevalidate`; layout `clientLoader`; cookie-based sidebar and time hints                                                                                                                                                                                                                                                                                                                                                                        | `scripts/verify.ts` (pre-hydration typing; dev hydration of status, sign-in, chat, settings), `tests/e2e/routing.spec.ts` (no duplicate fetch)                                                                                                                                                | Implemented (1a, 2, 7a)                                          |
| INV-57 | SSR document routing preserves real HTTP statuses, API/assets boundary, URL/overlay semantics, server-owned generation and production Compose/CSP operation                                                                 | 1a, 4, 7        | `server/create-app.ts` ordering; framework statuses incl. 404/422 chat data errors and the in-shell catch-all 404; CSP nonce for scripts and the dialog `<style>`                                                                                                                                                                                                                                                                                                                                                                           | `tests/server/boundary.test.ts`, `tests/server/csp.test.ts`, `scripts/verify.ts`, `tests/e2e/routing.spec.ts`                                                                                                                                                                                 | Implemented (1a, 4, 7a, 16); Compose portion in `verify:compose` |
| INV-58 | A generation-starting request is accepted at most once per operation key; a lost response is resolvable by key, and an expired or mismatched key never causes a fresh send                                                  | 3               | `SendService` (key first, in-flight serialization, recheck under lock), `OperationStore`, `GET /api/operations/:key`                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/server/conversations.test.ts` (INV-58 suite)                                                                                                                                                                                                                                           | Implemented (3)                                                  |
| INV-59 | A request is never executed under a different user than the one that issued it; CSRF retries and expected-user checks never carry one account's mutation into another                                                       | 4               | `X-Expected-User` check in `checkMutation`; `app/lib/api.ts` epoch/same-user retry rule                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/client/api.test.ts`, `tests/server/auth.test.ts` (INV-59)                                                                                                                                                                                                                              | Implemented (4)                                                  |
| INV-60 | Unfinished recovery state is durable, recovered in the documented order exactly once, and recovery never recreates or undoes a user deletion                                                                                | 3, 6, 13b, 13c  | Phase 3 portion: `server/storage/recovery.ts` (`resolvePendingRecord`, startup order)                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/server/conversations.test.ts` (INV-60 crash cases)                                                                                                                                                                                                                                     | Implemented (3, 6, 13b, 13c, 13d); mutation-audited (Phase 17)   |
| INV-61 | Account closure is exclusive: after it begins, no request, late writer or recovery step modifies or recreates that account's data                                                                                           | 10              | `AdminService.closeAccount` (closing → revoke → cancel → drain → rename to `_system/deleting` → remove; `recoverClosures` at startup); `ensureDirUnder` refuses to recreate a removed account root (`AccountGoneError`); `SendService.persistOutcome` skips closing accounts                                                                                                                                                                                                                                                                | `tests/server/admin.test.ts` (INV-61 mid-generation delete, crash-resume)                                                                                                                                                                                                                     | Implemented (10)                                                 |
| INV-62 | Generation admission, SSE connections, observer queues, provider responses, password hashing and upload reservations are bounded; overload is rejected, not queued without limit                                            | 2, 4, 6, 12, 16 | Global and per-provider admission in `GenerationManager`; `MAX_ACTIVE_GENERATIONS_PER_USER`; `MAX_SSE_PER_USER`/`MAX_SSE_TOTAL` (`SseConnections`); `PROVIDER_MAX_RESPONSE_BYTES` in `llamacpp.ts`; byte-bounded observer queue in `sse.ts`; password hashing queue; upload quota reservations and `MAX_UPLOADS_PER_USER` in `AttachmentStore.ingest`; Phase 16: per-account route rates (`server/auth/route-limits.ts`), header, request-time and connection limits (`server/http-server.ts`)                                              | `tests/server/generations.test.ts` (admission, cap, slow observer), `tests/server/auth.test.ts`, `tests/server/streaming.test.ts`, `tests/server/attachments.test.ts` (parallel uploads vs quota, size limit mid-stream), `tests/server/security.test.ts`                                     | Implemented (2, 4, 6, 12)                                        |

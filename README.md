# ChatUI

A self-hosted AI chat frontend: React 19 + React Router Framework Mode **server-side rendering from the first commit**, one Express 5 process, canonical Markdown storage (from Phase 3), and server-owned generation.

> **Status: Phase 9 (performance).** A server-rendered, monochrome chat interface built composer-first: the page is readable and typeable before JavaScript loads, the critical bundle is budgeted and served precompressed, interaction-only code loads on demand, and hovering a conversation prefetches it. Messages appear the moment you send them, an expired session asks you to sign in again in place, and generations survive disconnects and restarts. Admin, mobile layout and uploads arrive in later phases.

## Prerequisites

- Node.js **24.21.0** (see `.nvmrc`; `nvm use`)
- npm 11
- For `npm run verify`: Playwright's Chromium (`npx playwright install chromium`, one-time download)

## Run with Compose (supported production runtime)

Docker Compose:

```bash
docker compose up -d --build
```

Rootless Podman (named volume, labeled automatically):

```bash
podman compose up -d --build
```

Rootless Podman with `./data` bind-mounted and SELinux-labeled (`:Z`, see `compose.podman.yaml`):

```bash
mkdir -p data && podman compose -f compose.yaml -f compose.podman.yaml up -d --build
```

Then open http://127.0.0.1:3000 (override with `HOST_PORT`). The container:

- publishes **only on `127.0.0.1`**; use an https TLS proxy for LAN or phone access (see below);
- runs as the unprivileged `node` user (UID 1000) with a read-only root filesystem, all capabilities dropped and `no-new-privileges`;
- keeps all persistent state in the `/data` volume (`chatui-data` by default), which survives `docker compose down`/`up`, recreate and image updates. Only `docker compose down -v` deletes it;
- has a built-in healthcheck and `restart: unless-stopped`;
- has the stable entrypoint `node server/cli.ts <command>`, e.g. `docker compose exec chatui node server/cli.ts healthcheck`.

Operator commands are introduced as their services exist. Until then they exit with status 2 and a message; they never pretend to succeed:

| Command                                                                  | Available from |
| ------------------------------------------------------------------------ | -------------- |
| `serve` (default), `healthcheck`                                         | Phase 1b       |
| `provider:check` (reachability and credentials of `LLAMA_BASE_URL`)      | Phase 2        |
| `index:rebuild` (rebuild derived indexes; server stopped)                | Phase 3        |
| `user:create --username <name> [--admin]` (password via prompt or stdin) | Phase 4        |
| `backup`, `restore`                                                      | Phase 16       |

Updating: `git pull && docker compose up -d --build`. The `/data` volume is reused.

To reach a llama.cpp server from the container, set `LLAMA_BASE_URL` (and `LLAMA_API_KEY` in `.env`) to an address the container can reach: a LAN address, `host.containers.internal` (Podman) or `host.docker.internal` with the `extra_hosts` entry commented in `compose.yaml` (Docker Engine on Linux). `localhost` inside the container is the container itself. Check it with `docker compose exec chatui node server/cli.ts provider:check`.

## First admin and signing in

Accounts are created by the operator (registration is closed by default). The password is read from a prompt, or from stdin when piped. It is never accepted as a command-line argument:

```bash
npm run user:create -- --username admin --admin
```

With Compose, run the same command inside the container:

```bash
docker compose exec chatui node server/cli.ts user:create --username admin --admin
```

Then open the URL in `PUBLIC_ORIGIN` (default `http://localhost:3000`) and sign in. `REGISTRATION_MODE=open` lets people create their own accounts at `/register`. Changing your password at `/account` signs you out everywhere.

## Chatting (development)

```bash
LLAMA_BASE_URL=http://<llama-host>:8080 LLAMA_API_KEY=<key> npm run dev
# create an account (above), then open http://localhost:3000/chat
```

`/chat/new` is an unsaved draft; your first message creates the conversation and the URL becomes `/chat/<id>` (bookmarkable, reload-safe). The page renders on the server, so you can type before JavaScript loads. Enter sends and Shift+Enter adds a newline. Replies stream as Markdown with the model's reasoning collapsed, and the view follows new text only while you are scrolled to the bottom ("Jump to latest" otherwise). Reloading keeps watching the running reply, and Stop cancels it. Anything you send while a reply is still streaming is queued (shown as "Queued" under your bubble) and goes out as soon as the reply finishes; Stop puts queued messages back into the box. Type `/` in an empty box for commands (`model`, `new`, `rename`, `delete`, `settings`). The model list refreshes itself when you come back to the tab. Rename and delete are in each conversation's "…" menu in the sidebar and in the title menu at the top. Settings (account menu at the bottom of the sidebar, or `/settings`) opens over the current chat, and browser Back closes it. `node server/cli.ts provider:check` tests connectivity and credentials, and `node scripts/probe-provider.ts` records what your llama-server actually does (see [docs/provider-notes.md](docs/provider-notes.md)).

## Providers (`providers.json`)

Model servers are configured in `DATA_DIR/_system/providers.json`. On first start it is created with one `local` provider from `LLAMA_BASE_URL` / `LLAMA_API_KEY`; after that **the file is authoritative** (edit it and restart; an admin UI arrives in Phase 10):

```json
{
  "version": 1,
  "providers": [
    {
      "id": "local",
      "name": "Local llama.cpp",
      "kind": "openai-compatible",
      "baseUrl": "http://192.168.1.20:8080",
      "apiKey": "optional-secret",
      "timeoutMs": 300000,
      "maxActiveGenerations": 1,
      "capabilities": { "inputModalities": ["text"], "reasoning": true, "tools": false },
      "contextTokens": 32768
    }
  ]
}
```

- **It contains secrets** (`apiKey`). ChatUI writes it `0600`. API keys never appear in any API response or log. Treat backups of `DATA_DIR` as secret.
- `id` is 1–64 characters of `a-z 0-9 _ -`, and `kind` is `openai-compatible`. The optional fields fall back as follows:
  - `timeoutMs` → `PROVIDER_TIMEOUT_MS`
  - `maxActiveGenerations` → the provider's reported slots, else 1
  - `contextTokens` → discovery, else `DEFAULT_CONTEXT_TOKENS`
- An invalid entry is disabled and logged; startup continues. An unreachable provider is shown as unavailable and never blocks startup.
- Removing a provider never touches conversations: old replies keep their provider/model labels, and new messages just can't select it. You can switch provider and model at any point in a conversation.
- **Network policy (SSRF):** base URLs must be http(s) without credentials, query or fragment. Every request re-resolves the host, checks every address and pins the connection to the checked address. Redirects are never followed.
  - Cloud metadata addresses (e.g. `169.254.169.254`, `fd00:ec2::254`) and link-local ranges are denied.
  - Private and loopback hosts are allowed by default (`ALLOW_PRIVATE_PROVIDER_HOSTS`).
  - `PROVIDER_HOST_ALLOWLIST` restricts hostnames. `PROVIDER_LINK_LOCAL_EXCEPTIONS` admits an exact `host=address:port` gateway (e.g. Podman's `host.containers.internal`).

## LAN and phone access (TLS proxy)

Session cookies are `Secure` behind https. ChatUI supports exactly two transports:

1. `http://localhost` / `http://127.0.0.1` on the machine that runs ChatUI (the default).
2. An `https://` URL served by a TLS-terminating reverse proxy. Set `PUBLIC_ORIGIN` to that URL and `TRUST_PROXY` to the number of proxy hops. Plain-http LAN access is refused at startup.

Caddy on the ChatUI host (automatic certificates):

```text
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
PUBLIC_ORIGIN=https://chat.example.com TRUST_PROXY=1 docker compose up -d
```

Tailscale HTTPS (reachable from your tailnet devices, including phones):

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net TRUST_PROXY=1 docker compose up -d
```

Keep the Compose publication on `127.0.0.1`; the proxy is the only thing that talks to it.

## Data, backups and limits

- Everything lives under `DATA_DIR` (`/data` in the container). Conversations are canonical Markdown files, `DATA_DIR/<user-id>/chats/<conversation-id>.md` (format: `formatVersion: 1`). You can read and hand-edit them; edits appear after a restart or `npm run index:rebuild`. A file that no longer parses is listed as unreadable and never modified by ChatUI (it can be deleted).
- Each account has its own directory `DATA_DIR/<user-id>/` (`user.json`, `chats/`, `preferences.json`, `operations/`). `_system/` holds `providers.json` (secrets), sessions (deleting them signs everyone out) and the derived username index.
- **Back up all of `DATA_DIR`.** `index/` is derived and optional in a backup: it is rebuilt from the Markdown when missing. Keep `operations/` (short-lived send records used for safe retries and crash recovery). Stop the server, or copy from a filesystem snapshot, for a consistent backup; online backup/restore arrives in Phase 16.
- **Single process only.** Exactly one ChatUI process may use a `DATA_DIR` (locks are in-process). Don't run two servers, or the CLI `index:rebuild`, against the same directory at the same time.
- Writes are atomic and durable (temp file, fsync, rename, directory fsync). On Windows, directory fsync is unavailable and rename-over-existing semantics differ; Linux containers are the supported runtime.

## Install (development)

```bash
npm ci
```

## Run

```bash
cp .env.example .env        # optional; defaults are safe
npm run dev                 # http://127.0.0.1:3000 with HMR
```

| Script                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`                     | Runs `dev:server` and `dev:client` together                                                                                                                                                                                                                                                                                                                                                               |
| `dev:server`              | Express + embedded Vite (HMR); restarts on `server/` and `shared/` changes                                                                                                                                                                                                                                                                                                                                |
| `dev:client`              | React Router route type generation in watch mode                                                                                                                                                                                                                                                                                                                                                          |
| `build`                   | Production browser bundle (`build/client`) and SSR bundle (`build/server`)                                                                                                                                                                                                                                                                                                                                |
| `start`                   | Production server from the build (`NODE_ENV=production`)                                                                                                                                                                                                                                                                                                                                                  |
| `preview`                 | `build` then `start`                                                                                                                                                                                                                                                                                                                                                                                      |
| `test` / `test:watch`     | Vitest unit and HTTP tests                                                                                                                                                                                                                                                                                                                                                                                |
| `typecheck`               | Route typegen + `tsc` (strict)                                                                                                                                                                                                                                                                                                                                                                            |
| `lint`                    | ESLint (type-aware, strict)                                                                                                                                                                                                                                                                                                                                                                               |
| `format` / `format:check` | Prettier                                                                                                                                                                                                                                                                                                                                                                                                  |
| `user:create`             | Creates an account (`-- --username <name> [--admin]`); the password is read from a prompt or stdin                                                                                                                                                                                                                                                                                                        |
| `index:rebuild`           | Rebuilds the derived conversation index from the Markdown files (stop the server first)                                                                                                                                                                                                                                                                                                                   |
| `test:e2e`                | Builds, then runs the Playwright browser suite (streaming: reload mid-generation, network drop and reconnect, cancel; UI: 200-message scrolling, scroll intent while streaming, overlays, menus, routing and account switch) against the production server with a mock provider                                                                                                                           |
| `verify:compose`          | Builds the image and verifies the Compose runtime on Docker or Podman (loopback-only publishing, non-root, read-only rootfs, healthcheck, in-container SSR/hydration checks, `/data` persistence across recreate, clean shutdown). Exits 2 with `NOT RUN` if no container engine is available                                                                                                             |
| `verify`                  | Builds, then runs the real production server on an ephemeral loopback port with a temporary `DATA_DIR`. It checks health JSON, server HTML without JS, CSP nonce wiring, API/asset/document 404 separation, browser hydration (production and development builds) with no warnings, the signed-in chat flow, persistence across restarts, account isolation, logout, disabled accounts and clean shutdown |
| `perf:check`              | Checks the production build against `performance-budget.json` (gzip JS/CSS per route group, 10% tolerance); also part of `verify`                                                                                                                                                                                                                                                                         |
| `perf:trace`              | Builds, then prints a throttled before/after trace (TTFB, first paint, hydration, ComposerTTI, send path) on the E2E fixture                                                                                                                                                                                                                                                                              |

Configuration variables are documented in [`.env.example`](.env.example) and validated at startup.

## Quality gates

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run verify && npm run test:e2e
npm run verify:compose   # needs Docker or Podman
```

CI (`.github/workflows/ci.yml`) runs every gate on every push, plus `verify:compose` on Docker and on rootless Podman. Actions are pinned by commit SHA; the base image is pinned by digest. CI builds images but never publishes them.

## Layout

```text
app/        React Router route modules, root layout, server/client entries,
            components/ (shell, transcript, Markdown, dialogs) and lib/ (query, paths, API adapter)
server/     Express app, config, logging, CSP, errors, validation, API registry
shared/     Types and schemas shared by client and server (@shared/*)
tests/      Vitest (server, storage, jsdom components) and Playwright (e2e/) tests
scripts/    verify and dev orchestration
public/     Static files copied into the client build
data/       Persistent data (git-ignored): canonical Markdown, derived index, operation records
docs/       Phase reports
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the rendering model, HTTP boundary, CSP, API conventions and the invariant register. Phase reports are in [docs/phase-reports](docs/phase-reports).

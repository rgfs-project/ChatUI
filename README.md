# ChatUI

**A self-hosted, multi-user chat interface for your own language models.** ChatUI connects to [llama.cpp](https://github.com/ggml-org/llama.cpp) servers and other OpenAI-compatible endpoints. It keeps every conversation as a readable Markdown file you own and runs as one small Node.js process in a container.

- **Fast and resilient.** Pages are rendered on the server, so you can type before JavaScript has loaded. Replies are generated server-side: they survive reloads, dropped connections and server restarts, and are never stored twice.
- **Yours.** Chats, files, memories and settings live in one data directory as plain files. You can export everything as one ZIP, import it elsewhere, and back up or restore with a single command.
- **Multi-user.** Accounts, an administration area, per-account isolation, rate limits and a reviewed security model ([SECURITY.md](SECURITY.md)).
- **Accessible.** Keyboard-only operation, screen-reader announcements, WCAG 2.2 AA contrast in light and dark themes, and a phone layout.

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Connecting a model](#connecting-a-model)
- [Using ChatUI](#using-chatui)
- [Running it in production](#running-it-in-production)
- [Backups and data](#backups-and-data)
- [Security](#security)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)

## Features

| Area                 | What you get                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**             | Streaming replies with the model's reasoning shown separately ("Thought for 12s"). Stop, regenerate, edit and resend, delete a turn, a per-message model choice, and a **Think** toggle for reasoning models. Markdown with highlighted code, tables (copy as spreadsheet rows), math as MathML, and read aloud. |
| **Composer**         | Native text box: Enter sends, Shift+Enter adds a line, IME-safe. Attach images, audio and text files by picker, paste or drag. Paste from web pages as Markdown, dictate where the browser supports it, and type `/` for commands.                                                                               |
| **Organizing**       | Search across chats and files (Ctrl/⌘+K), pinned chats, projects (folders), temporary chats that disappear when you leave them, and a Library of every file you've uploaded or a reply created.                                                                                                                  |
| **Memory and tools** | Notes ChatUI keeps in mind in every chat. With tool-capable models: searching and reading your earlier chats and files, the time, a calculator, creating files, and suggesting memories (saved only when you choose Save).                                                                                       |
| **Rich replies**     | Interactive blocks in replies (cards, tabs, charts, quizzes, steps…), parsed and never run as code. Files a reply creates open as inert source. Optionally, HTML/SVG files run in an isolated **sandboxed preview** ([how it's contained](docs/threat-model-19.md)).                                             |
| **Your data**        | Canonical Markdown per chat, export and import of everything (with a preview and conflict choices), per-chat Markdown download, and an offline backup/restore CLI.                                                                                                                                               |
| **Accounts**         | Sign-in with Argon2id passwords, optional self-registration, a profile with photo and activity, and settings for theme, accent colour, text sizes, reduced motion and more.                                                                                                                                      |
| **Administration**   | Accounts, providers (with connection test), model visibility, sampling and system prompts, instance settings, a notice banner, maintenance and an audit log.                                                                                                                                                     |
| **Operations**       | Docker or rootless Podman Compose, non-root and read-only, a healthcheck, startup crash recovery, rate and resource limits, structured logs without secrets, and a strict CSP.                                                                                                                                   |

## Quick start

You need **Docker** (or **Podman**) and a llama.cpp server (or try the [demo](#try-it-without-a-model) first).

```bash
git clone https://github.com/rgfs-project/ChatUI.git
cd ChatUI
cp .env.example .env          # then set LLAMA_BASE_URL (and LLAMA_API_KEY) in .env
docker compose up -d --build
```

Create the first admin account. The password is asked for at a prompt, never on the command line:

```bash
docker compose exec chatui node server/cli.ts user:create --username admin --admin
```

Open **http://localhost:3000** and sign in.

<details>
<summary>Rootless Podman</summary>

```bash
podman compose up -d --build
# or with ./data bind-mounted and SELinux-labelled:
mkdir -p data && podman compose -f compose.yaml -f compose.podman.yaml up -d --build
```

</details>

### Try it without a model

```bash
npm ci
npm run demo
```

This starts http://localhost:3000 with a built-in mock model, sample chats and two accounts: `demo` (an admin) and `demo2`, both with the password `demo password 1234`. Data goes to `./demo-data`; delete that folder to start over.

## Connecting a model

Set `LLAMA_BASE_URL` (and `LLAMA_API_KEY`) in `.env` to an address **the container can reach**. That means a LAN address, `host.containers.internal` (Podman), or `host.docker.internal` with the `extra_hosts` entry in `compose.yaml` (Docker on Linux). Inside the container, `localhost` is the container itself. Check the connection with:

```bash
docker compose exec chatui node server/cli.ts provider:check
```

On first start ChatUI writes `DATA_DIR/_system/providers.json` from those variables. From then on that file is the source of truth: edit it in **Administration → Providers** (applied immediately), or by hand and restart. Several providers can be configured, and you can switch provider and model at any point in a chat.

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
      "capabilities": { "inputModalities": ["text", "image"], "reasoning": true, "tools": false },
      "contextTokens": 32768
    }
  ]
}
```

- **`capabilities`** tell ChatUI what the models can do:
  - `inputModalities`: images and audio are only sent to models that accept them.
  - `reasoning`: shows the Think toggle.
  - `tools`: enables memory suggestions and the general tools.

  Turn `tools` on only after `node scripts/probe-provider.ts` shows that your model handles tool calls. See [docs/provider-notes.md](docs/provider-notes.md) for what has been verified against llama.cpp.

- Optional per provider: `timeoutMs`, `maxActiveGenerations` (defaults to the server's reported slots, else 1) and `contextTokens` (defaults to discovery).
- The file contains secrets. ChatUI writes it `0600`, and keys never appear in any response or log.
- **Network policy:** provider URLs are checked against an SSRF policy. Cloud metadata and link-local addresses are always refused, every request re-resolves and pins the address, and redirects are never followed. Private and loopback hosts are allowed by default (`ALLOW_PRIVATE_PROVIDER_HOSTS`); `PROVIDER_HOST_ALLOWLIST` can restrict hosts further.

## Using ChatUI

- **`/` starts a new chat.** Every chat has its own address (`/chat/<id>`), so links, reloads and Back/Forward work as expected. A reply keeps streaming if you reload or briefly lose the connection.
- **Under your messages:** Copy, Edit (resend from there) and Delete. **Under replies:** Copy, Read aloud, Regenerate, Good/Bad, Share and More.
- **Search** with Ctrl/⌘+K: chats by title and text, files by name; a result jumps to the match.
- **The `/` menu** in an empty composer: switch model, read the last reply aloud, rename the chat, move it to a project, or start a new chat.
- **Temporary chat:** the toggle on a new chat. It stays out of your history, search, Library, exports and memory, and is deleted when you leave it.
- **Settings**, from the account menu:
  - **General:** default model.
  - **Memory:** your notes.
  - **Data:** export, import, delete all chats.
  - **Appearance:** theme, accent, text sizes, reduced motion, interactive blocks, file previews.
  - **Files:** image size and history.
  - **Account:** password, sign out.
  - **Keyboard shortcuts.**
- **Keyboard:** everything works without a mouse. Ctrl/⌘+Shift+O starts a new chat and Ctrl/⌘+Shift+S toggles the sidebar.

## Running it in production

### What the container does

- Publishes **only on `127.0.0.1`** (`HOST_PORT`, default 3000).
- Runs as the unprivileged `node` user, with a read-only root filesystem, all capabilities dropped and `no-new-privileges`.
- Keeps all state in the `/data` volume, which survives `down`/`up`, recreation and image updates (`docker compose down -v` deletes it).
- Has a healthcheck and `restart: unless-stopped`. Updating is `git pull && docker compose up -d --build`.

### LAN and phone access

Cookies are `Secure` behind https. ChatUI supports two transports:

1. `http://localhost`, on the machine that runs it (the default).
2. An **https** URL served by a TLS-terminating reverse proxy. Set `PUBLIC_ORIGIN` to that URL and `TRUST_PROXY` to the number of proxy hops. Plain-http access from other machines is refused at startup.

Caddy:

```text
chat.example.com {
    reverse_proxy 127.0.0.1:3000
    header Strict-Transport-Security "max-age=31536000"
}
```

```bash
PUBLIC_ORIGIN=https://chat.example.com TRUST_PROXY=1 docker compose up -d
```

Tailscale (reachable from your tailnet, including phones):

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net TRUST_PROXY=1 docker compose up -d
```

### Accounts and administration

- Registration is **closed** by default. Create accounts with the CLI or in **Administration → Accounts**, or set `REGISTRATION_MODE=open` (also switchable in Administration).
- Administration (`/admin`, admins only, checked on the server for every request) covers:
  - **Accounts:** create, promote, disable, set a password, delete. The last admin is protected.
  - **Providers:** add, edit, test, remove. Keys are write-only.
  - **Models:** visibility, sampling, system prompts with `{{username}}`, `{{date}}`, `{{timezone}}` and `{{time}}`.
  - **Instance:** registration, default model, notice banner, output cap, time zone.
  - **Maintenance and audit log.**
- Locked out of every admin account? `docker compose exec chatui node server/cli.ts user:reset-password --username admin`.

### Command line

All commands run as `node server/cli.ts <command>` (in the container: `docker compose exec chatui node server/cli.ts …`). Passwords are read from a prompt or stdin, never from arguments.

| Command                                   | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `serve`                                   | Start the server (default)                            |
| `healthcheck`                             | Exit 0 if the server answers                          |
| `provider:check`                          | Reach `LLAMA_BASE_URL` and count its models           |
| `user:create --username <name> [--admin]` | Create an account                                     |
| `user:reset-password --username <name>`   | Set a password and sign the account out everywhere    |
| `index:rebuild`                           | Rebuild derived indexes (server stopped)              |
| `backup --out <dir> [--with-sessions]`    | Offline backup (server stopped)                       |
| `restore --from <dir>`                    | Restore into an empty data directory (server stopped) |

### Configuration

Every variable is documented in [`.env.example`](.env.example) and validated at startup; invalid configuration stops the process with a clear message. The most important ones:

| Variable                                                    | Default                              | Purpose                                              |
| ----------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `PUBLIC_ORIGIN`                                             | `http://localhost:3000`              | The URL people use (https behind a proxy)            |
| `TRUST_PROXY`                                               | `0`                                  | Number of reverse-proxy hops to trust                |
| `LLAMA_BASE_URL`, `LLAMA_API_KEY`                           | —                                    | First provider (bootstraps `providers.json`)         |
| `REGISTRATION_MODE`                                         | `closed`                             | `open` allows self-registration                      |
| `MAX_ATTACHMENT_BYTES`, `USER_STORAGE_QUOTA_BYTES`          | 25 MB, 1 GB                          | File size and per-account storage                    |
| `RATE_LIMIT_GENERATIONS` / `_UPLOADS` / `_ADMIN` / `_LOGIN` | 30 / 60 / 120 per min, 10 per 15 min | Per-account limits (per process)                     |
| `MAX_CONNECTIONS`, `REQUEST_TIMEOUT_MS`                     | 1024, 10 min                         | HTTP server limits                                   |
| `PREVIEW_ORIGIN`                                            | —                                    | Optional separate origin for sandboxed file previews |

## Backups and data

**Everything lives in `DATA_DIR`** (`/data` in the container) as files you can read:

```text
data/
  <user-id>/
    chats/<chat-id>.md        one conversation, canonical Markdown (formatVersion 1)
    attachments/<id>/         uploaded files (blob + meta.json)
    artifacts/<id>/           files created by replies
    memories/<id>.md          memory notes
    preferences.json, profile/, operations/, index/ (derived, rebuilt when missing)
  _system/
    providers.json            provider config, including API keys (secret)
    settings.json, audit/, sessions/, generations/ (recovery records)
```

Chat files can be read and hand-edited; edits appear after a restart. A file that no longer parses is listed as unreadable and never changed by ChatUI.

**Back up with the CLI** (the server must be stopped; the command refuses while one is running, even from another container):

```bash
docker compose stop chatui
docker compose run --rm -v "$PWD/backups:/backups" chatui backup --out /backups/$(date +%F)
docker compose start chatui
```

`backup` first finishes any crash recovery, then copies the data with a checksum for every file. It leaves out derived indexes, temporary staging and, unless you pass `--with-sessions`, sign-in sessions. **`restore`** only writes into an empty data directory: it verifies every checksum and refuses unknown files before writing anything, then checks that the restored data starts. **Backups contain user content and secrets**: store them as carefully as the data itself.

Without the CLI, stop the server (or use a filesystem snapshot) and copy all of `DATA_DIR`.

Exactly **one ChatUI process** may use a data directory. A running server holds `_system/server.lock`, and a second one logs a warning.

## Security

ChatUI has had a full security review; [SECURITY.md](SECURITY.md) maps each control to its code and tests and lists the known exceptions. In short:

- **Sessions:** server-side, stored only as hashes, rotated on sign-in, revoked on password, role or status changes.
- **CSRF and validation:** CSRF protection on every change. Strict request schemas reject unknown fields, and responses are explicit DTOs.
- **Isolation:** every user's data is isolated at the storage boundary, and all file paths are server-generated.
- **Untrusted content:** model output is treated as hostile. Markdown never renders raw HTML, links are filtered, interactive blocks are parsed rather than executed, and files created by replies are served as inert text. Optional previews run in an opaque-origin sandbox with no network ([threat model](docs/threat-model-19.md)).
- **Headers:** a strict Content-Security-Policy with a per-response nonce (no `unsafe-inline` scripts), `Permissions-Policy`, no framing, no third-party assets, no service worker.
- **Limits:** rate limits, upload sniffing (SVG/HTML refused), quotas, and bounded imports (ZIP-bomb safe).

Please report vulnerabilities privately (a GitHub security advisory) rather than in a public issue.

## Development

Prerequisites: **Node.js 24.21** (`.nvmrc`), npm 11, and Playwright's Chromium for browser tests (`npx playwright install chromium`).

```bash
npm ci
cp .env.example .env
LLAMA_BASE_URL=http://<llama-host>:8080 npm run dev     # http://127.0.0.1:3000 with HMR
```

The stack:

- React 19 with React Router 8 Framework Mode (server-side rendering);
- TanStack Query, Radix primitives and Lucide icons;
- Express 5, Zod and Pino;
- Vite 8 and TypeScript 6 (strict);
- Vitest and Playwright.

### Quality gates

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run verify && npm run test:e2e
```

| Script             | What it checks                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`             | Unit and HTTP integration tests (Vitest)                                                                                                                                                                                      |
| `verify`           | Builds, then exercises the real production server: SSR without JavaScript, CSP, hydration, sign-in, streaming, persistence across restarts, isolation, backup/restore, clean shutdown; includes `perf:check` (bundle budgets) |
| `test:e2e`         | The Playwright browser suite against the production build and a deterministic mock model, including accessibility scans (axe) in both themes                                                                                  |
| `verify:compose`   | Builds the image and verifies it on Docker or Podman                                                                                                                                                                          |
| `clean-checkout`   | From a fresh clone: install, build, create an admin, hold a conversation in a browser                                                                                                                                         |
| `audit:invariants` | Breaks each documented invariant on purpose and requires its tests to fail ([results](docs/invariant-audit.md))                                                                                                               |
| `demo`             | A self-contained instance with a mock model                                                                                                                                                                                   |

CI runs every gate on each push, plus the clean-checkout proof and the container checks on Docker and rootless Podman. Actions are pinned by commit SHA and the base image by digest.

### Layout

```text
app/        React Router routes, chat UI (app/chat), primitives (app/ui), styles
server/     Express app, API registry, auth, providers, generations, storage, CLI
shared/     Types and schemas shared by client and server
tests/      Vitest (server, storage, client) and Playwright (e2e)
scripts/    verify, demo, audits, provider probe
docs/       Roadmap, threat models, audits, phase reports
```

## Known limitations

- **Importing Claude exports** is not available yet: it is waiting for real export samples to test against.
- **Tool calls and the Think switch** are implemented against the OpenAI-compatible API but have not been verified against a live llama.cpp server; both are off unless you enable `tools`/`reasoning` for a provider ([provider notes](docs/provider-notes.md)).
- **Single process** per data directory, and rate limits are counted per process.
- No automated screen-reader test runs in CI (accessibility is checked with axe and the accessibility tree).
- Linux containers are the supported runtime. Directory fsync and rename semantics differ on Windows.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): rendering model, HTTP boundary, storage format, recovery, and the invariant register.
- [SECURITY.md](SECURITY.md): the security review and exceptions.
- [docs/provider-notes.md](docs/provider-notes.md): observed llama.cpp behaviour.
- [docs/threat-model-14b.md](docs/threat-model-14b.md): interactive blocks.
- [docs/threat-model-19.md](docs/threat-model-19.md): file previews.
- [docs/invariant-audit.md](docs/invariant-audit.md) and [docs/primitives-audit.md](docs/primitives-audit.md).
- [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/phase-reports](docs/phase-reports): how it was built.

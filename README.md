# ChatUI

A self-hosted AI chat frontend: React 19 + React Router Framework Mode **server-side rendering from the first commit**, one Express 5 process, canonical Markdown storage (from Phase 3), and server-owned generation.

> **Status: Phase 1b (Compose packaging and CI).** The app currently serves a public, server-rendered status page and `GET /api/health`. Chat, storage, authentication and providers arrive in later phases. Until authentication (Phase 4) ChatUI is reachable from `127.0.0.1` only, both on the host and through Compose.

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

- publishes **only on `127.0.0.1`** and must not be exposed further before Phase 4 authentication;
- runs as the unprivileged `node` user (UID 1000) with a read-only root filesystem, all capabilities dropped and `no-new-privileges`;
- keeps all persistent state in the `/data` volume (`chatui-data` by default), which survives `docker compose down`/`up`, recreate and image updates. Only `docker compose down -v` deletes it;
- has a built-in healthcheck and `restart: unless-stopped`;
- has the stable entrypoint `node server/cli.ts <command>`, e.g. `docker compose exec chatui node server/cli.ts healthcheck`.

Operator commands are introduced as their services exist. Until then they exit with status 2 and a message; they never pretend to succeed:

| Command                                                   | Available from |
| --------------------------------------------------------- | -------------- |
| `serve` (default), `healthcheck`                          | Phase 1b       |
| `index:rebuild`                                           | Phase 3        |
| `user:create` (password via stdin), `user:reset-password` | Phase 4        |
| `backup`, `restore`                                       | Phase 16       |

Updating: `git pull && docker compose up -d --build`. The `/data` volume is reused.

To reach a llama.cpp server on the host from the container, use the host's LAN address or `host.docker.internal` (Docker Desktop) / `host.containers.internal` (Podman). `localhost` inside the container is the container itself. Provider configuration arrives in Phase 2.

## Install (development)

```bash
npm ci
```

## Run

```bash
cp .env.example .env        # optional; defaults are safe
npm run dev                 # http://127.0.0.1:3000 with HMR
```

| Script                    | Purpose                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dev`                     | Runs `dev:server` and `dev:client` together                                                                                                                                                                                                                                                            |
| `dev:server`              | Express + embedded Vite (HMR); restarts on `server/` and `shared/` changes                                                                                                                                                                                                                             |
| `dev:client`              | React Router route type generation in watch mode                                                                                                                                                                                                                                                       |
| `build`                   | Production browser bundle (`build/client`) and SSR bundle (`build/server`)                                                                                                                                                                                                                             |
| `start`                   | Production server from the build (`NODE_ENV=production`)                                                                                                                                                                                                                                               |
| `preview`                 | `build` then `start`                                                                                                                                                                                                                                                                                   |
| `test` / `test:watch`     | Vitest unit and HTTP tests                                                                                                                                                                                                                                                                             |
| `typecheck`               | Route typegen + `tsc` (strict)                                                                                                                                                                                                                                                                         |
| `lint`                    | ESLint (type-aware, strict)                                                                                                                                                                                                                                                                            |
| `format` / `format:check` | Prettier                                                                                                                                                                                                                                                                                               |
| `verify:compose`          | Builds the image and verifies the Compose runtime on Docker or Podman (loopback-only publishing, non-root, read-only rootfs, healthcheck, in-container SSR/hydration checks, `/data` persistence across recreate, clean shutdown). Exits 2 with `NOT RUN` if no container engine is available          |
| `verify`                  | Builds, then runs the real production server on an ephemeral loopback port with a temporary `DATA_DIR`. It checks health JSON, server HTML without JS, CSP nonce wiring, API/asset/document 404 separation, browser hydration (production and development builds) with no warnings, and clean shutdown |

Configuration variables are documented in [`.env.example`](.env.example) and validated at startup.

## Quality gates

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run verify
npm run verify:compose   # needs Docker or Podman
```

CI (`.github/workflows/ci.yml`) runs every gate on every push, plus `verify:compose` on Docker and on rootless Podman. Actions are pinned by commit SHA; the base image is pinned by digest. CI builds images but never publishes them.

## Layout

```text
app/        React Router route modules, root layout, server/client entries
server/     Express app, config, logging, CSP, errors, validation, API registry
shared/     Types and schemas shared by client and server (@shared/*)
tests/      Vitest + Supertest tests
scripts/    verify and dev orchestration
public/     Static files copied into the client build
data/       Persistent data boundary (git-ignored; unused until Phase 3)
docs/       Phase reports
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the rendering model, HTTP boundary, CSP, API conventions and the invariant register. Phase reports are in [docs/phase-reports](docs/phase-reports).

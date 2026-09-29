# ChatUI

A self-hosted AI chat frontend: React 19 + React Router Framework Mode **server-side rendering from the first commit**, one Express 5 process, canonical Markdown storage (from Phase 3), and server-owned generation.

> **Status: Phase 1a (application foundation).** The app currently serves a public, server-rendered status page and `GET /api/health`. Chat, storage, authentication and providers arrive in later phases. Until authentication (Phase 4) the server binds to `127.0.0.1` only.

## Prerequisites

- Node.js **24.21.0** (see `.nvmrc`; `nvm use`)
- npm 11
- For `npm run verify`: Playwright's Chromium (`npx playwright install chromium`, one-time download)

## Install

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
| `verify`                  | Builds, then runs the real production server on an ephemeral loopback port with a temporary `DATA_DIR`. It checks health JSON, server HTML without JS, CSP nonce wiring, API/asset/document 404 separation, browser hydration (production and development builds) with no warnings, and clean shutdown |

Configuration variables are documented in [`.env.example`](.env.example) and validated at startup.

## Quality gates

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run verify
```

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

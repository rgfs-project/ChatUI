# ChatUI

A self-hosted chat workspace. Conversations are plain Markdown files on disk, generation is
owned by the server, and the model provider is replaceable.

This repository is built in phases against a project contract kept outside the repository.
**Phase 14** is complete: the foundation and HTTP conventions, canonical Markdown persistence
with a rebuildable index, accounts with sessions and CSRF protection, multiple model providers
with SSRF-protected discovery, reconnectable streaming that survives a reload, a dropped
connection, or a restart, the chat interface and its conversation navigation, a resilient
client data layer, an admin surface with server-enforced authorization, per-user settings, a
layout that is responsive by design from a 390px phone to a wide desktop, and image and text
attachments with sniffed types, quotas, and per-model capability checks, and a security
hardening pass with rate limiting, a strict content security policy, a documented and
tested backup procedure, and a visual-polish and accessibility pass (WCAG 2.2 AA, axe-clean in
both themes, with a screen-reader live region for streaming).

Security controls, the exception register, and how to back up and restore are in
[`SECURITY.md`](SECURITY.md).

## Deploying it

This runs in a container, through Compose, and that is the supported way to run it. Docker
Compose and rootless Podman Compose are both supported and both tested. You need one of those
and nothing else — no Node, no npm, no build tools on the host. Everything an operator ever
has to do, including creating the first account and taking a backup, is a `compose` command.

### Install

```bash
git clone https://github.com/rgfs-project/ChatUI.git
cd ChatUI
cp .env.example .env          # edit LLAMA_BASE_URL; see "Pointing it at a model" below
docker compose up -d --build
docker compose run --rm -i app create-admin --username you --admin
```

The last command prompts for a password on stdin. Open <http://localhost:3001> and sign in.

That URL works as written **from the host only**. Before reaching this from any other
machine, read [TLS is not optional in production](#tls-is-not-optional-in-production) — over
plain HTTP on a LAN address, sign-in fails for a reason the error messages do not name.

Under Podman, substitute `podman-compose` for `docker compose` throughout — or `podman
compose`, which is a thin wrapper over the same. The one place the two differ is stdin, and
it is called out under [Podman](#podman) below.

### Pointing it at a model

**`localhost` inside a container is the container.** A provider running on the same machine is
not reachable at `http://localhost:8080` from inside it, and this is the single most common
reason a fresh deployment shows no models. Set `LLAMA_BASE_URL` in `.env` to match where
yours actually is:

| Where the provider runs        | `LLAMA_BASE_URL`                   | Notes                                                                                    |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| On this host                   | `http://host.docker.internal:8080` | Works on both engines — the compose file maps the name to the host gateway. Podman 4.7+. |
| Another machine on the LAN     | `http://192.168.1.50:8080`         | Nothing else to configure. Keep it on a private network.                                 |
| A service in this compose file | `http://llama:8080`                | The service name is the hostname. See below.                                             |
| Somewhere over the internet    | `https://llama.example.com`        | Use `https://`, and set `LLAMA_API_KEY`.                                                 |

`llama-server` must listen on an address the container can reach: `--host 0.0.0.0`, not its
default of loopback only. A provider bound to `127.0.0.1` on the host is invisible to every
container on the machine, whichever URL you give it.

To run the model server in the same project, add a service and use its name:

```yaml
# compose.override.yml — picked up automatically alongside docker-compose.yml
services:
  llama:
    image: ghcr.io/ggml-org/llama.cpp:server
    command: ['-m', '/models/your-model.gguf', '--host', '0.0.0.0', '--port', '8080']
    volumes:
      - ./models:/models:ro,z
  app:
    environment:
      LLAMA_BASE_URL: http://llama:8080
```

`LLAMA_BASE_URL` is read **once**, on the first start of a fresh volume, and written into
`/data/_system/providers.json`. After that the file is authoritative and the admin panel
edits it — so changing the variable later does nothing, by design: a restart must not undo a
provider somebody configured in the UI.

### Configuring it

Compose reads `.env` from this directory automatically. Everything in
[Configuration](#configuration) can go there; these are the ones a deployment usually sets:

| Variable           | What it is                                                                   |
| ------------------ | ---------------------------------------------------------------------------- |
| `LLAMA_BASE_URL`   | Where the model server is. See the table above.                              |
| `LLAMA_API_KEY`    | **Secret.** Bearer token, if the provider wants one. Leave empty if not.     |
| `RGFSCHAT_PORT`    | Host port to publish. Default `3001`.                                        |
| `TRUST_PROXY_HOPS` | Set to `1` if a reverse proxy forwards to this. See below.                   |
| `ADMIN_PASSWORD`   | **Secret.** Creates the first admin at boot instead of using `create-admin`. |

`.env` is git-ignored. Nothing secret belongs in `docker-compose.yml`, which is committed.

**Behind a reverse proxy, set `TRUST_PROXY_HOPS=1`.** At its default of `0` every request
appears to come from the proxy, so the per-address limits on login and registration become one
shared budget and the first caller to trip it locks out everybody. It is a count of proxies,
never `true` — see [`SECURITY.md`](SECURITY.md) E-2. Publishing on
`127.0.0.1:3001:3001` instead of `3001:3001` keeps everything but that proxy off the port.

### TLS is not optional in production

**With `NODE_ENV=production`, the session cookie is marked `Secure`, and a browser will not
send a `Secure` cookie back over plain HTTP.** Sign-in then fails in a way that looks like
nothing to do with TLS: the login request succeeds, the server logs `Account created` or a
successful sign-in, and every request after it is `UNAUTHENTICATED` because the cookie was
accepted and immediately discarded. The client bounces back to the sign-in page, retries, and
the retries trip the login rate limiter — so the visible symptom is usually a stack of
_Too many requests_, several layers removed from the cause.

The server warns about this at boot:

```text
Serving plain HTTP in production. Terminate TLS at a proxy, or set TLS_CERT_FILE and TLS_KEY_FILE.
```

This is easy to miss, because it does not happen on the machine you are testing from:
browsers treat `http://localhost` and `http://127.0.0.1` as secure origins and will send a
`Secure` cookie to them anyway. A LAN address such as `http://192.168.1.50:3001` is not a
secure origin and gets no such exemption — so a deployment that signs in perfectly from the
host fails the moment somebody opens it from another machine.

Take it literally. There are two ways to satisfy it, and the health check follows whichever
you choose.

**Terminate at a reverse proxy.** The proxy serves HTTPS, this stays on plain HTTP behind it,
and you set `TRUST_PROXY_HOPS=1` (see above). Publish on `127.0.0.1:3001:3001` so nothing but
the proxy can reach the port.

**Or terminate in the container**, which needs no second service and suits a single host on a
LAN. Generate a certificate — self-signed is fine for a private network — naming the address
you will actually browse to:

```bash
mkdir -p ~/chatui-tls
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout ~/chatui-tls/key.pem -out ~/chatui-tls/cert.pem \
  -subj "/CN=192.168.1.50" \
  -addext "subjectAltName=IP:192.168.1.50"
```

Mount it and point the server at it:

```yaml
services:
  app:
    volumes:
      - chatui-data:/data
      - /home/you/chatui-tls:/tls:ro,Z # :Z for SELinux; see Podman below
    environment:
      TLS_CERT_FILE: /tls/cert.pem
      TLS_KEY_FILE: /tls/key.pem
```

**The container reads those files as uid 1000, not as you**, so ownership is not enough — the
mounted directory needs `o+rx` and the files `o+r`:

```bash
chmod 755 ~/chatui-tls
chmod 644 ~/chatui-tls/cert.pem ~/chatui-tls/key.pem
```

That looks like a world-readable private key and is not one, provided the directory stays
inside a home directory of mode `700`: the bind mount is resolved by the engine, so the
container never traverses the parent, while another local user still cannot path their way in.
If you would rather not rely on that, keep the certificate outside `$HOME` under a directory
you control and restrict it there.

Then browse to `https://…`, not `http://`. A self-signed certificate is untrusted by
definition, so the browser will interrupt once; accept it and the cookie will persist from
then on.

Boot logs should show `"transport":"https"` and no plain-HTTP warning.

### Running it

```bash
docker compose up -d                 # start
docker compose ps                    # status, including health
docker compose logs -f app           # follow the logs
docker compose stop                  # stop, keeping the data
docker compose down                  # stop and remove the container, keeping the data
docker compose down -v               # ALSO DELETES THE DATA VOLUME
```

`down -v` is the only one of these that destroys anything. Everything else keeps the volume.

### Updating

```bash
git pull
docker compose up -d --build
```

The volume is not touched, so accounts, conversations, attachments, memories, artifacts and
provider configuration all carry across. Take a backup first if the upgrade spans a release
you have not read the notes for. To pin to a published image instead of building, replace
`build: .` in the compose file with `image: ghcr.io/rgfs-project/chatui:<sha>`.

### Operator commands

All of these run against the deployed image and the same volume. None of them needs anything
installed on the host, and none of them takes a password as an argument — where it would land
in shell history, in `ps`, and in `docker inspect`.

```bash
# Create an account (--admin for an administrator). Password on stdin.
docker compose run --rm -i app create-admin --username ada --admin

# Reset a forgotten password. Revokes existing sessions unless --keep-sessions.
printf 'new-password\n' | docker compose run --rm -T app reset-password --username ada

# Rebuild the derived conversation index from the canonical Markdown.
docker compose run --rm -T app rebuild-index

# Check health by hand, exactly as the engine does.
docker compose exec app entrypoint healthcheck && echo healthy
```

### Backup and restore

`/data` is the whole of the persistent state — accounts, conversations, attachments,
memories, artifacts, providers and settings. It is backed up as one archive, because it is
consistent with itself as a unit and a partial restore is a deployment that half works.

```bash
# Back up. Stop first for a quiet archive; a hot copy is readable but a
# conversation written mid-copy may or may not be in it.
docker compose stop
docker compose run --rm -T app backup > chatui-$(date +%F).tar
docker compose start
```

```bash
# Restore into a clean deployment. `restore` refuses a volume that is not
# empty, rather than merging two deployments together.
docker compose down -v
docker compose run --rm -T app restore < chatui-2026-01-01.tar
docker compose up -d
```

**The archive holds secrets** — password hashes, session tokens and the provider API key.
Store it the way you would store a password database.

### Troubleshooting

| What you see                                                                                   | What it is                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No models, provider shows _unavailable_                                                        | `LLAMA_BASE_URL` points somewhere the container cannot reach. See [Pointing it at a model](#pointing-it-at-a-model). Check with `docker compose exec app node -e "fetch('<url>/v1/models').then(r=>console.log(r.status)).catch(e=>console.log(e.cause))"`. |
| `Invalid environment configuration` and a restart loop                                         | A variable in `.env` is malformed. The message names it; the container never starts with a bad configuration.                                                                                                                                               |
| Container is `unhealthy`                                                                       | `docker compose logs app`. The probe follows `PORT` and the TLS variables, so it is a real failure, not a mismatch.                                                                                                                                         |
| Port already in use                                                                            | Set `RGFSCHAT_PORT` in `.env`.                                                                                                                                                                                                                              |
| `restore: /data is not empty`                                                                  | Deliberate. `docker compose down -v` first — restoring on top of existing data is not something to do by accident.                                                                                                                                          |
| Signed out constantly behind a proxy, or everyone locked out of login                          | `TRUST_PROXY_HOPS` is unset. See above.                                                                                                                                                                                                                     |
| Everything looks right but the page is blank                                                   | `docker compose logs app` — and check you are on the published port, not 3001, if you changed it.                                                                                                                                                           |
| Sign-in succeeds, then every request is `UNAUTHENTICATED` and you are back at the sign-in page | Plain HTTP with `NODE_ENV=production`. The session cookie is `Secure` and the browser is discarding it. See [TLS is not optional in production](#tls-is-not-optional-in-production).                                                                        |
| `Too many requests. Please wait and try again.`                                                | The login limiter: 20 attempts per address and 10 per username, per 15 minutes. Usually a **symptom** — something made the first attempt fail and the client retried. Fix that, then wait out the window; retrying only re-arms it.                         |
| `EACCES: permission denied, open '/tls/cert.pem'`                                              | The certificate is mounted but not readable by uid 1000. `chmod 755` the directory and `644` the files. Ownership alone is not enough.                                                                                                                      |
| `ENOENT: no such file or directory, open '/tls/cert.pem'`                                      | `TLS_CERT_FILE` names a path _inside_ the container and nothing is mounted there. Add the `volumes:` entry as well as the variable.                                                                                                                         |
| `EACCES: permission denied, mkdir '/data:ro,Z'`                                                | Mount options pasted into `DATA_DIR`. It is a plain path (`/data`); `:ro`, `:z` and `:Z` belong only on the `volumes:` line.                                                                                                                                |
| `Failed sign-in attempt` — the password you believe you set is refused                         | Reset it rather than guessing — `reset-password` under [Operator commands](#operator-commands). Usernames are case-insensitive, so capitalisation is never the cause.                                                                                       |

### Podman

Rootless Podman is supported and needs no privileged mode and no `--userns` flag. The state
lives in a **named volume** rather than a bind mount, so the engine owns it and gives it to
the container's user — which is what spares you the ownership and SELinux questions that a
bind mount raises. Mount anything of your own, such as a TLS certificate, and those questions
come back; see the end of this section. What differs from Docker:

- **Stdin.** `podman-compose run` does not attach stdin the way `docker compose run` does. For
  the commands above that read a password, pipe it and use `-T`, or use `podman run -i`
  directly against the volume:

  ```bash
  printf 'your-password\n' | podman run -i --rm -v workspace_chatui-data:/data \
    workspace_app:latest create-admin --username ada --admin
  ```

- **`HEALTHCHECK`.** Podman's default image format drops the instruction, which is why the
  compose file declares the health check itself as well as the image carrying one. Build with
  `podman build --format docker` if you want it in the image too.

- **Tearing down.** `podman-compose down` can fail part-way when several services share a
  pod, leaving containers running and the network undeletable. To restart one service, prefer
  `podman-compose up -d --force-recreate app` over a full `down` and `up`.

If you mount anything else from the host — a TLS certificate, a models directory — two
separate things have to be right, and only the first is about SELinux:

- Add `:z` (shared) or `:Z` (private) to the mount, so SELinux allows the container to read
  it. The commented examples in the compose file already do.
- Make it readable by **uid 1000 inside the container**, which is not your user. Under
  rootless Podman your uid maps to container root and the application's uid 1000 maps to a
  subuid that owns nothing of yours, so a file that is `600 you:you` is unreadable however
  correct it looks on the host. The mounted directory needs `o+rx` and the files `o+r`.

A mount that is missing the relabel and a mount that is missing the permission bits both fail
with `EACCES`, which is why it is worth checking both before changing either.

### The published image

A built image is published to GHCR and is public, so it needs no login to pull:

```bash
docker pull ghcr.io/rgfs-project/chatui:latest
```

Every build is also tagged with its commit SHA (`ghcr.io/rgfs-project/chatui:<sha>`); prefer
a SHA tag when you want a deployment pinned to an exact build rather than moving with
`latest`. To use it, replace the service's `build: .` with that image.

### What the container is

- A multi-stage build: the toolchain that compiles argon2 stays in the build stage, and the
  runtime image carries only the built server, the built client and production dependencies.
  No sources, no dev tooling, no tests, no development server, and no source directory mounted
  into it.
- Runs as `node` (uid 1000), never root, with every capability dropped and
  `no-new-privileges` set.
- Writes only to `/data`.
- Answers `HEALTHCHECK` on `/api/health`, over whichever scheme the server is actually
  listening on.
- Handles `SIGTERM` itself: in-flight generations are cancelled, the listener is closed, and
  the process exits 0. `stop_grace_period` is 30s so a slow disk mid-write is not `SIGKILL`ed.

### Verifying a deployment

[`scripts/compose-verify.mjs`](scripts/compose-verify.mjs) drives the real image through the
real compose file on a throwaway project and volume, and asserts the sequence above: a fresh
start, admin creation, sign-in, provider reachability, a generation, persistence across a
container recreation and an image rebuild, health, graceful shutdown, and a backup/restore
round trip through a destroyed volume.

```bash
npm run verify:compose                                   # docker compose
COMPOSE="podman-compose" npm run verify:compose          # podman
```

It is the one script here that needs Node on the host, because it is a test of the deployment
rather than part of it.

## Configuration

Copy `.env.example` to `.env`. Every variable has a safe default, so an empty file works.
The environment is validated once at boot and the process exits with a readable message if
it is invalid — never with a stack trace, and never echoing the offending value.

| Variable                 | Default                 | Purpose                                              |
| ------------------------ | ----------------------- | ---------------------------------------------------- |
| `NODE_ENV`               | `development`           | `development` \| `test` \| `production`              |
| `PORT`                   | `3001`                  | API port (client port under `npm run dev`)           |
| `API_PORT`               | `3001`                  | API port used by `npm run dev`                       |
| `DATA_DIR`               | `./data`                | Persistent boundary — conversations live here        |
| `LOG_LEVEL`              | `info`                  | `debug` \| `info` \| `warn` \| `error` \| `silent`   |
| `LOCAL_USER_ID`          | a fixed UUID            | Temporary single-user identity until Phase 4         |
| `VITE_API_TARGET`        | `http://localhost:3001` | Dev/preview proxy target                             |
| `LLAMA_BASE_URL`         | `http://127.0.0.1:8080` | llama.cpp `llama-server` endpoint                    |
| `LLAMA_API_KEY`          | _(unset)_               | **Secret.** Bearer token, if the server requires one |
| `PROVIDER_TIMEOUT_MS`    | `120000`                | Generous: a cold model load can take ~12 s           |
| `DEFAULT_CONTEXT_TOKENS` | `8192`                  | Fallback when a model's real context is unknown      |
| `MAX_OUTPUT_TOKENS`      | `2048`                  | Per-generation output cap                            |
| `TLS_CERT_FILE`          | _(unset)_               | PEM cert; with the key below, serves HTTPS directly  |
| `TLS_KEY_FILE`           | _(unset)_               | PEM private key; both or neither                     |
| `TRUST_PROXY_HOPS`       | `0`                     | Reverse proxies in front; see below                  |

`.env` is git-ignored and loaded natively by Node (`--env-file-if-exists`), so there is no
dotenv dependency.

**Behind a reverse proxy, set `TRUST_PROXY_HOPS`.** At its default of `0` no forwarding
header is believed and `req.ip` is the socket's peer — which behind a proxy is the proxy, so
the per-address limits on login and registration collapse into one shared budget and the
first caller to trip it locks out everybody. Set it to the number of proxies that actually
forward to this server (usually `1`). It is deliberately a count and never `true`: trusting
the whole `X-Forwarded-For` chain would let a caller write their own address into it and
leave the limit behind entirely. See [`SECURITY.md`](SECURITY.md) E-2.

## Talking to llama.cpp

Point `LLAMA_BASE_URL` at a running `llama-server`. Before trusting any assumption about how
it behaves, run the probe against it:

```bash
npm run probe:provider
```

It reports auth behaviour, the model-list shape, streaming chunk shapes, `reasoning_content`,
context-length discovery, and error responses. Findings are written up in
[`docs/provider-notes.md`](docs/provider-notes.md) — **that file, not the OpenAI spec, is what
the provider is implemented against.** Anything not observed live is marked UNVERIFIED.

Three things it turned up that are worth knowing if you run a router-mode server:

- **Model ids can contain spaces** (`Qwen Mini`), so they are URL-encoded and treated as opaque.
- **`GET /props?model=X` loads that model**, evicting the resident one. Context lengths are
  therefore discovered lazily, never enumerated at startup.
- **Reasoning can consume the entire output budget**, finishing cleanly with empty content.
  If replies come back blank, raise `MAX_OUTPUT_TOKENS`.

## Layout

```text
client/     React 19 app (Vite)
server/     Express 5 API
  provider/   llama.cpp client + an HTTP mock that replays observed wire shapes
  generation/ the server-owned generation state machine
shared/     Types used by both, imported as @shared/*
scripts/    dev, build-server, verify, probe-provider
docs/       provider-notes.md — observed provider behaviour
data/       Persistent boundary — committed empty; contents are never tracked
```

## On a phone

The interface is responsive by design rather than a shrunk desktop. One breakpoint at
**56rem (896px)**: above it the sidebar is a column beside the transcript, below it a modal
drawer over the page — with a backdrop, a focus trap, Escape and backdrop dismissal, and the
page behind marked `inert`. Menus become bottom sheets, panels go full-screen, and every
touch target is at least 44×44 CSS px on a coarse pointer.

The on-screen keyboard is handled in CSS alone. `interactive-widget=resizes-content` makes it
shorten the layout viewport, so the composer stays above the keys and the page itself never
becomes the scroll container. `viewport-fit=cover` plus `env(safe-area-inset-*)` keeps content
clear of a display cutout and the home indicator.

`e2e/mobile.spec.ts` covers 390×844, 402×714 (an iPhone 17 in Safari), 820×1180, 1440×900,
and the breakpoint at ±1px.

## Attachments

Images (PNG, JPEG, WebP, GIF), audio (WAV, MP3, FLAC) and text files (plain text, Markdown,
CSV, JSON) can be attached to a message by clicking the paperclip, dragging onto the composer,
or pasting an image.

**Video, PDFs and archives are refused.** No model here can read them, so storing them would
just be keeping files nothing could use.

Images and audio are only sent to a model that reports the matching input modality, and the
two are separate: on a typical llama.cpp server every Gemma and Qwen model accepts images,
while only some Gemma variants accept audio. The composer says so before you send, and the
server refuses otherwise.

The type is decided by reading the file's **bytes**, not its name or the `Content-Type` the
browser sends — so a script named `photo.png` is stored and served as text, never as an image.
SVG is rejected: it is an image to everyone who talks about it and a scriptable document to a
browser.

The first three are also administrator settings, which override these defaults without a
restart.

| Limit                      | Variable                              | Default            |
| -------------------------- | ------------------------------------- | ------------------ |
| Per file                   | `ATTACHMENT_MAX_BYTES`                | 10 MB              |
| Per account, in total      | `ATTACHMENT_MAX_TOTAL_BYTES_PER_USER` | 512 MB             |
| Unsent uploads kept for    | `ATTACHMENT_PENDING_TTL_MS`           | 24 hours           |
| Text inlined into a prompt | `ATTACHMENT_MAX_INLINE_CHARS`         | 100 000 characters |
| Per message                | fixed by the conversation format      | 10                 |

Which models can see or listen is discovered from the provider, not configured.

**Attachments are part of `data/` and therefore part of your backups.** They live under
`data/<user-uuid>/attachments/`, and a backup that excludes them will restore conversations
whose images and files are gone. There is no virus scanning — if you host this for other
people, put scanning in front of `data/` yourself.

## Artifacts a reply produced

A file a model presents is kept as an **artifact**: source, listed in the artifacts panel,
readable and downloadable, and outliving the conversation it came from. Deleting the chat
leaves the artifact and only breaks the back-link.

A reply says which of its code blocks are files, by naming them in the fence's info string:

````markdown
```html file="dashboard.html"
<!doctype html> …
```
````

The block stays in the transcript and renders as an ordinary code block; the artifact is
saved alongside it when the reply **completes**. Single quotes work, and the attribute may
come before or after the language word.

Nothing else is treated as a file. A plain ` ```html ` fence is a code block, a filename
in a sentence is a sentence, and a reply that was cancelled, failed, or stopped part-way
through a block saves nothing — half a file under the name of a whole one is worse than no
file. These extensions are saved, matched case-insensitively with the name kept as written:

`.html` `.htm` `.md` `.markdown` `.css` `.csv` `.js` `.jsx` `.mjs` `.json` `.svg` `.py` `.ts`
`.tsx` `.sql` `.yaml` `.yml`

Anything else is left as an ordinary code block. The instruction describing this is added to
the system prompt only when the server has an artifact store, so a model is never told about a
format that would be ignored.

**Artifacts are never executed or rendered.** An artifact is HTML, JavaScript or SVG as often
as not, and all three are scriptable documents; every one is stored as content and served back
as source, exactly like the import path does. The name is a display name and never a path —
`../../etc/passwd.md` is stored under a flattened name, not followed.

## Providers

Providers live in `/data/_system/providers.json`. It is written once, on the first start of a
fresh volume, from `LLAMA_BASE_URL` and `LLAMA_API_KEY` — and only if you actually set
`LLAMA_BASE_URL`, because bootstrapping from the default would give every new instance a
provider at `127.0.0.1:8080` that is usually not there.

After that the file is authoritative: the admin panel edits it, and the environment variable
is not consulted again. That is deliberate — a restart must not undo a provider somebody
configured in the UI.

```json
{
  "version": 1,
  "providers": [
    {
      "id": "local",
      "name": "Local llama.cpp",
      "kind": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8080",
      "apiKey": "optional-bearer-token",
      "timeoutMs": 120000,
      "capabilities": { "vision": true },
      "contextTokens": 131072
    }
  ]
}
```

> **This file holds secrets.** `apiKey` is stored in plaintext, so the file is written 0600
> and **any backup of `data/` must be treated as secret**. It never leaves the server: the
> API returns only `id`, `name`, `status`, and capabilities.

An invalid entry is disabled and logged rather than crashing startup, so one bad provider
cannot make the application unbootable. A provider that is unreachable shows as _unavailable_
and the others keep working; if discovery fails after having succeeded, the last known model
list stays selectable and is marked _stale_.

### Outbound request safety

Provider endpoints are checked before **every** request, not just when configured. Cloud
metadata and link-local addresses are blocked unconditionally, DNS is resolved and the
connection pinned to a checked address (which defeats DNS rebinding), and redirects are never
followed.

| Variable                       | Default   | Purpose                                                                                    |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------ |
| `ALLOW_PRIVATE_PROVIDER_HOSTS` | `true`    | Allow `127.0.0.1`, LAN, and other private ranges. Metadata ranges stay blocked either way. |
| `PROVIDER_HOST_ALLOWLIST`      | _(empty)_ | Comma-separated hostnames; when set, nothing else may be used.                             |

Set `ALLOW_PRIVATE_PROVIDER_HOSTS=false` if every provider is remote and you want the
strictest posture.

## Your data

Everything lives under `DATA_DIR` (default `./data`):

```text
data/<user-uuid>/chats/<conversation-uuid>.md   canonical — plain Markdown you can read,
                                                diff, grep, and edit by hand
data/<user-uuid>/index/chats.json               derived — a cache, safe to delete
```

Conversations are the source of truth. Edit one in your editor and the change is picked up on
the next read; run `npm run index:rebuild` (or just restart) to refresh the cached list.

If the server stops mid-reply, the partial text is kept: on the next start it is written to
the conversation marked `interrupted`, rather than vanishing or pretending to be a complete
answer. Closing the tab does **not** cancel a generation — reopening the conversation picks
the stream back up where it was.

**Backups: copy all of `data/`.** `index/` is optional — it is rebuilt from the Markdown when
missing, unparseable, or left half-written by a crash. Deleting `data/<user-uuid>/` removes
that user and everything they own.

A conversation file that cannot be parsed is **never** repaired, normalised, or rewritten. It
stays listed, reads and renames return `CONVERSATION_MALFORMED`, and you can still delete it.
Other conversations are unaffected.

### Single process only

Locking is in-memory, so **two servers sharing one `DATA_DIR` would not see each other's
locks** and could lose writes. Run exactly one process per `DATA_DIR`. Durability is
guaranteed on POSIX; on Windows the directory `fsync` barrier is unavailable and
rename-over-existing differs, so Windows is not covered by the durability guarantee.

## Architecture intent

The shape of the system is fixed by the project contract (`00-contracts.md`), kept outside
this repository, which every phase defers to.
The load-bearing decisions:

- **Markdown is canonical.** Conversations are files a user can read, diff, and back up.
  Indexes are derived and can be deleted at any time.
- **The browser is not trusted.** Identity comes from server-side state, never from a
  header or body. Every request is schema-validated and rejects unknown fields; every
  response is an explicit DTO.
- **One error contract.** Every failure leaves through a single boundary in the shape
  `{ error: { code, message, details? } }`. Unhandled errors become `INTERNAL` and expose
  nothing about the inside of the process.
- **`data/` is the persistence boundary.** Everything a user owns lives in one directory
  named by their UUID; deleting it removes them completely.

`ARCHITECTURE.md` tracks the invariant register and which tests enforce it.

## Developing from source

Everything above needs only a container engine. This section is for changing the code, and it
is the only part of this README that wants Node on your machine.

## Prerequisites

- Node 22 (`.nvmrc` pins the major; `nvm use` picks it up)
- npm 9+

## Install

```bash
npm ci
```

## Run

```bash
npm run dev
```

Starts the API on `http://localhost:3001` and the Vite dev server on
`http://localhost:5173`, which proxies `/api` to the API. Open the client URL; the page
calls `GET /api/health` and shows a loading, error, or result state.

The two dev processes deliberately use different port variables: `PORT` is the **client**
port, `API_PORT` is the API's. Sharing one variable makes the API fail with `EADDRINUSE`.

Run them separately with `npm run dev:client` / `npm run dev:server`.

## Build and serve

```bash
npm run build     # client → dist/client, server → dist/server
npm start         # runs the built server
npm run preview   # serves the built client, proxying /api
```

## Quality gates

Every gate runs in CI on each push, and all must pass before a phase is tagged.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
npm run test:e2e
```

`npm run index:rebuild` rebuilds the derived conversation index from the Markdown.

`test:e2e` drives a real browser against the built server with Playwright: reloading
mid-generation, losing the network and reconnecting, and cancelling. Install the browser once
with `npx playwright install chromium`.

`test:e2e:container` runs that **same suite, unchanged, against the container image** — so a
pass means the packaged image behaves like the tree it was built from, not merely that it
boots. It needs no `npm run build`, because the image carries its own:

```bash
npm run test:e2e:container                                   # ghcr.io/rgfs-project/chatui:latest
E2E_CONTAINER_IMAGE=localhost/chatui:dev npm run test:e2e:container
```

`E2E_CONTAINER_ENGINE` switches `podman` to `docker`. The fixture runs the image with
`--userns=keep-id`, so the bind-mounted `DATA_DIR` is owned by your uid and the tests that
seed conversations by writing files can still read them back, and with `--network=host`, so
the container reaches the mock provider on the host's loopback without any address rewriting.

`verify` is the one that matters most: it builds, boots the **real** server on a free port
with a throwaway `DATA_DIR`, and checks the health DTO, the canonical 404, and clean
shutdown on `SIGTERM`. Nothing is mocked.

### First run, from source

There are no accounts to begin with, and registration is closed by default, so create the
first admin from the command line:

```bash
npm run user:create -- --username ada --admin
```

The password is read from a prompt (or stdin, for scripting: `echo "…" | npm run user:create
-- --username ada --admin`). It is **never** accepted as a command-line argument, where it
would land in your shell history and in the process list.

Upgrading from Phase 3? Add `--adopt-local-data` to hand the existing
`data/<LOCAL_USER_ID>/` directory to the new account — nothing moves on disk:

```bash
npm run user:create -- --username ada --admin --adopt-local-data
```

Set `REGISTRATION_MODE=open` to let people sign themselves up.

#### Resetting a forgotten password

Every other reset path needs an admin session to start from — the admin panel
and the route behind it — so a forgotten administrator password would otherwise
leave no way in at all. This is that way in:

```bash
npm run user:password -- --username ada
```

The password is read from a prompt, or from stdin for scripting
(`printf 'new-password\n' | npm run user:password -- --username ada`). Like
`user:create` it is **never** accepted as a command-line argument — `--password`
is refused outright rather than ignored — so it cannot land in shell history or
in the process list.

Existing sessions are revoked by default: a reset is usually done because the
old password is suspect, and a session cookie outlives it. Pass
`--keep-sessions` when that is not what you want — changing your own password on
a machine you are already signed in on.

In a deployment, this is `reset-password` on the entrypoint — see
[Operator commands](#operator-commands). The two run the same code; the
difference is only whether it is the TypeScript source or the bundled build.

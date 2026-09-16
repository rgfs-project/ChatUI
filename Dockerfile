# ---- build stage -----------------------------------------------------------
# The full image, not slim: argon2 is a native module and needs a toolchain to
# compile. None of that follows into the runtime image.
FROM node:22-bookworm AS build
WORKDIR /app

# Dependencies first, on their own layer, so a source-only change does not
# re-run npm ci — the slowest step, because it compiles argon2.
#
# No `# syntax=` directive and no cache mounts, deliberately. Both require
# BuildKit to fetch an external frontend image before it will read this file,
# which turns every build — including the first one on a new machine, which is
# the one that has to work — into a dependency on a second registry being
# reachable. The saving was a warm npm cache between builds; the cost was a
# build that cannot start at all behind a restrictive proxy.
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline --no-audit --no-fund --loglevel=error

# Then the sources the build actually reads. Listed explicitly rather than
# `COPY . .` so the build cache is not busted by an unrelated file, and so the
# image can never accidentally include data/, .env, or the phase prompts.
COPY tsconfig.json vite.config.ts index.html ./
COPY scripts ./scripts
COPY shared ./shared
COPY server ./server
COPY client ./client

RUN npm run build

# A second, production-only dependency tree to copy into the runtime image.
# `npm ci` into a clean prefix keeps argon2's compiled binary but drops vite,
# esbuild, playwright and the rest of devDependencies.
RUN npm ci --omit=dev --prefer-offline --no-audit --no-fund --loglevel=error

# ---- runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="rgfschat" \
      org.opencontainers.image.description="Self-hosted chat workspace with Markdown-on-disk storage" \
      org.opencontainers.image.source="https://github.com/rgfs-project/ChatUI" \
      org.opencontainers.image.licenses="MIT"


# No init is installed here, and that is deliberate.
#
# The server installs its own SIGTERM and SIGINT handlers, so the classic PID 1
# problem — no default disposition, signals ignored — does not apply to it. What
# an init still buys is reaping, and the engine supplies one on request:
# `init: true` in the compose file, `--init` for a bare `docker run`. Compose is
# the supported way to run this (README), and it passes that flag.
#
# Installing one here instead would mean an apt layer, a package to keep
# patched, and a build that cannot succeed without reaching a Debian mirror —
# paid on every build, for something the engine already has.

# Only what runs: the built server and client, production node_modules, and the
# manifest. No sources, no dev tooling, no tests.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

# The persistent boundary (contracts §1). Declared a volume so its contents
# survive the container, and owned by the unprivileged user the server runs as
# — directories must be 0700, which the app also enforces at write time.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Never root. The one file tree the process writes to is /data, already owned
# by this user; everything else is read-only to it, which is the point.
USER node

ENV PORT=3001
EXPOSE 3001

# Answers on the health route the app already serves. `start-period` covers the
# generation-recovery pass that runs before the listener opens. Honoured by
# Docker; Podman ignores it unless the image is built with `--format docker`.
#
# The probe is a subcommand of the entrypoint rather than an inline one-liner
# so that it reads PORT and the TLS variables the same way the server does. An
# http:// probe against a TLS listener fails forever, which marks a perfectly
# healthy container unhealthy and deadlocks anything waiting on
# `service_healthy`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["entrypoint", "healthcheck"]

ENTRYPOINT ["entrypoint"]
CMD ["serve"]

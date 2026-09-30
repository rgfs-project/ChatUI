# syntax=docker/dockerfile:1
# ChatUI production image: one Node process serving the API, SSR documents and
# the prebuilt immutable client assets. Base image pinned by digest.
ARG NODE_IMAGE=docker.io/library/node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Full dependency set for the build.
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Builds both the SSR server bundle and the browser bundle.
FROM deps AS build
COPY . .
RUN npm run build

# Production-only dependencies.
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="ChatUI" \
      org.opencontainers.image.source="https://github.com/rgfs-project/ChatUI" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    LISTEN_HOST=0.0.0.0 \
    CHATUI_CONTAINER=1 \
    LOG_LEVEL=info
WORKDIR /app
# /data is the single persistent boundary, owned by the unprivileged runtime user.
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY server/cli.ts server/main.ts server/config.ts server/logger.ts server/loopback.ts \
  server/backup.ts server/http-limits.ts ./server/
COPY server/storage ./server/storage
COPY server/auth/passwords.ts server/auth/sessions.ts ./server/auth/
COPY server/providers/ssrf.ts ./server/providers/ssrf.ts
# Application files are root-owned and read-only for the runtime user.
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "server/cli.ts", "healthcheck"]
ENTRYPOINT ["node", "server/cli.ts"]
CMD ["serve"]

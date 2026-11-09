# syntax=docker/dockerfile:1
# The manythreads container of the Docker Compose install: the server AND the built web client, which it serves itself (MANYTHREADS_WEB_DIR,
# packages/server/src/web-static.ts), so the install needs no web server container. Build context = repo root (docker-compose.yml sets it):
#   docker build -f deploy/compose/manythreads.Dockerfile -t manythreads/manythreads:compose .
# `--build-arg WITH_MODELS=0` leaves out the speech model files (about 140 MB, fetched at build time and hash-checked; the app works without them, only
# on-device speech to text does not). The tests of the install build that way.

ARG WITH_MODELS=1

FROM node:22-slim AS models-1
WORKDIR /src
COPY clients/web/models.lock.json clients/web/models.lock.json
COPY clients/web/scripts/fetch-models.mjs clients/web/scripts/fetch-models.mjs
RUN node clients/web/scripts/fetch-models.mjs --out /models

FROM node:22-slim AS models-0
RUN mkdir /models

FROM models-${WITH_MODELS} AS models

FROM node:22-slim AS web
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @manythreads/web... \
    && pnpm --filter @manythreads/web build

FROM node:22-slim
ENV NODE_ENV=production CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# `git` is the repo-git plugin's engine (team repositories); nothing else of git's ecosystem is needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
COPY --from=web /app/clients/web/dist /app/web
COPY --from=models /models /app/web/models
# `manythreads-admin <command>` is the admin command line (`docker compose exec manythreads manythreads-admin init ...`); it needs no pnpm at run time.
RUN printf '%s\n' '#!/bin/sh' 'cd /app/packages/server && exec /app/node_modules/.bin/tsx src/cli/admin.ts "$@"' > /usr/local/bin/manythreads-admin \
    && chmod +x /usr/local/bin/manythreads-admin \
    && mkdir -p /data/storage /data/repos /hermes-profiles \
    && chown -R node:node /app /data /hermes-profiles
USER node
WORKDIR /app/packages/server
ENV PORT=3000 MANYTHREADS_WEB_DIR=/app/web MANYTHREADS_STORAGE_DIR=/data/storage MANYTHREADS_REPO_DIR=/data/repos MANYTHREADS_HERMES_PROFILES_DIR=/hermes-profiles
EXPOSE 3000
CMD ["/app/node_modules/.bin/tsx", "src/main.ts"]

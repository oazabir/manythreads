# syntax=docker/dockerfile:1
# manythreads web image. Build context = repo root:
#   docker build -f deploy/docker/web.Dockerfile -t manythreads/web:dev .
# The speech model files (PLAN P14-16): fetched and hash-checked against clients/web/models.lock.json in a stage of their own, so this layer is
# rebuilt only when the lock changes and the app build below never copies 140 MB of models. Needs network at build time, never at run time.
FROM node:22-slim AS models
WORKDIR /src
COPY clients/web/models.lock.json clients/web/models.lock.json
COPY clients/web/scripts/fetch-models.mjs clients/web/scripts/fetch-models.mjs
RUN node clients/web/scripts/fetch-models.mjs --out /models

FROM node:22-slim AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @manythreads/web... \
    && pnpm --filter @manythreads/web build

FROM nginx:alpine
COPY deploy/docker/nginx.conf /etc/nginx/templates/default.conf.template
ENV MANYTHREADS_SERVER_HOST=manythreads-server MANYTHREADS_SERVER_PORT=3000 MANYTHREADS_MCP_STREAM_TIMEOUT=1900s
COPY --from=build /app/clients/web/dist /usr/share/nginx/html
# Served at /models/<name>/<revision>/... (deploy/docker/nginx.conf); the revision in the path is why the files can be cached for good.
COPY --from=models /models /usr/share/nginx/html/models
EXPOSE 80

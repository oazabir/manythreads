# syntax=docker/dockerfile:1
# manythreads web image. Build context = repo root:
#   docker build -f deploy/docker/web.Dockerfile -t manythreads/web:dev .
FROM node:22-slim AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @manythreads/web... \
    && pnpm --filter @manythreads/web build

FROM nginx:alpine
COPY deploy/docker/nginx.conf /etc/nginx/templates/default.conf.template
ENV MANYTHREADS_SERVER_HOST=manythreads-server MANYTHREADS_SERVER_PORT=3000
COPY --from=build /app/clients/web/dist /usr/share/nginx/html
EXPOSE 80

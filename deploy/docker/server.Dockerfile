# syntax=docker/dockerfile:1
# Majlis server image. Build context = repo root:
#   docker build -f deploy/docker/server.Dockerfile -t majlis/server:dev .
FROM node:22-slim
ENV NODE_ENV=production CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false \
    && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@majlis/server", "start"]

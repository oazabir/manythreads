# syntax=docker/dockerfile:1
# manythreads server image. Build context = repo root:
#   docker build -f deploy/docker/server.Dockerfile -t manythreads/server:dev .
FROM node:22-slim
ENV NODE_ENV=production CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# `git` is the repo-git plugin's engine (team repositories, docs/plugins/repo-git.md); nothing else of git's ecosystem is needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# The installer the site serves at /install/ (the bridge as one bundle, its script and its manifest; docs/plans/agents-anywhere.md section 5.2) is made here, from the same sources.
RUN pnpm install --frozen-lockfile --prod=false \
    && node tools/agent-bridge/install/build.mjs \
    && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@manythreads/server", "start"]

# syntax=docker/dockerfile:1
# manythreads server image. Build context = repo root:
#   docker build -f deploy/docker/server.Dockerfile -t manythreads/server:dev .
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ENV NODE_ENV=production CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# `git` is the repo-git plugin's engine (team repositories, docs/plugins/repo-git.md); nothing else of git's ecosystem is needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# The installer the site serves at /install/ (docs/plans/agents-anywhere.md section 5.2) is built on the host before this image
# (tools/agent-bridge/install/build.mjs -> packages/plugins/bot-runners/install-dist) and comes in with COPY: building it here pulled the
# bridge's whole workspace into the image (4.5 GB instead of 1 GB, 2026-11-16). Without it the /install/ routes answer 404.
RUN pnpm install --frozen-lockfile --prod=false \
    && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@manythreads/server", "start"]

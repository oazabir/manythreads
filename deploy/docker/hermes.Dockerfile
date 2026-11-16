# syntax=docker/dockerfile:1
# Hermes agent image: the OFFICIAL Nous Research image, pinned by digest, repackaged on the paths the rest of the repo uses.
# Build context = repo root, but nothing of the repo is copied. Never vendored into this repo; docs https://github.com/nousresearch/hermes-agent.
#   docker build -f deploy/docker/hermes.Dockerfile -t manythreads/hermes:stable .
#
# Why not the installer (curl install.sh, pinned by sha256): upstream changed the script and the pin broke the build (MISTAKES.md,
# P26-24). The official image is a published, immutable artifact: the digest below cannot change under us.
# To update: pick a new tag on https://hub.docker.com/r/nousresearch/hermes-agent/tags (the plain version tag, never `-desktop`, never
# `latest`), copy its digest, change both HERMES_IMAGE and the version in the comment, rebuild, and run the smoke test in
# docs/plugins/hermes-pods.md (the gateway code in packages/plugins/runtime-hermes is written against that version's API).
# Built 2026-11: v0.22.6.
#
# What the official image is: Debian trixie, Hermes at /opt/hermes (a uv-managed venv whose interpreter lives in /opt/hermes/tools,
# so the tree is NOT relocatable and stays at /opt/hermes), s6-overlay as PID 1, user `hermes` uid 10000, HERMES_HOME=/opt/data, and
# 4.5 GB with a full Chromium, a download cache and a desktop web app that a headless team bot never uses. This file keeps the tree and the
# libraries, drops those extras (the browser the old installer's --skip-browser/--skip-computer-use dropped too) and does not take
# s6: the pod's entrypoint (deploy/images/hermes-pod) is the init.
#
# The contract the repo relies on, unchanged: user `node` (uid 1000), HOME=/home/node, Hermes state in /home/node/.hermes (no
# HERMES_HOME is set, so Hermes uses its default), the binary at /home/node/.local/bin/hermes, and `node` on PATH (sync.mjs).
ARG HERMES_IMAGE=nousresearch/hermes-agent:v0.22.6@sha256:d27689bc6e8581ec884a7227c9101fdaebf6c853cff8859020dac14f21452b4d
ARG DEBIAN_IMAGE=debian:trixie-20261020@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308

FROM ${HERMES_IMAGE} AS pruned
# Chromium (browser tool, 364 MB), the dependency download cache, the desktop web app. `tools/` keeps python, node, npm, uv, ripgrep: the
# venv's interpreter and the MCP servers' `npx` live there. ffmpeg stays (voice messages, speech tools): Hermes lists every package of its
# lock file at startup and prints "install out of sync" on stderr of each command when one is missing (Chromium is optional, ffmpeg is not).
RUN rm -rf /opt/hermes/tools/chromium-* /opt/hermes/uv-cache /opt/hermes/apps/desktop/dist-webapp /opt/hermes/.git

# Same Debian base as the official image (same digest), so the venv's native wheels and its python find the libraries they were built against.
FROM ${DEBIAN_IMAGE}
# The official image's runtime packages without the Chromium libraries and the extras only its supervisor needs. git/ssh/procps are what the
# agent's tools call; gcc/g++/make build the native extensions `hermes pm install` compiles on demand.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps xz-utils tmux libatomic1 libffi-dev gcc g++ make \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 node \
    && useradd -u 1000 -g node -m -d /home/node -s /bin/bash node
# The tree, byte for byte at its own path (read-only for `node`: root-owned, no group/other write), and the fixed SQLite the official
# image puts in front of Debian's (its python resolves libsqlite3.so.0 through ld.so).
COPY --from=pruned /opt/hermes /opt/hermes
COPY --from=pruned /usr/local/lib/libsqlite3.so.3.53.4 /usr/local/lib/
RUN ln -sf libsqlite3.so.3.53.4 /usr/local/lib/libsqlite3.so.0 \
    && ln -sf libsqlite3.so.3.53.4 /usr/local/lib/libsqlite3.so \
    && printf '/usr/local/lib\n' > /etc/ld.so.conf.d/000-sqlite-fixed.conf \
    && ldconfig \
    && ln -s /opt/hermes/tools/python-*-linux-x64/bin/python3 /usr/local/bin/python3 \
    && ln -s /opt/hermes/tools/node-*-linux-x64/bin/node /usr/local/bin/node \
    && ln -s /opt/hermes/tools/npm-*-linux-x64/bin/npm /usr/local/bin/npm \
    && ln -s /opt/hermes/tools/npm-*-linux-x64/bin/npx /usr/local/bin/npx \
    && ln -s /opt/hermes/tools/ripgrep-*-linux-x64/rg /usr/local/bin/rg \
    && ln -s /opt/hermes/tools/ffmpeg-*-linux-x64/bin/ffmpeg /usr/local/bin/ffmpeg \
    && ln -s /opt/hermes/tools/ffmpeg-*-linux-x64/bin/ffprobe /usr/local/bin/ffprobe \
    && mkdir -p /home/node/.local/bin /home/node/.hermes \
    && ln -s /opt/hermes/.venv/bin/hermes /home/node/.local/bin/hermes \
    && chown -R node:node /home/node
USER node
ENV HOME=/home/node \
    PATH=/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HERMES_RUNTIME_DIR=/opt/hermes/tools HERMES_PYTHON=/opt/hermes/.venv/bin/python \
    HERMES_WEB_DIST=/opt/hermes/hermes_cli/web_dist HERMES_TUI_DIR=/opt/hermes/ui-tui \
    CC=gcc CXX=g++
WORKDIR /home/node
RUN /home/node/.local/bin/hermes --version && hermes acp --help >/dev/null

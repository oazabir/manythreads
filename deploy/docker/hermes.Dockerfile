# syntax=docker/dockerfile:1
# Hermes agent image (demo only). Build context = repo root, but nothing of the
# repo is copied: the official installer runs here, as `node`, so the install
# lands on the exact paths the demo server layer copies
# (`/home/node/.hermes`, `/home/node/.local`). Never vendored into this repo;
# docs https://github.com/nousresearch/hermes-agent.
#   docker build -f deploy/docker/hermes.Dockerfile -t manythreads/hermes:stable .
FROM node:22-slim
# git/curl fetch the installer; the compilers build the pinned native
# extensions `pm install` compiles (their own Dockerfile installs the same set).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates build-essential cmake python3-dev libffi-dev \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /home/node && chown node:node /home/node
USER node
ENV HOME=/home/node
WORKDIR /home/node
# --skip-browser/--skip-computer-use are the installer's own opt-outs (a headless
# run needs neither); on failure the install log's tail is printed before exit.
# The installer is pinned by checksum: when upstream changes it the build stops, and a person reads the change and updates the sum.
# (It installs the upstream main branch of Hermes; the installer has no release-tag option, so the checksum is the pin. Built 2026-10: v0.22.5.)
ARG HERMES_INSTALLER_SHA256=abf338605dae6dd28d101673ac6aed7995c955745db46d47676bc591a7957209
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh \
    && echo "${HERMES_INSTALLER_SHA256}  /tmp/hermes-install.sh" | sha256sum -c - \
    && (bash /tmp/hermes-install.sh --skip-browser --skip-computer-use \
      || (tail -60 /home/node/.hermes/logs/install.log 2>/dev/null; exit 1)) \
    && rm /tmp/hermes-install.sh
# Drop the parts `hermes chat` never touches (video encoding, download caches,
# VCS history): the browser and computer-use tools were already skipped above.
# `installs/` stays: it is the committed dependency environment (`hermes pm
# repair` otherwise).
RUN rm -rf /home/node/.hermes/tools/ffmpeg-* \
    /home/node/.hermes/cache /home/node/.hermes/hermes-agent/.git
RUN /home/node/.local/bin/hermes --version

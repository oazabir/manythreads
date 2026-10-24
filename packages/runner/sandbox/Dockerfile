# The image a runner's agents run their shell commands in (SPEC §7.4; docs/plugins/runners.md): Node 22, pnpm, git and
# Python, so a coder / tester / reviewer bot can check a repository out, install, build and test it. Nothing of the host or of the
# platform is in it; the team's workspace directory is mounted at /workspace when a command starts.
#
#   docker build -t manythreads/runner-sandbox:1 packages/runner/sandbox
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-pip python3-venv make g++ jq ripgrep curl ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10 --activate \
 && git config --system --add safe.directory '*' \
 && mkdir -p /workspace

WORKDIR /workspace

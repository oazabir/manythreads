# syntax=docker/dockerfile:1
# The Claude Code runner's pod (docs/plugins/claude-pods.md): the agent bridge (tools/agent-bridge) as entry point, and the `claude` command it starts for every run.
# Build from a staged folder that holds this Dockerfile, repo-sync.sh and the bridge's source as `bridge/` (tools/devbox/deploy.sh makes it):
#   docker build -t manythreads/claude-pod:1 <staged folder>
# The version is pinned on purpose: a new `claude` can change what it writes to its sign-in file. The first stage is the same base as claude-pod-fake, so the layers are shared.
FROM node:22-slim
ARG CLAUDE_VERSION=2.1.318
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini procps && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" && npm cache clean --force
COPY bridge /opt/bridge
COPY repo-sync.sh /opt/claude-pod/repo-sync.sh
# uid 1000 is the image's `node` user; the pod runs as it with a read-only root (only /state, /work and /tmp are writable)
USER 1000:1000
ENV HOME=/state/home CLAUDE_CONFIG_DIR=/state/claude DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
WORKDIR /work
EXPOSE 8650
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "/opt/bridge/src/main.ts", "--config", "/etc/bridge/config.json", "--listen", "0.0.0.0:8650", "--state-dir", "/state/bridge"]

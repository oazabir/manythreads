# syntax=docker/dockerfile:1
# A STAND-IN for the Claude Code runner's pod: the same bridge and base as claude-pod, but `claude` is a small script that prints a canned reply (fake-claude.mjs).
# For checking the runner's plumbing without a real sign-in. It must never stay as the live image: values-live.yaml keeps claudePod.useFake false, and a check turns it on for a short window only;
# the pod is named for what it runs in its image tag (claude-pod-fake). Build from the same staged folder as claude-pod (deploy.sh), with fake-claude.mjs added.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini procps && rm -rf /var/lib/apt/lists/*
COPY bridge /opt/bridge
COPY repo-sync.sh /opt/claude-pod/repo-sync.sh
COPY fake-claude.mjs /usr/local/bin/claude
RUN chmod 0755 /usr/local/bin/claude
USER 1000:1000
ENV HOME=/state/home CLAUDE_CONFIG_DIR=/state/claude
WORKDIR /work
EXPOSE 8650
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "/opt/bridge/src/main.ts", "--config", "/etc/bridge/config.json", "--listen", "0.0.0.0:8650", "--state-dir", "/state/bridge"]

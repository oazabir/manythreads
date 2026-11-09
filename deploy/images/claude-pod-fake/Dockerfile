# syntax=docker/dockerfile:1
# A STAND-IN for the Claude Code and Codex runner's pod: the same bridge and base as claude-pod, but `claude` and `codex` are small scripts (fake-claude.mjs, fake-codex.mjs) that speak
# the real commands' JSON lines, call the run's MCP address for real and can be told to refuse, hit a limit or renew the sign-in file (words in the prompt, or /state/fake-mode).
# For checking the runner's plumbing without a real sign-in. It must never stay as the live image: values-live.yaml keeps claudePod.useFake false, and a check turns it on for a short window only;
# the pod is named for what it runs in its image tag (claude-pod-fake). Build from the same staged folder as claude-pod (deploy.sh), with fake-claude.mjs and fake-codex.mjs added.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini procps && rm -rf /var/lib/apt/lists/*
COPY bridge /opt/bridge
COPY repo-sync.sh /opt/claude-pod/repo-sync.sh
COPY keeper.mjs /opt/claude-pod/keeper.mjs
COPY fake-claude.mjs /usr/local/bin/claude
COPY fake-codex.mjs /usr/local/bin/codex
RUN chmod 0755 /usr/local/bin/claude /usr/local/bin/codex
USER 1000:1000
ENV HOME=/state/home CLAUDE_CONFIG_DIR=/state/claude CODEX_HOME=/state/codex
WORKDIR /work
EXPOSE 8650
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "/opt/bridge/src/main.ts", "--config", "/etc/bridge/config.json", "--listen", "0.0.0.0:8650", "--state-dir", "/state/bridge"]

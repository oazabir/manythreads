# syntax=docker/dockerfile:1
# A STAND-IN for the Claude Code and Codex runner's pod: the same bridge and base as claude-pod, but `claude` and `codex` are small scripts (fake-claude.mjs, fake-codex.mjs) that speak
# the real commands' JSON lines, call the run's MCP address for real and can be told to refuse, hit a limit or renew the sign-in file (words in the prompt, or /state/fake-mode).
# For checking the runner's plumbing without a real sign-in. It must never stay as the live image: values-live.yaml keeps claudePod.useFake false, and a check turns it on for a short window only;
# the pod is named for what it runs in its image tag (claude-pod-fake). Build from the same staged folder as claude-pod (deploy.sh), with fake-claude.mjs and fake-codex.mjs added (the staged folder already holds publisher.mjs, mt-publish-client.sh, mt-publish.sh and mt-askpass.sh).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini procps jq curl && rm -rf /var/lib/apt/lists/*
COPY bridge /opt/bridge
COPY repo-sync.sh /opt/claude-pod/repo-sync.sh
COPY keeper.mjs /opt/claude-pod/keeper.mjs
# The publisher container (decision E2, P19-09) is this same image started with `publisher.mjs serve`, as in claude-pod: the run container calls `mt-publish`, which only talks to it over a socket.
# deploy.sh stages these files into the build folder for both images (the claude-pod folder, plus the workbench's push script and askpass helper); jq and curl are what the script uses; uid 1001 is the publisher's.
COPY publisher.mjs mt-publish.sh mt-askpass.sh /opt/claude-pod/
COPY mt-publish-client.sh /usr/local/bin/mt-publish
COPY fake-claude.mjs /usr/local/bin/claude
COPY fake-codex.mjs /usr/local/bin/codex
RUN chmod 0755 /usr/local/bin/claude /usr/local/bin/codex /usr/local/bin/mt-publish /opt/claude-pod/mt-publish.sh /opt/claude-pod/mt-askpass.sh \
 && useradd --system --uid 1001 --no-create-home --shell /usr/sbin/nologin publisher
USER 1000:1000
ENV HOME=/state/home CLAUDE_CONFIG_DIR=/state/claude CODEX_HOME=/state/codex
WORKDIR /work
EXPOSE 8650
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "/opt/bridge/src/main.ts", "--config", "/etc/bridge/config.json", "--listen", "0.0.0.0:8650", "--state-dir", "/state/bridge"]

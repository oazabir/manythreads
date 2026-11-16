# syntax=docker/dockerfile:1
# The agent pod (docs/plugins/claude-pods.md): the agent bridge (tools/agent-bridge) as entry point, the two agents it drives over ACP (Claude Code and Codex, each through its
# adapter) and what an agent needs to code, test, deploy and check a page: git, pnpm, kubectl, helm and a browser. The image keeps the name manythreads/claude-pod (the name of the
# plugin that makes the pod) and the paths under /opt/claude-pod, so the stand-in image (claude-pod-fake) and the pod's spec do not change when this one does.
# Build from a staged folder that holds this Dockerfile, repo-sync.sh and the bridge's source as `bridge/` (tools/devbox/deploy.sh makes it):
#   docker build -t manythreads/claude-pod:1 <staged folder>
# The base is the workbench's own pinned Playwright image (same digest), so the k3s node already holds those layers (Chromium, Node 22, about 2 GB) and only the layers below are new.
# Every version below is pinned on purpose: a new `claude` or `codex` can change what it writes to its sign-in folder, and an adapter is checked against one version of each.
FROM mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a
ARG KUBECTL_VERSION=v1.36.5
ARG KUBECTL_SHA256=33bc88a24c3b09cf55bfd59e6ca977881b61fc3f25ab65bc80c65b430248648e
ARG HELM_VERSION=v3.22.0
ARG HELM_SHA256=1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb
# The two programs the adapters start, and the adapters (versions as measured in docs/spikes/acp-measured.md). `@openai/codex` 0.166.0 is also the version the driver's flags are checked against.
# the Claude Code version the adapter's SDK carries (checked at build time: the build stops if an adapter update changes it)
ARG CLAUDE_VERSION=2.1.323
ARG CODEX_VERSION=0.166.0
ARG CLAUDE_ACP_VERSION=0.107.0
ARG CODEX_ACP_VERSION=2.6.0
ARG PNPM_VERSION=10.28.0
ARG PLAYWRIGHT_VERSION=1.56.1
USER root
# `script` (bsdextrautils) is what the paste-code sign-in of Claude runs under (a terminal for a program that insists on one). tini is the entry point's init.
# The base has an `ubuntu` user at uid 1000 and a `pwuser` at 1001; the pod runs as uid 1000 with a read-only root, so those two are replaced by `agent` and the publisher's own user (1001).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini procps jq curl bsdextrautils \
 && rm -rf /var/lib/apt/lists/* \
 && (userdel -r ubuntu 2>/dev/null || true) \
 && (userdel -r pwuser 2>/dev/null || true) \
 && useradd --uid 1000 --user-group --home-dir /state/home --no-create-home --shell /bin/bash agent \
 && useradd --system --uid 1001 --no-create-home --shell /usr/sbin/nologin publisher \
 && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
 && echo "${KUBECTL_SHA256}  /usr/local/bin/kubectl" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl \
 && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" -o /tmp/helm.tgz \
 && echo "${HELM_SHA256}  /tmp/helm.tgz" | sha256sum -c - \
 && tar -xzf /tmp/helm.tgz -C /tmp linux-amd64/helm \
 && install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm \
 && rm -rf /tmp/helm.tgz /tmp/linux-amd64
# pnpm as a plain global package, not through corepack (corepack would write its download cache into the home folder of whoever starts it, and the root is read-only).
# `playwright` is the same package and version as the base image's browsers (the workbench installs it the same way): `npx playwright` and a repository's own test run find them.
# `claude` is the program the Claude adapter ships with (its SDK carries the Claude Code build of the same version number, CLAUDE_VERSION above), so one copy serves the adapter, the bridge's
# sign-in (`claude auth`) and a person's `claude --version`; a second copy from `@anthropic-ai/claude-code` would add 346 MB for nothing.
RUN npm install -g "pnpm@${PNPM_VERSION}" "playwright@${PLAYWRIGHT_VERSION}" "@openai/codex@${CODEX_VERSION}" \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" \
 && ln -s "/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude" /usr/local/bin/claude \
 && test "$(claude --version | cut -d' ' -f1)" = "${CLAUDE_VERSION}" \
 && npm cache clean --force
# The bridge's own source and the one package it needs at run time (the ACP client library; deploy.sh writes bridge/package.json from the bridge's dependencies), installed without scripts.
COPY bridge /opt/bridge
RUN cd /opt/bridge && npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY repo-sync.sh /opt/claude-pod/repo-sync.sh
COPY keeper.mjs /opt/claude-pod/keeper.mjs
# The publisher container (decision E2, P19-09) is this same image started with `publisher.mjs serve`; the run container calls `mt-publish`, which only talks to it over a socket.
# The push script and its askpass helper are the workbench's own files (deploy.sh stages them next to this Dockerfile); jq and curl are what the script uses.
COPY publisher.mjs mt-publish.sh mt-askpass.sh /opt/claude-pod/
COPY mt-publish-client.sh /usr/local/bin/mt-publish
# `mt-git` is the only git a bot may run without a question (the pod's approved command list names `mt-git <subcommand>` and never plain `git`): see mt-git.mjs.
COPY mt-git.mjs /opt/claude-pod/mt-git.mjs
COPY mt-git.sh /usr/local/bin/mt-git
RUN chmod 0755 /opt/claude-pod/mt-publish.sh /opt/claude-pod/mt-askpass.sh /usr/local/bin/mt-publish /usr/local/bin/mt-git \
 # no program in the image keeps a setuid or setgid bit: a bot has no way to become another user (the pod also sets allowPrivilegeEscalation: false)
 && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +
# Only /state, /work and /tmp are writable in the pod. The agents keep their sign-in and settings under /state; a later `npm`/`pnpm` cache goes there too.
# Playwright finds the browsers the base image already carries; the agents' own updaters are off.
ENV HOME=/state/home CLAUDE_CONFIG_DIR=/state/claude CODEX_HOME=/state/codex PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 npm_config_update_notifier=false npm_config_cache=/state/home/.npm
USER 1000:1000
WORKDIR /work
EXPOSE 8650
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/bridge/bridge.mjs", "--config", "/etc/bridge/config.json", "--listen", "0.0.0.0:8650", "--state-dir", "/state/bridge"]

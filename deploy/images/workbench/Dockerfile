# syntax=docker/dockerfile:1
# The workbench: the shell the managed bots work in (one container of the per-team Hermes pod; docs/plugins/hermes-pods.md).
# Microsoft's Playwright image brings Chromium and its libraries; this layer adds git, node + pnpm (already in the base node),
# python, kubectl, sshd and sudo, plus the small reconcile scripts that make one Unix user per bot.
#   docker build -f deploy/images/workbench/Dockerfile -t manythreads/workbench:1 deploy/images/workbench
FROM mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a
ARG KUBECTL_VERSION=v1.36.5
ARG KUBECTL_SHA256=33bc88a24c3b09cf55bfd59e6ca977881b61fc3f25ab65bc80c65b430248648e
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server sudo git python3 python3-pip python3-venv jq curl ca-certificates rsync \
    && rm -rf /var/lib/apt/lists/* \
    # the base image ships an `ubuntu` user (uid 1000); bots get their own users, so drop it
    && (userdel -r ubuntu 2>/dev/null || true) \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && echo "${KUBECTL_SHA256}  /usr/local/bin/kubectl" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/kubectl \
    && npm install -g playwright@1.56.1 && corepack enable && corepack prepare pnpm@10.28.0 --activate \
    && mkdir -p /run/sshd /etc/ssh/authorized_keys /etc/workbench \
    && groupadd --gid 3000 bots && groupadd --gid 3001 repo && useradd --uid 3001 --gid 3001 --no-create-home --shell /usr/sbin/nologin repo
COPY sshd_config /etc/ssh/sshd_config
COPY hooks/update /usr/local/share/workbench/hooks/update
COPY mt-reconcile.sh mt-lockdown.sh mt-repo-create.sh mt-receive-pack.sh entrypoint.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/mt-reconcile.sh /usr/local/bin/mt-lockdown.sh /usr/local/bin/mt-repo-create.sh /usr/local/bin/mt-receive-pack.sh /usr/local/bin/entrypoint.sh /usr/local/share/workbench/hooks/update \
    && printf '%s\n' '%bots ALL=(repo) NOPASSWD: /usr/local/bin/mt-repo-create.sh [a-z0-9]*, /usr/local/bin/mt-receive-pack.sh /workspace/repos/*.git' > /etc/sudoers.d/mt-repo \
    && chmod 0440 /etc/sudoers.d/mt-repo \
    # safe.directory entries are added per repository of record by mt-reconcile.sh (never the wildcard)
    && git config --system remote.origin.receivepack 'sudo -u repo /usr/local/bin/mt-receive-pack.sh' \
    && git config --system init.defaultBranch main \
    && git config --system receive.denyDeletes true
# Only sudo keeps a setuid/setgid bit: a bot has no other way to become another user.
RUN find / -xdev -type f \( -perm -4000 -o -perm -2000 \) ! -path /usr/bin/sudo ! -path '/usr/libexec/sudo/*' -exec chmod a-s {} +
# Playwright finds the browsers the base image already carries
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PNPM_HOME=/usr/local/share/pnpm PATH=/usr/local/share/pnpm:$PATH
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

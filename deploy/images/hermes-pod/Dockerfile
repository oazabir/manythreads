# syntax=docker/dockerfile:1
# The Hermes container of the per-team pod (docs/plugins/hermes-pods.md): Hermes Agent as the official installer lays it out
# (deploy/docker/hermes.Dockerfile builds manythreads/hermes:stable), plus the OpenSSH client (the profiles' terminal reaches the
# workbench container over ssh) and the sync script that turns the profile Secret into profile directories.
#   docker build -f deploy/docker/hermes.Dockerfile -t manythreads/hermes:stable .
#   docker build -f deploy/images/hermes-pod/Dockerfile -t manythreads/hermes-pod:1 deploy/images/hermes-pod
FROM manythreads/hermes:stable
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client procps tini && rm -rf /var/lib/apt/lists/*
COPY sync.mjs entrypoint.sh /usr/local/lib/hermes-pod/
RUN chmod 0755 /usr/local/lib/hermes-pod/entrypoint.sh
USER node
ENV HOME=/home/node PATH=/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /home/node
EXPOSE 8642
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/lib/hermes-pod/entrypoint.sh"]

# syntax=docker/dockerfile:1
# Demo server layer: the stock server image plus the Hermes agent entry point
# (`MANYTHREADS_HERMES_BIN=/home/node/.local/bin/hermes`). A separate layer so
# the ~1.5 GB agent install is built once and cached while server code iterates. The agent tree lives at /opt/hermes (its venv is not
# relocatable); /home/node/.local/bin/hermes is a link to it, and the fixed SQLite goes in front of the system one, as in hermes.Dockerfile.
# Needs manythreads/server:${SERVER_TAG} and manythreads/hermes:stable in the
# local daemon (tools/devbox/deploy.sh --demo builds both first):
#   docker build -f deploy/docker/server-demo.Dockerfile --build-arg SERVER_TAG=<tag> -t manythreads/server-demo:<tag> .
ARG SERVER_TAG=dev
FROM manythreads/server:${SERVER_TAG}
USER root
COPY --from=manythreads/hermes:stable /opt/hermes /opt/hermes
COPY --from=manythreads/hermes:stable /usr/local/lib/libsqlite3.so.3.53.4 /usr/local/lib/
RUN ln -sf libsqlite3.so.3.53.4 /usr/local/lib/libsqlite3.so.0 \
    && printf '/usr/local/lib\n' > /etc/ld.so.conf.d/000-sqlite-fixed.conf && ldconfig \
    && mkdir -p /home/node/.local/bin /home/node/.hermes \
    && ln -s /opt/hermes/.venv/bin/hermes /home/node/.local/bin/hermes \
    && chown -R node:node /home/node/.local /home/node/.hermes
USER node

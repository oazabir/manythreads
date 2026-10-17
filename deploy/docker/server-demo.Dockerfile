# syntax=docker/dockerfile:1
# Demo server layer: the stock server image plus the Hermes agent entry point
# (`MANYTHREADS_HERMES_BIN=/home/node/.local/bin/hermes`). A separate layer so
# the ~1.5 GB agent install is built once and cached while server code iterates.
# Needs manythreads/server:${SERVER_TAG} and manythreads/hermes:stable in the
# local daemon (tools/devbox/deploy.sh --demo builds both first):
#   docker build -f deploy/docker/server-demo.Dockerfile --build-arg SERVER_TAG=<tag> -t manythreads/server-demo:<tag> .
ARG SERVER_TAG=dev
FROM manythreads/server:${SERVER_TAG}
USER root
COPY --from=manythreads/hermes:stable --chown=node:node /home/node/.hermes /home/node/.hermes
COPY --from=manythreads/hermes:stable --chown=node:node /home/node/.local /home/node/.local
USER node

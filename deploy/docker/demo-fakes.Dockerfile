# syntax=docker/dockerfile:1
# Demo stand-ins image (NOT production): the fake-llm proxy and the
# fake-hindsight memory engine. Built on the server image for its runtime
# dependencies (node, tsx); only the two tool directories are added, because
# the server image's own ignore file excludes tools/.
# Needs manythreads/server:${SERVER_TAG} in the local daemon:
#   docker build -f deploy/docker/demo-fakes.Dockerfile --build-arg SERVER_TAG=<tag> -t manythreads/demo-fakes:<tag> .
ARG SERVER_TAG=dev
FROM manythreads/server:${SERVER_TAG}
USER root
COPY tools/fake-llm /app/tools/fake-llm
COPY tools/fake-hindsight /app/tools/fake-hindsight
RUN chown -R node:node /app/tools
USER node

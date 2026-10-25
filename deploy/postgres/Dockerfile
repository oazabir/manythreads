# syntax=docker/dockerfile:1
# manythreads/postgres:19 = postgres:19beta4 + pgvector (the dev and test database: deploy/compose, the test stacks). The k3s release runs
# deploy/postgres/cnpg.Dockerfile instead.
# Behind a TLS-intercepting proxy, pass its CA:
#   docker build --secret id=cacert,src=/path/ca-bundle.crt -t manythreads/postgres:19 deploy/postgres
#
# Pinned by digest: the upstream `19beta4` tag was rebuilt with a new catalog version on 2026-10-25, and a beta's data files open only with the
# build that wrote them (the dev volume of that day is kept as compose_manythreads_pgdata; the compose file now uses a new one). pgvector is
# compiled in a separate stage, because installing the server headers there upgrades that stage's server packages to whatever apt has today;
# only the extension's files are copied onto the pinned image.
ARG BASE=postgres:19beta4@sha256:946fd10fdac8a0e72ee1fd40c1ef074b5c8bcdddfb94bfd1597524c664243f64

FROM ${BASE} AS build
ARG PGVECTOR_REF=v0.8.7
RUN --mount=type=secret,id=cacert,required=false \
    set -eux; \
    if [ -f /run/secrets/cacert ]; then export GIT_SSL_CAINFO=/run/secrets/cacert; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential git ca-certificates postgresql-server-dev-19; \
    git clone --depth 1 --branch "${PGVECTOR_REF}" https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    make -C /tmp/pgvector OPTFLAGS=""; \
    make -C /tmp/pgvector OPTFLAGS="" DESTDIR=/out install

FROM ${BASE}
COPY --from=build /out/usr/lib/postgresql/19/lib/ /usr/lib/postgresql/19/lib/
COPY --from=build /out/usr/share/postgresql/19/extension/ /usr/share/postgresql/19/extension/

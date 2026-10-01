# syntax=docker/dockerfile:1
# majlis/postgres:19 = postgres:19beta4 + pgvector.
# Behind a TLS-intercepting proxy, pass its CA:
#   docker build --secret id=cacert,src=/path/ca-bundle.crt -t majlis/postgres:19 deploy/postgres
FROM postgres:19beta4

ARG PGVECTOR_REF=v0.8.7

RUN --mount=type=secret,id=cacert,required=false \
    set -eux; \
    if [ -f /run/secrets/cacert ]; then export GIT_SSL_CAINFO=/run/secrets/cacert; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential git ca-certificates postgresql-server-dev-19; \
    git clone --depth 1 --branch "${PGVECTOR_REF}" https://github.com/pgvector/pgvector.git /tmp/pgvector \
      || git clone --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    make -C /tmp/pgvector OPTFLAGS=""; \
    make -C /tmp/pgvector OPTFLAGS="" install; \
    rm -rf /tmp/pgvector; \
    apt-get purge -y --auto-remove build-essential git postgresql-server-dev-19; \
    rm -rf /var/lib/apt/lists/*

# syntax=docker/dockerfile:1
# The database image of the k3s release: CloudNativePG's own Postgres 19 build, pinned by digest, plus pgvector (CloudNativePG publishes no
# pgvector extension image for 19 yet). The digest is the build that wrote the live data: a Postgres beta's data files open only with the build
# that wrote them, so change it only together with a dump and restore or pg_upgrade.
#   docker build -f deploy/postgres/cnpg.Dockerfile -t manythreads/postgres-cnpg:19beta4-202609281634-u999 deploy/postgres
#
# pgvector is compiled in a separate stage: installing the build headers there upgrades that stage's server packages to whatever Postgres 19
# build apt has today. Only the extension's own files are copied onto the untouched pinned image (an extension is checked against the major
# version, 19, when it loads).
ARG BASE=ghcr.io/cloudnative-pg/postgresql:19beta4-202609281634-standard-trixie@sha256:9ad505e94fa41c39b5d679987401ecf5b05dd15c8621068ce6101b4036acaca2

FROM ${BASE} AS build
ARG PGVECTOR_REF=v0.8.7
USER root
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
# The live data files belong to uid/gid 999 (the chart's postgres.uid, from the first image). CloudNativePG's image names uid 26 `postgres`,
# and the operator's local login is peer-authenticated by that name, so the account takes 999 here instead: the data stays as it is.
USER root
RUN set -eux; \
    groupmod -g 999 postgres; usermod -u 999 -g 999 postgres; \
    find / -xdev \( -uid 26 -o -gid 26 \) -exec chown -h 999:999 {} +
USER 999

# STATUS

Current phase: **1 · Foundations** (in progress)

| Phase | State | Tag |
|---|---|---|
| 1 Foundations | in progress | |
| 2–13 | not started | |

## Phase 1 tasks
| ID | State | Notes |
|---|---|---|
| P1-01 scaffold | done, in review | 685e515 |
| P1-02 shared | done, in review | 460ce69 |
| P1-03 migrations | in progress | |
| P1-04 withActor/RLS harness | in progress | |
| P1-05 identity/events | todo | |
| P1-06 outbox/jobs | todo | |
| P1-07 plugin host | todo | |
| P1-08 capability broker | todo | |
| P1-09 transport/Fastify | todo | |
| P1-10 plate harness | todo | |
| P1-11 benchmarks | todo | |
| P1-12 PG19 probe | in progress | |
| P1-13 test-utils/web/CI/compose | web+CI+compose done (421c0c7); deploy infra in progress; test-utils todo | |

## Environment / blockers
- Postgres 19 is beta (19beta4) on Docker Hub; we build `majlis/postgres:19` from it + pgvector.
- SSH to the server is blocked from the sandbox; deploys run from GitHub Actions using secret ROOT_PASSWORD.
  Deploy rule (owner): pushing a version tag `v*` deploys latest `main`. Each phase exit: PR → main, tag `phase-N` + `v0.N.0`.
- Server: k3s v1.36 single node, traefik, local-path; helm/CNPG installed by the deploy action.
- Free-form ops workflows (run any command / SQL) were declined by the permission classifier — awaiting owner decision.

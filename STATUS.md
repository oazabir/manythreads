# STATUS

Current phase: **1 · Foundations** (in progress)

| Phase | State | Tag |
|---|---|---|
| 1 Foundations | in progress | |
| 2–13 | not started | |

## Phase 1 tasks
| ID | State | Notes |
|---|---|---|
| P1-01 scaffold | todo | |
| P1-02 shared | todo | |
| P1-03 migrations | todo | |
| P1-04 withActor/RLS harness | todo | |
| P1-05 identity/events | todo | |
| P1-06 outbox/jobs | todo | |
| P1-07 plugin host | todo | |
| P1-08 capability broker | todo | |
| P1-09 transport/Fastify | todo | |
| P1-10 plate harness | todo | |
| P1-11 benchmarks | todo | |
| P1-12 PG19 probe | todo | |
| P1-13 test-utils/web/CI/compose | todo | |

## Environment / blockers
- Postgres 19 is beta (19beta4) on Docker Hub; we build `majlis/postgres:19` from it + pgvector.
- SSH to 65.109.71.84:44033 is blocked by the sandbox egress policy (only HTTPS via proxy). Deploys to
  manythreads.kahf.to need either network policy change or a GitHub Actions deploy workflow with a secret.

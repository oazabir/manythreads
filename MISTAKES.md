# MISTAKES — read before starting work; append when something goes wrong

Format: `- [phase/task] what went wrong → what to do instead`

- [P1 env] Raw TCP (ssh on :44033) is blocked from the sandbox → don't attempt direct SSH; use the deploy path in STATUS.md.
- [P1 env] Docker daemon is not running at container start → `(dockerd >/tmp/dockerd.log 2>&1 &)` first.
- [P1 env] There is no `postgres:19` tag yet → use `postgres:19beta4` as base.
- [P1-01 env] `docker build` can't clone GitHub (TLS-intercepting proxy) → build with `docker build --secret id=cacert,src=/root/.ccr/ca-bundle.crt -t majlis/postgres:19 deploy/postgres`; compose reuses the existing image.
- [P1-01] pgvector v0.8.1 does not compile on PG19 (LWLock/slock_t headers moved) → use v0.8.7+ (Dockerfile default).
- [P1 review] One-off workflows with root SSH credentials left in the repo → delete them once used; prefer fixed-purpose workflows with validated inputs.

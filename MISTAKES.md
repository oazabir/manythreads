# MISTAKES — read before starting work; append when something goes wrong

Format: `- [phase/task] what went wrong → what to do instead`

- [P1 env] Raw TCP (ssh on :44033) is blocked from the sandbox → don't attempt direct SSH; use the deploy path in STATUS.md.
- [P1 env] Docker daemon is not running at container start → `(dockerd >/tmp/dockerd.log 2>&1 &)` first.
- [P1 env] There is no `postgres:19` tag yet → use `postgres:19beta4` as base.
- [P1-01 env] `docker build` can't clone GitHub (TLS-intercepting proxy) → build with `docker build --secret id=cacert,src=/root/.ccr/ca-bundle.crt -t majlis/postgres:19 deploy/postgres`; compose reuses the existing image.
- [P1-01] pgvector v0.8.1 does not compile on PG19 (LWLock/slock_t headers moved) → use v0.8.7+ (Dockerfile default).
- [P1 review] One-off workflows with root SSH credentials left in the repo → delete them once used; prefer fixed-purpose workflows with validated inputs.
- [P1 parallel] A kernel agent's untracked files were deleted mid-run by a parallel agent's git operation → parallel agents must never run git stash/clean/checkout/reset; commit own paths early; use 'git pull --rebase --autostash' only.
- [P1 review] RLS helpers trusted session GUCs (app.actor_kind) that any SQL can set → system privilege must come from a real role (current_user), never a settable GUC.
- [P1 e2e] Running playwright from repo root loads two @playwright/test copies → run via 'pnpm e2e' (pnpm -C e2e exec playwright test).
- [P1-13 deploy] On CNPG the owner role is not a superuser, so kernel migrations failed (`permission denied to create extension vector`, then `permission denied to alter role`) → chart creates extensions via `postInitApplicationSQL` (postInitSQL runs in the `postgres` db, not `majlis`) and makes `majlis_owner` SUPERUSER like dev compose; the deploy action re-applies both idempotently for existing clusters. CNPG accepted the PG19 beta image, so `postgres.mode: statefulset` stays unused.
- [P1-13 deploy] Image prune sorted tags by name and deleted the freshly imported image (ImagePullBackOff) → prune only tags that are neither the new tag nor used by a pod.
- [P1-13 deploy] `pnpm install --frozen-lockfile` failed in the image because tools/bench was missing from pnpm-lock.yaml → docker contexts exclude `tools/`; whoever owns the lockfile should re-run `pnpm install`.

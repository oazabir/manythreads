# MISTAKES — read before starting work; append when something goes wrong

Format: `- [phase/task] what went wrong → what to do instead`

- [P1 env] Raw TCP (ssh on :44033) is blocked from the sandbox → don't attempt direct SSH; use the deploy path in STATUS.md.
- [P1 env] Docker daemon is not running at container start → `(dockerd >/tmp/dockerd.log 2>&1 &)` first.
- [P1 env] There is no `postgres:19` tag yet → use `postgres:19beta4` as base.
- [P1-01 env] `docker build` can't clone GitHub (TLS-intercepting proxy) → build with `docker build --secret id=cacert,src=/root/.ccr/ca-bundle.crt -t manythreads/postgres:19 deploy/postgres`; compose reuses the existing image.
- [P1-01] pgvector v0.8.1 does not compile on PG19 (LWLock/slock_t headers moved) → use v0.8.7+ (Dockerfile default).
- [P1 review] One-off workflows with root SSH credentials left in the repo → delete them once used; prefer fixed-purpose workflows with validated inputs.
- [P1 parallel] A kernel agent's untracked files were deleted mid-run by a parallel agent's git operation → parallel agents must never run git stash/clean/checkout/reset; commit own paths early; use 'git pull --rebase --autostash' only.
- [P1 review] RLS helpers trusted session GUCs (app.actor_kind) that any SQL can set → system privilege must come from a real role (current_user), never a settable GUC.
- [P1 e2e] Running playwright from repo root loads two @playwright/test copies → run via 'pnpm e2e' (pnpm -C e2e exec playwright test).
- [P1-13 deploy] On CNPG the owner role is not a superuser, so kernel migrations failed (`permission denied to create extension vector`, then `permission denied to alter role`) → chart creates extensions via `postInitApplicationSQL` (postInitSQL runs in the `postgres` db, not `manythreads`) and makes `manythreads_owner` SUPERUSER like dev compose; the deploy action re-applies both idempotently for existing clusters. CNPG accepted the PG19 beta image, so `postgres.mode: statefulset` stays unused.
- [P1-13 deploy] Image prune sorted tags by name and deleted the freshly imported image (ImagePullBackOff) → prune only tags that are neither the new tag nor used by a pod.
- [P1-13 deploy] `pnpm install --frozen-lockfile` failed in the image because tools/bench was missing from pnpm-lock.yaml → docker contexts exclude `tools/`; whoever owns the lockfile should re-run `pnpm install`.
- [P1 CI] Parallel test DBs race on cluster-wide ALTER ROLE (XX000 tuple concurrently updated); advisory locks are per-database so they don't help → retry XX000 in migrate.ts.
- [P1 exit] git push of tags is 403 from the sandbox proxy → tag via the release.yml workflow (dispatch with MCP actions_run_trigger).
- [P2] The old product name was used everywhere → the name is manythreads; never write the old name.
- [P2-10] UI copy mentioned build phases ("created in phase 3") → never expose plan/phase wording in product UI; reviewers check copy.
- [P2 review] Definer/RLS checks only tested 'is admin' → also guard owner rows, same-workspace references (triggers), and terminal states (revoked, accepted) as system-only.
- [P2 review] Inside SECURITY DEFINER functions owned by manythreads_system, app.is_system()/is_workspace_admin() are TRUE (current_user) → in definer code check the caller with app.lookup_workspace_role()/lookup_team_role(), never the is_* helpers. Get-or-create on shared entities (roles) can attach things the caller doesn't own → check ownership.
- [P2 review] trustProxy:true trusts the client-written leftmost X-Forwarded-For → trust exactly one hop (the ingress). Admin-supplied URLs fetched by the server need an SSRF guard (public https only, connect-time DNS check).
- [env] Container restarts kill background agents and the docker daemon → on resume: start dockerd, pnpm db:up, re-create the 5-min stuck-check cron, relaunch interrupted agents pointing them at their uncommitted partial files.
- [P2 screenshots] remote_sh runs the script from stdin (`bash -s`), so a bare `kubectl exec -i` inside it would swallow the rest of the script → give such commands their own stdin (`printf ... | kubectl exec -i`, see remote_set_password); secrets travel on stdin only, never in argv or logs.
- [P2 CI] Visual (W) baselines were generated in the sandbox, where Google Fonts is unreachable from the browser (fallback DejaVu Sans), while CI loaded the real Inter Tight → 8 baseline failures (1px height diffs, 2–3% pixels) → never load fonts from a CDN: the web client self-hosts Inter Tight + JetBrains Mono (`clients/web/public/fonts`, `styles/fonts.css`), and plate renders answer the prototype's Google Fonts requests with the same local files (`useLocalFonts` in tools/plates). Regenerate baselines only after fonts are local, and check a baseline image shows the real font.

# Deploying Majlis (k3s at manythreads.kahf.to)

Single-node k3s (65.109.71.84, SSH port 44033). The sandbox cannot reach SSH; only GitHub Actions can,
using the repo secret `ROOT_PASSWORD` (via `sshpass -e`, never echoed).

## How a deploy works
- Pushing a tag `v*` runs `.github/workflows/deploy.yml`, which checks out **latest `main`** (not the tagged
  commit) and runs the composite action `.github/actions/deploy-majlis`.
- `ops-rollout` does the same for any branch/sha without tagging.
- The action: builds `majlis/server:<sha>` and `majlis/web:<sha>` (and `majlis/postgres:19` the first time,
  or with `rebuild-postgres`), ships them with `docker save | gzip | ssh 'gunzip | k3s ctr -n k8s.io images import -'`
  (no registry; `imagePullPolicy: IfNotPresent`; the 3 newest server/web tags are kept on the node),
  installs helm if missing and the CloudNativePG operator (`cnpg/cloudnative-pg` into `cnpg-system`),
  copies `deploy/helm/majlis` over, runs `helm upgrade --install majlis ... --wait --timeout 10m`
  and smoke-tests `https://manythreads.kahf.to/` (and `/healthz`, soft-fail).
- If `helm --wait` fails only because the server crash-loops (while `packages/server/src/main.ts` is a stub),
  the action warns and continues as long as web and Postgres are ready.
- TLS: the original whoami ingress had no `tls:` block; Traefik serves websecure with its default cert.
  The chart keeps that (`ingress.tls.enabled=false`), so the smoke test uses `curl -k`.
  Set `ingress.tls.*` in values when a real certificate exists. whoami is deleted on the first Majlis deploy.

## Chart (`deploy/helm/majlis`)
No CRDs of our own (D4). Postgres is a CNPG `Cluster` `majlis-pg` (service `majlis-pg-rw`) with
`postgres.mode: statefulset` as a fallback (same image). Passwords live in secrets `majlis-db-owner` and
`majlis-db-app` (generated once, kept across upgrades). LiteLLM/Hindsight/Hermes are disabled placeholders.
nginx in the web image serves the SPA and proxies `/api`, `/healthz`, `/readyz`, `/ws` to `majlis-server`.

## Ops workflows (Actions tab, workflow_dispatch; inputs strictly validated, no free-form commands)
| Workflow | Inputs | Does |
|---|---|---|
| ops-status | none | pods, last 30 events, helm history, ingress, disk |
| ops-rollout | `ref` | deploy that branch/sha |
| ops-restart | `deployment` all/majlis-server/majlis-web | rollout restart + status |
| ops-rollback | `revision` (digits, optional) | `helm rollback majlis [rev]` |
| ops-logs | `component`, `lines` (1-2000) | logs (+previous) and describe of non-ready pods |

## Rollback
Run `ops-rollback` (empty revision = previous). Old images stay on the node (3 newest tags kept).

## Temporary test triggers
`ops-rollout.yml` and `ops-status.yml` carry a `push:` trigger on branch `claude/inspiring-turing-dzp82p`
(paths `deploy/.rollout-trigger`, `deploy/.status-trigger`). They were used to test before the files existed
on main; they have been removed again once testing finished (workflow_dispatch works once the files are on main).

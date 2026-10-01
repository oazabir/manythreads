# Deploying manythreads (k3s at manythreads.kahf.to)

Single-node k3s (65.109.71.84, SSH port 44033). The sandbox cannot reach SSH; only GitHub Actions can,
using the repo secret `ROOT_PASSWORD` (via `sshpass -e`, never echoed).

## How a deploy works
- Pushing a tag `v*` runs `.github/workflows/deploy.yml`, which checks out **latest `main`** (not the tagged
  commit) and runs the composite action `.github/actions/deploy-manythreads`.
- `ops-rollout` does the same for any branch/sha without tagging.
- The action: builds `manythreads/server:<sha>` and `manythreads/web:<sha>` (and `manythreads/postgres:19` the first time,
  or with `rebuild-postgres`), ships them with `docker save | gzip | ssh 'gunzip | k3s ctr -n k8s.io images import -'`
  (no registry; `imagePullPolicy: IfNotPresent`; old server/web tags are pruned except the new one and those in use by pods),
  installs helm if missing and the CloudNativePG operator (`cnpg/cloudnative-pg` into `cnpg-system`),
  copies `deploy/helm/manythreads` over, runs `helm upgrade --install manythreads ... --wait --timeout 10m`
  and smoke-tests `https://manythreads.kahf.to/` (and `/healthz`, soft-fail).
- If `helm --wait` fails only because the server crash-loops (while `packages/server/src/main.ts` is a stub),
  the action warns and continues as long as web and Postgres are ready.
- TLS: the original whoami ingress had no `tls:` block; Traefik serves websecure with its default cert.
  The chart keeps that (`ingress.tls.enabled=false`), so the smoke test uses `curl -k`.
  Set `ingress.tls.*` in values when a real certificate exists. whoami is deleted on the first manythreads deploy.

## Chart (`deploy/helm/manythreads`)
No CRDs of our own (D4). Postgres is a CNPG `Cluster` `manythreads-pg` (service `manythreads-pg-rw`) with
`postgres.mode: statefulset` as a fallback (same image). Passwords live in secrets `manythreads-db-owner` and
`manythreads-db-app` (generated once, kept across upgrades). LiteLLM/Hindsight/Hermes are disabled placeholders.
nginx in the web image serves the SPA and proxies `/api`, `/healthz`, `/readyz`, `/ws` to `manythreads-server`.

## Ops workflows (Actions tab, workflow_dispatch; inputs strictly validated, no free-form commands)
| Workflow | Inputs | Does |
|---|---|---|
| ops-status | none | pods, last 30 events, helm history, ingress, disk |
| ops-rollout | `ref` | deploy that branch/sha |
| ops-restart | `deployment` all/manythreads-server/manythreads-web | rollout restart + status |
| ops-rollback | `revision` (digits, optional) | `helm rollback manythreads [rev]` |
| ops-logs | `component`, `lines` (1-2000) | logs (+previous) and describe of non-ready pods |

## Rollback
Run `ops-rollback` (empty revision = previous). Images in use by running pods stay on the node, so the previous revision normally still has its images.

## Temporary test triggers
During development `ops-rollout`, `ops-status` and `ops-logs` had a temporary `push:` trigger on branch
`claude/inspiring-turing-dzp82p` (paths `deploy/.rollout-trigger`, `.status-trigger`, `.logs-trigger`) because
workflow_dispatch only works once a workflow file is on main. The triggers and files are removed; after merging to
main use the Actions tab (Run workflow).

## Notes
- The kernel migrations need `manythreads_owner` to be SUPERUSER (create pgvector, create/alter roles); the chart sets this
  via CNPG `postInitApplicationSQL` and the deploy action re-applies it idempotently.
- Plain `http://` on the domain returns 404 from the front proxy; use https.

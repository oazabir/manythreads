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

## Server environment (set by the chart)
| Variable | Value / source |
|---|---|
| `MANYTHREADS_KMS_KEY` | Secret `manythreads-server-secrets` key `kms-key`: base64 of 32 random bytes, generated once (`lookup`, so upgrades never rotate it) and kept on `helm uninstall` (`helm.sh/resource-policy: keep`). Envelope encryption of provider client secrets; lose it and they must be re-entered. Required in production. |
| `MANYTHREADS_PUBLIC_URL` | `publicUrl`, default `https://<domain>` (`https://manythreads.kahf.to`). Mail links, OIDC redirect URIs; Secure cookies follow it. |
| `MANYTHREADS_TRUST_PROXY` | `server.trustProxy`, **2**: Traefik and the web pod's nginx each append to `X-Forwarded-For`, so the client is two hops out (1 would make every visitor look like Traefik: one shared sign-in lockout). Set it to the number of proxies in front of the server pod. |
| `MANYTHREADS_SMTP_URL` | `mail.smtpUrl`, or `smtp://manythreads-mailpit:1025` while `mailpit.enabled` (default). |
| `MANYTHREADS_MAIL_FROM` | `mail.from`. |
| `MANYTHREADS_TEST_AUTH_TOKEN` | Secret key `test-auth-token` (40 random alphanumerics), injected **only when `testAuth.enabled`**. |

**Mailpit** (`mailpit.enabled`, default on for the test environment) is a Deployment + ClusterIP Service `manythreads-mailpit`
(SMTP 1025, UI 8025). The ingress never routes to it; read mail with
`kubectl -n manythreads port-forward svc/manythreads-mailpit 8025`. Set `mailpit.enabled=false` and `mail.smtpUrl` for a real relay.

**Test sign-in on the live site (`testAuth.enabled`, default false).** `POST /api/test/session` with header `x-test-auth` lets the
screenshots workflow sign in as a persona. The server refuses to start in production with the token set, so enabling it also
passes `MANYTHREADS_ALLOW_TEST_AUTH_IN_PRODUCTION=1`, which `resolveTestAuthToken` (`packages/server/src/start.ts`) must honour
(with a loud warning at start). Until the server does, keep the flag off; the Secret is generated either way. Never enable it on a real deployment.

**Demo seed.** A post-install/post-upgrade Job (`seed.demo`, default true) runs `pnpm seed --demo` from the server image once the
server is ready: workspace Kahf Software, seven personas, three teams with their template definitions. It is idempotent (a second run
changes nothing and never replaces a password) and every persona gets a random password that is stored only as an argon2id hash and
printed nowhere, so the public site has no known credentials. The first-admin bootstrap link is not offered once the workspace exists.
Run it by hand against any database: `DATABASE_URL=postgres://... pnpm seed [--demo] [--migrate] [--wait <secs>]`.

## Screenshots of the live site
`.github/workflows/screenshots.yml` runs when `release` completes successfully for a `Phase N ·` merge (and by hand: Actions, screenshots,
Run workflow, optional phase). It reads the test-auth token from the cluster over SSH (`kubectl get secret manythreads-server-secrets`,
masked, never echoed), signs in as Omar, Nadia and Lena through `/api/test/session`, runs `e2e/screens/live.shots.ts`
(`pnpm -C e2e exec playwright test -c screens/live.config.ts`; sign-in, teams, roster, members, account, settings sign-in at 1440x900,
sign-in and members at 390x844), uploads them as the artifact `screenshots-phase-N` and commits them to the `screenshots` branch under
`phase-N/{desktop,mobile}/` (created on first use; the workflow writes no other ref). It needs `testAuth.enabled` on the site.

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

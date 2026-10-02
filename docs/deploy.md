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
| `MANYTHREADS_STORAGE_DIR` | `server.blobs.persistence.mountPath`, `/data/blobs`: the PVC `manythreads-blobs` (below). |
| `MANYTHREADS_KMS_PREVIOUS_KEYS` | Secret key `kms-previous-keys` from `kms.previousKeys` (empty by default; rotation below). |
| `MANYTHREADS_TEST_AUTH_TOKEN` | Secret key `test-auth-token` (40 random alphanumerics), injected **only when `testAuth.enabled`** (test environments; not used by the screenshots workflow). |

**Mailpit** (`mailpit.enabled`, default on for the test environment) is a Deployment + ClusterIP Service `manythreads-mailpit`
(SMTP 1025, UI 8025). The ingress never routes to it; read mail with
`kubectl -n manythreads port-forward svc/manythreads-mailpit 8025`. Set `mailpit.enabled=false` and `mail.smtpUrl` for a real relay.

**No test sign-in on the live site (`testAuth.enabled`, default false and kept false).** `POST /api/test/session` is for e2e servers only;
the server refuses to start in production with the token set. The screenshots workflow signs in with real passwords it sets through the
admin CLI (below). The `test-auth-token` Secret key is generated either way and unused while the flag is off.

**Admin CLI.** `kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password <email>`
reads the new password from stdin (never the command line), refuses fewer than 12 characters, stores an argon2id hash, signs the person
out everywhere and records the audit event `identity.password.admin_set`. It is also the way to give a seeded persona a known password on
a demo site, or to recover an admin who lost theirs. Pipe the password in: `printf '%s\n' "$PW" | kubectl exec -i ...`.
`admin kms-rewrap` (no arguments) is the last step of a master-key rotation: put the new `MANYTHREADS_KMS_KEY` in place, keep the old one in `MANYTHREADS_KMS_PREVIOUS_KEYS` (comma-separated
base64), restart, then run it. It only enqueues the `kms.rewrap` job (one at a time) that the server's job worker runs; when the job is `done` in `app.jobs`, drop the old key from the list.
The chart templates the list from `kms.previousKeys` (empty by default) into the Secret `manythreads-server-secrets` (key `kms-previous-keys`) and the server reads it from there. Rotation:
write the new base64 key into the Secret's `kms-key` (`kubectl -n manythreads edit secret manythreads-server-secrets`, value base64 of the base64 text), run
`helm upgrade ... --set kms.previousKeys=<old key>[,<older key>]`, restart the server, run `admin kms-rewrap`; once the job is done run `helm upgrade ... --set kms.previousKeys=-` (`-` clears it).
A stored list is kept when a later deploy does not pass the value, so the deploy action cannot drop it by accident.

**Attachment storage (`server.blobs.persistence`).** `storage-local` writes blobs to `MANYTHREADS_STORAGE_DIR`, which the chart sets to `/data/blobs`, the mount point of the PVC
`manythreads-blobs` (storage class `local-path`, `ReadWriteOnce`, **5Gi** by default: `server.blobs.persistence.{size,storageClass,mountPath}`). Uploads therefore survive restarts, rollouts and
`helm uninstall` (the claim carries `helm.sh/resource-policy: keep`; set `keep: false` only for a throwaway environment). Because the volume is `ReadWriteOnce` the server is **one replica**
and its Deployment uses the `Recreate` strategy: on a deploy the old pod stops before the new one starts, so the site is unavailable for a few seconds. More than one replica needs a
`ReadWriteMany` class or an object-storage provider instead. Growing the volume: raise the claim's `spec.resources.requests.storage` by hand (`local-path` does not enforce the size; the node disk is the limit).
With `persistence.enabled=false` the server gets an `emptyDir` (blobs are lost on restart).

**Demo seed.** A post-install/post-upgrade Job (`seed.demo`, default true) runs `pnpm seed --demo` from the server image once the
server is ready: workspace Kahf Software, seven personas, three teams with their template definitions, and their conversations (seed v3:
the template channels, about 40 messages in each, the "Deploy plan" thread with its attachment `deploy-plan-v2.14.pdf`, a private channel, a DM, a 5,000-message `#load-test`, Lena's
read grant on `#releases`, reactions and mentions). The attachment's bytes must land where the server reads them, so the Job **mounts the same PVC** `manythreads-blobs` at
`/data/blobs` (same `MANYTHREADS_STORAGE_DIR`) and carries a required pod affinity to the server pod (`kubernetes.io/hostname`): a `ReadWriteOnce` local-path volume can be mounted by several pods
of one node, so the Job is scheduled next to the server. No `--no-attachment` any more; this was chosen over seeding from the server process because the Job stays the only
thing that writes seed data and the server needs no demo code or flag. The seed writes the blob only when the file is missing, so a re-run also restores bytes after the volume was recreated. With
`server.blobs.persistence.enabled=false` the Job falls back to `--no-attachment`. It is idempotent (a second run
changes nothing and never replaces a password) and every persona gets a random password that is stored only as an argon2id hash and
printed nowhere, so the public site has no known credentials. The first-admin bootstrap link is not offered once the workspace exists.
Run it by hand against any database: `DATABASE_URL=postgres://... pnpm seed [--demo] [--no-content] [--no-attachment] [--migrate] [--wait <secs>]`.

## Screenshots of the live site
`.github/workflows/screenshots.yml` runs when `release` completes successfully for a `Phase N ·` merge (and by hand: Actions, screenshots,
Run workflow, optional phase). It generates a random one-off password (`openssl rand -hex 24`, masked with `::add-mask::` before first
use), sets it for Omar, Nadia, Rafi and Lena through `remote_set_password` (`.github/actions/lib/remote.sh`: the password goes over the SSH
stream into `kubectl exec -i ... admin set-password <email>` on stdin, never in an argument or a log), then runs `e2e/screens/live.shots.ts`
(`pnpm -C e2e exec playwright test -c screens/live.config.ts`), which signs in through the real sign-in form. At 1440x900: sign-in, teams, roster, members,
account, settings sign-in, teams as a guest (phase 2), and for phase 3 `channel-dev-thread` (Nadia in #dev with the "Deploy plan" thread in the right panel), `threads-inbox` (Rafi, Unread tab with
his unread reply), `search-rolback` (Nadia searches the typo "rolback"), `dm` (Rafi and Nadia), `guest-releases` (Lena in #releases). At 390x844: sign-in, members, `guest-releases`, `channel-dev` (Nadia, drawer closed)
and `channel-dev-drawer` (drawer open). Selectors are roles, labels, `data-landmark` and `data-testid`. The folder is `phase-N/{desktop,mobile}/`, N from the `Phase N ·` merge title (or the latest `phase-*` tag when run by hand).
Locally: start a seeded stack (`MANYTHREADS_STACK_SEED=content pnpm -C e2e exec tsx fixtures/stack-server.ts`, personas have `correct-horse-battery`) and point `MANYTHREADS_LIVE_URL` at its origin; a fresh stack per run keeps Rafi's thread unread. It uploads the pictures as the artifact `screenshots-phase-N` and commits
them to the `screenshots` branch under `phase-N/{desktop,mobile}/` (created on first use; the workflow writes no other ref). A last step
always rotates the three passwords to fresh random values nobody sees, so the one-off password is dead when the job ends. No test-auth
token is read and `testAuth.enabled` is not needed.

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

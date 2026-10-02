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
| `MANYTHREADS_STORAGE` | `server.storage.type`: `local` (default, `storage-local`) or `s3` (`storage-s3`); anything else stops the render (as it stops the server). See "Attachment storage" below. |
| `MANYTHREADS_S3_BUCKET`, `_REGION`, `_PREFIX`, `_FORCE_PATH_STYLE`, `_ENDPOINT` | `server.storage.s3.*`, only when `type: s3` (the endpoint only when set). |
| `MANYTHREADS_S3_ACCESS_KEY`, `MANYTHREADS_S3_SECRET_KEY` | A Secret, never text in the Deployment: `server.storage.s3.existingSecret` (keys `accessKeyKey` / `secretKeyKey`, default `access-key` / `secret-key`), else the chart's own Secret `manythreads-s3` made from `accessKey` / `secretKey` values (pass them with `--set-file`; kept on uninstall), else nothing and the pod's AWS credential chain applies. Both or neither. |
| `MANYTHREADS_BLOB_GC`, `_BLOB_GC_GRACE_HOURS`, `MANYTHREADS_FILES_ORPHAN_DAYS`, `_BLOB_GC_ALLOW_EMPTY` | `server.blobGc.{mode,graceHours,orphanDays,allowEmpty,adoptMarker}`: the daily `files.blob-gc` job (`dry-run` is the shipped default; `on` deletes, `off`; [plugins/files.md](./plugins/files.md)). Set `on` only once the bucket/prefix belongs to this database alone (the GC also checks an instance marker kept in the store). `allowEmpty` adds `MANYTHREADS_BLOB_GC_ALLOW_EMPTY=1` and is for a deployment that really deleted its last file; `adoptMarker` adds `MANYTHREADS_BLOB_GC_ADOPT_MARKER=1` for a database restored from a backup. |
| `MANYTHREADS_STORAGE_DIR` | `server.blobs.persistence.mountPath`, `/data/blobs`: the PVC `manythreads-blobs` (below), used by `storage-local`. |
| `MANYTHREADS_REPO_DIR` | `server.repos.persistence.mountPath`, `/data/repos`: the PVC `manythreads-repos` (below). The server image includes `git`. |
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

**Object storage instead of the volume (`server.storage.type: s3`).** `helm upgrade ... --set server.storage.type=s3 --set server.storage.s3.bucket=<bucket> --set server.storage.s3.endpoint=<url>
--set server.storage.s3.existingSecret=<secret>` (MinIO and most self-hosted stores also need `forcePathStyle=true`). The bucket must exist and be private; `blobs.persistence.enabled` can be set to false. The
server loads `storage-s3` instead of `storage-local` (only one `storage` provider loads), and the seed Job gets the same variables, so the demo attachments go to the bucket. Switching does not move
blobs already stored: copy `<key[0..2]>/<key>` on the volume to `<prefix><key>` in the bucket first ([plugins/storage-s3.md](./plugins/storage-s3.md)). The Deployment keeps the `Recreate` strategy while the
repository volume is `ReadWriteOnce`, so it stays one replica either way.

**Team repositories (`server.repos.persistence`).** repo-git keeps one bare git repository per team at `MANYTHREADS_REPO_DIR/<team id>.git`, the mount point (`/data/repos`) of the PVC
`manythreads-repos`: same class, access mode and `keep` rule as the blob volume, **2Gi** by default. It holds every page, `TEAM.md` and bot definition with its history, so back it up with the database
([plugins/repo-git.md](./plugins/repo-git.md)). The repository of every existing team is created by a job the repo-git migration enqueues, and of any later team when it is created.

**Demo seed.** A post-install/post-upgrade Job (`seed.demo`, default true) runs `pnpm seed --demo` from the server image once the
server is ready: workspace Kahf Software, seven personas, three teams with their template definitions, their conversations (seed v3: the template channels, about 40 messages in each, the "Deploy plan"
thread with its attachment `deploy-plan-v2.14.pdf`, a private channel, a DM, a 5,000-message `#load-test`, Lena's read grant on `#releases`, reactions and mentions) and **seed v4**: the content of each team's
repository (`pages/runbook.md` with two commits by two people, `pages/reports/signups.csv`, a digest, a changelog, a Mermaid diagram, the embedded app `apps/release-checklist/`, `memory/facts/` and
`memory/journal/`, a bot placeholder under `bots/`, `TEAM.md` from the template), committed through the repo writer as the people who would have written them, and a PNG, an MP4 and an Office file next to the PDF
in `#dev` ([plugins/repo-git.md](./plugins/repo-git.md), "Seed v4"). The Job writes where the server reads:

- **Repositories:** it mounts the same PVC `manythreads-repos` at `/data/repos` with the same `MANYTHREADS_REPO_DIR`, and the server image it runs carries `git` (the repo writer drives the `git` CLI). Without
  the repository volume (`server.repos.persistence.enabled=false`) it passes `--no-repo`: a repository made in the Job's own disk would be a different one from the server's.
- **Attachments:** they go **through the storage provider** (`MANYTHREADS_STORAGE`, as the server reads it), not into a directory. With `local` the Job mounts the same PVC `manythreads-blobs` at
  `/data/blobs` (same `MANYTHREADS_STORAGE_DIR`); with `s3` it gets the same `MANYTHREADS_S3_*` and Secret as the server and needs no volume. With `local` and no blob volume it passes `--no-attachment`.
- A required pod affinity to the server pod (`kubernetes.io/hostname`) puts it on the node of the server, since a `ReadWriteOnce` local-path volume is mounted by several pods of one node only.

This was chosen over seeding from the server process because the Job stays the only thing that writes seed data and the server needs no demo code or flag. A re-run is idempotent: a repository step whose commit message
is already in the team's history is skipped (a person's later edit is never undone), and an attachment whose bytes are gone (a recreated volume or bucket) gets them put again under the same row. Every persona gets
a random password that is stored only as an argon2id hash and printed nowhere, so the public site has no known credentials. The first-admin bootstrap link is not offered once the workspace exists.
Run it by hand against any database: `DATABASE_URL=postgres://... pnpm seed [--demo] [--no-content] [--no-repo] [--no-attachment] [--migrate] [--wait <secs>]`.

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

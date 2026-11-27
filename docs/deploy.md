# Deploying manythreads (k3s at manythreads.kahf.to)

Installing it for your own team on your own machine: [deploy/self-host.md](deploy/self-host.md). This page describes the project's own pipeline and host.

Single-node k3s (65.109.71.84, SSH port 44033), which is also the **devbox** — the box the
Windows dev loop and the test suites run on. The sandbox cannot reach SSH; only GitHub
Actions can, using the repo secret `ROOT_PASSWORD` (via `sshpass -e`, never echoed).

## The rule: the GitHub runner carries code, the devbox builds and tests
The Actions workflows are triggers and transport, not builders. A GitHub runner costs minutes
we do not have, and its image carries no browser, so the end-to-end tests could not run there
at all. Every workflow that touches the product therefore copies the tree to the devbox
(`/root/ci`, its own checkout) and runs a script there.

| Workflow | What it does on the devbox |
|---|---|
| `ci` (push to `main`, pull request, manual) | `tools/devbox/ci.sh`: install, lint, typecheck, build the images, deploy the candidate into the **CI namespace** `manythreads-ci`, check that release, run the unit, integration and browser suites, and — on a push to `main` — promote the same build to the live namespace `manythreads` and smoke-test the site. A pull request stops before the live deploy (`--no-deploy`). |
| `release` (a "Phase N · …" push to `main`, manual) | tags `phase-N` and `v0.N.0`; the deploy of that same push is the `ci` workflow's job, so the two never deploy at once. |
| `deploy` (`v*` tag, manual) | `tools/devbox/deploy.sh` on the devbox: build, import, helm upgrade, smoke test. |
| `screenshots` (manual) | the browser run happens on the devbox (it has Chromium); the runner takes the pictures back and commits them to the `screenshots` branch. |
| `ops-*` (manual) | kubectl/helm against the cluster from the runner; no build. |

## The CI namespace (`manythreads-ci`)
The candidate build is deployed into its own k3s namespace before anything reaches the live
one (`deploy/helm/manythreads/values-ci.yaml`): its own Postgres cluster, its own volumes, no
ingress (nothing on the internet can reach it) and the test sign-in route on. The pipeline
checks that release there — it answers, a persona signs in through the real form, the seeded
world is there — and only then promotes the same build to the live namespace (`manythreads`).
Every run replaces the namespace, so the check always sees a pristine world.

The **test suite** does not run against that release: the Playwright config starts the
instances it needs for itself (a server with a fresh database, an empty world, an idle world),
and several specs write to the instance they use. Pointing the whole suite at one deployed
release would break the specs that need an empty world and let one spec's leftovers reach the
next. The suite therefore runs on the devbox with its own instances, and the CI namespace
proves the thing the suite cannot: that the **built image** starts, migrates, seeds and
serves.

## How a deploy works
- A push to `main` runs `.github/workflows/ci.yml`: it copies the tree to the devbox and runs
  `tools/devbox/ci.sh`, which builds `manythreads/server:<sha>` and `manythreads/web:<sha>` on
  the devbox, imports them into its own k3s containerd (no registry; `imagePullPolicy:
  IfNotPresent`; old server/web tags are pruned except the new one and those in use by pods),
  installs helm if missing and the CloudNativePG operator (`cnpg/cloudnative-pg` into
  `cnpg-system`), runs `helm upgrade --install` into `manythreads-ci`, tests that release, and
  then promotes the same tag into `manythreads` and smoke-tests `https://manythreads.kahf.to/`.
- Pushing a tag `v*` runs `.github/workflows/deploy.yml`, which checks out **latest `main`**
  (not the tagged commit) and runs the composite action `.github/actions/deploy-manythreads`
  (the same devbox path, without the tests).
- `ops-rollout` does the same for any branch/sha without tagging.
- If `helm --wait` fails only because the server crash-loops, the deploy warns and continues
  as long as web and Postgres are ready.
- TLS: the original whoami ingress had no `tls:` block; Traefik serves websecure with its default cert.
  The chart keeps that (`ingress.tls.enabled=false`), so the smoke test uses `curl -k`.
  Set `ingress.tls.*` in values when a real certificate exists. whoami is deleted on the first manythreads deploy.

## Chart (`deploy/helm/manythreads`)
No CRDs of our own (D4). Postgres is a CNPG `Cluster` `manythreads-pg` (service `manythreads-pg-rw`) with
`postgres.mode: statefulset` as a fallback (same image). Passwords live in secrets `manythreads-db-owner` and
`manythreads-db-app` (generated once, kept across upgrades). LiteLLM and Hindsight are real workloads (below); Hermes is not a cluster workload (it runs on the host through a runner) and `hermes.enabled` only fails the render.
nginx in the web image serves the SPA and proxies `/api`, `/healthz`, `/readyz`, `/ws` to `manythreads-server`.

**Speech model files (PLAN P14-16).** The web image also carries the files the browser needs to turn a voice message into text on the person's own device
(Whisper tiny and base, a voice-activity model, and the ONNX Runtime files that run them; about 140 MB). They are listed with their SHA-256 and size in
`clients/web/models.lock.json`, downloaded while the image is built (the `models` stage of `deploy/docker/web.Dockerfile`, by `clients/web/scripts/fetch-models.mjs`,
which refuses any file whose hash differs) and served at `/models/<name>/<revision>/...`. So **the image build needs network access to huggingface.co and
cdn.jsdelivr.net** (a mirror: `MANYTHREADS_MODELS_HF_BASE`, `MANYTHREADS_MODELS_NPM_BASE`); the running site never contacts either. nginx sends these files with
`Cache-Control: public, immutable` for a year (the revision is in the address, so a new model is a new address), and the service worker keeps them for offline reuse.
The page policy allows `'wasm-unsafe-eval'` (compiling WebAssembly, not JavaScript `eval`) and the `Permissions-Policy` header allows the microphone and camera to this site only.
To use a different model: change `revision`, set `sha256` and `bytes` to `PENDING`, run `pnpm models:fetch --pin`, compare with the upstream page, commit. `pnpm models:fetch`
downloads the same files into `clients/web/public/models/` (not committed) for local development.

**Bot tools stream (PLAN P14-22).** A bot's Hermes keeps `GET /mcp` (or `GET /api/mcp/bots/<id>`) open with `Accept: text/event-stream` for up to 30 minutes; the server sends a
keepalive comment every 25 s and the header `X-Accel-Buffering: no`. The path to the server must not buffer it and must not time out before 30 minutes. In the chart: the web pod's nginx has
`proxy_buffering off` on `/mcp` and reads `web.mcpStreamTimeout` (default `1900s`, env `MANYTHREADS_MCP_STREAM_TIMEOUT`; keep it over `1800s`); `/api/` already waits 3600 s. Traefik, the k3s
ingress, buffers nothing and has no response timeout. Any other proxy you put in front (nginx ingress, a load balancer) needs `proxy-buffering off` and a read timeout over 30 minutes for those two paths.
In the dev compose stack the server is reached directly (no proxy in between), so nothing is needed; if you add a proxy there, give it the same two settings. Without them Hermes still works: it
reconnects when a stream drops, and the restart line on the bot's page remains the safety net.

## Server environment (set by the chart)
| Variable | Value / source |
|---|---|
| `MANYTHREADS_KMS_KEY` | Secret `manythreads-server-secrets` key `kms-key`: base64 of 32 random bytes, generated once (`lookup`, so upgrades never rotate it) and kept on `helm uninstall` (`helm.sh/resource-policy: keep`). Envelope encryption of provider client secrets; lose it and they must be re-entered. Required in production. |
| `MANYTHREADS_PUBLIC_URL` | `publicUrl`, default `https://<domain>` (`https://manythreads.kahf.to`). Mail links, OIDC redirect URIs; Secure cookies follow it. |
| `MANYTHREADS_TRUST_PROXY` | `server.trustProxy`, **2**: Traefik and the web pod's nginx each append to `X-Forwarded-For`, so the client is two hops out (1 would make every visitor look like Traefik: one shared sign-in lockout). Set it to the number of proxies in front of the server pod. With `tls.mode: cloudflare` the chart adds one (Cloudflare is one more hop) unless `server.env` sets it. Sign-in, reset, invitation and every other credential route is limited per client address or per person from this value: the numbers are in [deploy/rate-limits.md](./deploy/rate-limits.md), and `helm install` prints them (`templates/NOTES.txt`). Behind Cloudflare the chart also sets `MANYTHREADS_CLIENT_IP_HEADER=cf-connecting-ip`, because on k3s with the default `externalTrafficPolicy: Cluster` the forwarded chain names only `10.42.0.1` for every visitor (see the "Which address" part of that page). |
| `MANYTHREADS_SMTP_URL` | `mail.smtpUrl`, or `smtp://manythreads-mailpit:1025` while `mailpit.enabled` (default). |
| `MANYTHREADS_MAIL_FROM` | `mail.from`. |
| `MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES` | `botRunners.allowedNodes`, a list of node names (default empty: every machine). The machines an admin may choose for a team Hermes pod on the Runners page. The same release also makes a read-only ClusterRole (`get`, `list` on `nodes`) for the server when `hermesPods.enabled`; see "The one cluster-wide permission" in `docs/plugins/security.md`. On a one-machine cluster leave it empty. |
| `MANYTHREADS_STORAGE` | `server.storage.type`: `local` (default, `storage-local`) or `s3` (`storage-s3`); anything else stops the render (as it stops the server). See "Attachment storage" below. |
| `MANYTHREADS_S3_BUCKET`, `_REGION`, `_PREFIX`, `_FORCE_PATH_STYLE`, `_ENDPOINT` | `server.storage.s3.*`, only when `type: s3` (the endpoint only when set). |
| `MANYTHREADS_S3_ACCESS_KEY`, `MANYTHREADS_S3_SECRET_KEY` | A Secret, never text in the Deployment: `server.storage.s3.existingSecret` (keys `accessKeyKey` / `secretKeyKey`, default `access-key` / `secret-key`), else the chart's own Secret `manythreads-s3` made from `accessKey` / `secretKey` values (pass them with `--set-file`; kept on uninstall), else nothing and the pod's AWS credential chain applies. Both or neither. |
| `MANYTHREADS_BLOB_GC`, `_BLOB_GC_GRACE_HOURS`, `MANYTHREADS_FILES_ORPHAN_DAYS`, `_BLOB_GC_ALLOW_EMPTY` | `server.blobGc.{mode,graceHours,orphanDays,allowEmpty,adoptMarker}`: the daily `files.blob-gc` job (`dry-run` is the shipped default; `on` deletes, `off`; [plugins/files.md](./plugins/files.md)). Set `on` only once the bucket/prefix belongs to this database alone (the GC also checks an instance marker kept in the store). `allowEmpty` adds `MANYTHREADS_BLOB_GC_ALLOW_EMPTY=1` and is for a deployment that really deleted its last file; `adoptMarker` adds `MANYTHREADS_BLOB_GC_ADOPT_MARKER=1` for a database restored from a backup. |
| `MANYTHREADS_APP_POOL_MAX`, `MANYTHREADS_SYSTEM_POOL_MAX` | Size of the server's two Postgres pools (requests / system work and workers). Default **10** each; minimums **2** (app) and **3** (system) because the shared LISTEN connections hold 1 and 2 of them permanently — a smaller value is raised to the minimum with a warning in the log. Postgres allows 100 connections: keep (replicas × (app + system)) well under it. |
| `MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS` | How long the server start waits for Postgres to take its first connection (a restarting or evicted database, DNS not ready, "starting up"). Default **120**; `0` = one try. A wrong password or database name fails at once. One short line per failed attempt, never the connection string. |
| `MANYTHREADS_LINK_PREVIEW` | Not set by the chart. `on`/`off`: whether the server reads the pages of links in messages to make cards ([plugins/link-preview.md](./plugins/link-preview.md)). Unset means on, except under `NODE_ENV=test` (tests and the e2e stack set `off`). Set `off` on a server that must make no outbound request for a message. |
| `MANYTHREADS_STORAGE_DIR` | `server.blobs.persistence.mountPath`, `/data/blobs`: the PVC `manythreads-blobs` (below), used by `storage-local`. |
| `MANYTHREADS_REPO_DIR` | `server.repos.persistence.mountPath`, `/data/repos`: the PVC `manythreads-repos` (below). The server image includes `git`. |
| `MANYTHREADS_KMS_PREVIOUS_KEYS` | Secret key `kms-previous-keys` from `kms.previousKeys` (empty by default; rotation below). |
| `MANYTHREADS_LITELLM_URL`, `MANYTHREADS_LITELLM_MASTER_KEY` | With `litellm.enabled`: `http://manythreads-litellm:4000` and the Secret `manythreads-llm-secrets` key `litellm-master-key`. Skipped when `server.env` names its own `MANYTHREADS_LITELLM_URL` (the demo overlay points at fake-llm), so the overlay always wins. |
| `MANYTHREADS_HINDSIGHT_URL`, `MANYTHREADS_HINDSIGHT_API_KEY` | With `hindsight.enabled`: `http://manythreads-hindsight:8888` and the Secret key `hindsight-api-key`. Skipped the same way when `server.env` sets the URL. |
| `MANYTHREADS_TEST_AUTH_TOKEN` | Secret key `test-auth-token` (40 random alphanumerics), injected **only when `testAuth.enabled`** (test environments; not used by the screenshots workflow). |

**LLM gateway and memory engine (`litellm`, `hindsight`).** The LLM gateway is LiteLLM (a proxy that turns every model call into one OpenAI-style API); the
memory engine is Hindsight (stores and searches what a team's bots remember). Both are off in the base `values.yaml`; `values-live.yaml` turns them on and
`tools/devbox/deploy.sh` always applies it, so the live namespace runs them. `values-ci.yaml` keeps them off (the CI namespace is rebuilt every run and should stay small),
and `values-demo.yaml` switches them off again in favour of its stand-ins (`deploy.sh --demo`). Images come from the local docker/k3s store
(`ghcr.io/berriai/litellm:main-stable`, `ghcr.io/vectorize-io/hindsight:0.10.3`, `imagePullPolicy: IfNotPresent`; import with `docker save IMG | k3s ctr -n k8s.io images import -`).
* **Secret `manythreads-llm-secrets`** (generated once with `lookup`, kept by `helm.sh/resource-policy: keep`, never rotated by an upgrade): `litellm-master-key`, `litellm-salt-key`
  (encrypts provider keys stored in LiteLLM: never change it), `hindsight-db-password`, `hindsight-api-key`, `hindsight-llm-key` (a LiteLLM virtual key limited to the alias `fast`; Hindsight never holds the master key).
* **LiteLLM** (`manythreads-litellm:4000`, ClusterIP): `STORE_MODEL_IN_DB=True`; its database `litellm` lives in the same Postgres server. An init container creates it when missing
  (`CREATE DATABASE` as the owner role), which works on a cluster initialised long ago (CNPG bootstrap SQL runs only once). It connects as `manythreads_owner`, as in compose. The server's
  gateway-llm plugin pushes models into it; providers are set in the product (Workspace -> LLM API), never in the chart.
* **Hindsight** (`manythreads-hindsight:8888`, ClusterIP, no ingress route): its own login role `hindsight` and database `hindsight` (same state as `deploy/postgres/init/20-hindsight-db.sql`),
  created by an init container; a second init container waits for LiteLLM and creates the `fast`-only virtual key if absent (what `deploy/compose/memory-up.sh` does). `hindsight.skipLlmVerification`
  is `"true"` until a provider is configured behind the alias `fast`; then set it `"false"`.
* Run `kubectl -n manythreads exec deploy/manythreads-server -- node -e "fetch('http://manythreads-litellm:4000/health/liveliness').then(r=>r.text()).then(console.log)"` to check the gateway from inside the cluster.

**Mailpit** (`mailpit.enabled`, default on for the test environment) is a Deployment + ClusterIP Service `manythreads-mailpit`
(SMTP 1025, UI 8025). The ingress never routes to it; read mail with
`kubectl -n manythreads port-forward svc/manythreads-mailpit 8025`. Set `mailpit.enabled=false` and `mail.smtpUrl` for a real relay.

**No test sign-in on the live site (`testAuth.enabled`, default false and kept false).** `POST /api/test/session` is for e2e servers only;
the server refuses to start in production with the token set. The screenshots workflow signs in with real passwords it sets through the
admin CLI (below). The `test-auth-token` Secret key is generated either way and unused while the flag is off.

**Admin CLI.** `kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password <email>`
reads the new password from stdin (never the command line), refuses fewer than 8 characters, stores an argon2id hash, signs the person
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
in `#dev` ([plugins/repo-git.md](./plugins/repo-git.md), "Seed v4"), then **seed v6** (the Engineering team's work: a board with cards in all five columns, a Bot Board in `#dev`, a heartbeat and a routine that are switched off with two past runs, the routine's contract and output page in the repository, and a protected `production` environment; [testing.md](./testing.md), "Seed v6"). The Job writes where the server reads:

- **Repositories:** it mounts the same PVC `manythreads-repos` at `/data/repos` with the same `MANYTHREADS_REPO_DIR`, and the server image it runs carries `git` (the repo writer drives the `git` CLI). Without
  the repository volume (`server.repos.persistence.enabled=false`) it passes `--no-repo`: a repository made in the Job's own disk would be a different one from the server's.
- **Attachments:** they go **through the storage provider** (`MANYTHREADS_STORAGE`, as the server reads it), not into a directory. With `local` the Job mounts the same PVC `manythreads-blobs` at
  `/data/blobs` (same `MANYTHREADS_STORAGE_DIR`); with `s3` it gets the same `MANYTHREADS_S3_*` and Secret as the server and needs no volume. With `local` and no blob volume it passes `--no-attachment`.
- A required pod affinity to the server pod (`kubernetes.io/hostname`) puts it on the node of the server, since a `ReadWriteOnce` local-path volume is mounted by several pods of one node only.

This was chosen over seeding from the server process because the Job stays the only thing that writes seed data and the server needs no demo code or flag. A re-run is idempotent: a repository step whose commit message
is already in the team's history is skipped (a person's later edit is never undone), and an attachment whose bytes are gone (a recreated volume or bucket) gets them put again under the same row. Every persona gets
a random password that is stored only as an argon2id hash and printed nowhere, so the public site has no known credentials. The first-admin bootstrap link is not offered once the workspace exists.
Run it by hand against any database: `DATABASE_URL=postgres://... pnpm seed [--demo] [--no-content] [--no-repo] [--no-work] [--no-attachment] [--migrate] [--wait <secs>]`.

## HTTPS: Cloudflare or Let's Encrypt

The chart's `tls` block chooses how visitors get HTTPS. There are two supported modes besides `none` (no certificate from the chart; the older
`ingress.tls.secretName` still works for a Secret you made yourself). `tools/devbox/deploy.sh` takes the choice as flags and remembers it: a deploy
without `--tls` keeps whatever the release has now.

| Mode | What it is | Flags |
|---|---|---|
| `cloudflare` | Cloudflare's proxy sits in front and terminates TLS for visitors. `origin: strict` (recommended): Cloudflare checks the cluster's certificate ("Full (strict)"), a Cloudflare Origin CA certificate for `<domain>` (and `*.<domain>` with host routing) kept in the Secret `manythreads-origin-cert`. `origin: flexible` (not recommended): Cloudflare talks plain HTTP to the cluster, so the hop between Cloudflare and you is unencrypted; the router also answers on port 80. | `--tls cloudflare --cf-origin strict --origin-cert cert.pem --origin-key key.pem` |
| `letsencrypt` | The cluster is reached directly. cert-manager (a Kubernetes add-on that gets and renews certificates; the script installs it, pinned to chart v1.21.3) asks Let's Encrypt for a certificate for `<domain>` and, with `tls.wildcard`, `*.<domain>`. | `--tls letsencrypt --acme-email you@example.com [--acme-staging] [--dns-token-file token.txt] [--no-wildcard]` |

`tls.wildcard` (default on) also covers `*.<domain>`, but only matters with `hermesPods.apps.routing: host`, where the apps bots deploy live at `<app>--<team>.<domain>` (one label deep: see `docs/plugins/hermes-pods.md`).
With the default `routing: path` the apps live at `https://<domain>/apps/<team>/<app>/`, on the platform's own host, so the one certificate of the main domain covers them: no wildcard DNS record, no wildcard
certificate, no DNS token (the wildcard setting is then ignored). The deployed apps are fenced in by middlewares (the platform's cookies never reach them and their pages run in a sandbox); the consequences for app authors are in `docs/plugins/hermes-pods.md`.
`tools/devbox/deploy.sh --apps-routing path|host` chooses (and remembers) the mode. Switching to `host` needs a wildcard DNS record `*.<domain>` and a wildcard certificate, and, with Let's Encrypt, `--dns-token-file`.
In both modes a Traefik `TLSStore` named `default` makes the chart's certificate Traefik's default, so Ingresses in other namespaces, which cannot read the
Secret, are served with it. The render stops with a message on an unknown mode, or a wildcard `letsencrypt` (host routing) without `dns01`.

**Cloudflare, step by step.**
1. DNS: `<domain>` points at the cluster, with the orange cloud (proxied) on (and `*.<domain>` too, with `--apps-routing host`).
2. SSL/TLS, Overview: set the encryption mode to **Full (strict)**. (Flexible only if you pass `--cf-origin flexible`.)
3. SSL/TLS, Origin Server: create an Origin Certificate for `<domain>` (add `*.<domain>` for host routing) and save the certificate and key to files on the devbox, then deploy with `--origin-cert` and `--origin-key`. The script stores them in the Secret and never prints them.
4. The edge certificate: Cloudflare's free Universal SSL covers the zone and ONE level below it (`kahf.to`, `*.kahf.to`). `manythreads.kahf.to` is covered, and so are the apps with the default path routing.
   Only host routing needs `*.manythreads.kahf.to`, which is two levels down and needs Advanced Certificate Manager or Total TLS; without one, the apps' addresses show a certificate error at the edge.
5. Behind Cloudflare the real visitor is one proxy further out, so the chart sets `MANYTHREADS_TRUST_PROXY` to `server.trustProxy + 1` (unless `server.env` sets it), and in this mode
   the deploy script gives Traefik Cloudflare's published address ranges (`tls.cloudflare.trustedIPs`) as the proxies whose forwarded headers it believes. That lives in k3s's
   `HelmChartConfig` named `traefik` in `kube-system`, which is cluster-wide, so the script merges it into any existing one instead of the chart rendering it. Refresh the ranges from https://www.cloudflare.com/ips/ now and then.
   Switching to any other mode takes those ranges out of the `HelmChartConfig` again (and deletes it if nothing else was in it).
6. **Close the origin to everyone but Cloudflare.** Traefik believes the forwarded headers of the Cloudflare ranges, but anyone with a Cloudflare account can proxy
   their own site to your origin address, and so look like Cloudflare. Allow ports 80 and 443 only from Cloudflare's ranges (a firewall rule), or turn on Authenticated Origin Pulls
   (Cloudflare presents a client certificate that the origin checks).

**Let's Encrypt, step by step.**
1. Port 80 and 443 must reach Traefik from the internet. Without a wildcard, ownership is proved by a web request on port 80 (HTTP-01, answered through Traefik).
2. A wildcard certificate cannot use that; it proves ownership with a DNS record (DNS-01). Make a Cloudflare API token that can edit DNS for the zone and pass it with `--dns-token-file`
   (stored in the Secret `manythreads-cloudflare-dns`, key `api-token`). Only the Cloudflare DNS provider is supported.
3. Use `--acme-staging` first to test: its certificates are not trusted by browsers but it has no rate limits. Watch with `kubectl -n manythreads describe certificate manythreads-tls`.

The server learns the choice from `MANYTHREADS_TLS_MODE` (`none|cloudflare|letsencrypt`), `MANYTHREADS_TLS_ORIGIN` (`strict|flexible`, Cloudflare only),
`MANYTHREADS_TLS_WILDCARD` (`1|0`) and `MANYTHREADS_TLS_ACME_SERVER` (`production|staging`, Let's Encrypt only).

## Screenshots of the live site
`.github/workflows/screenshots.yml` runs **by hand only** (Actions, screenshots, Run workflow, optional phase) — the owner rule is that
Actions minutes are reserved for building and deploying, and phase-exit pictures are taken on the devbox over SSH. It generates a random one-off password (`openssl rand -hex 24`, masked with `::add-mask::` before first
use), sets it for Omar, Nadia, Rafi and Lena through `remote_set_password` (`.github/actions/lib/remote.sh`: the password goes over the SSH
stream into `kubectl exec -i ... admin set-password <email>` on stdin, never in an argument or a log), then runs `e2e/screens/live.shots.ts`
(`pnpm -C e2e exec playwright test -c screens/live.config.ts`) — **on the devbox**, because a GitHub runner has no Chromium; the runner
copies the tree there, fetches the pictures back and commits them to the `screenshots` branch. The shots sign in through the real sign-in form. At 1440x900: sign-in, teams, roster, members,
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

## Monitoring
A token-gated `/metrics` page for Prometheus, a built-in watcher that mails the workspace admins when disk, outbox, jobs, bot slots, approvals, budgets or database connections go wrong, and example alert rules: [deploy/monitoring.md](./deploy/monitoring.md).

## Audit console and export
Workspace admins read and export the audit log at **Settings → Workspace → Audit**. The export is a file signed with a per-workspace ed25519 key, and `MANYTHREADS_AUDIT_EXPORT_MAX_ROWS` can lower its row cap (default and maximum 20,000). To check a downloaded export offline, save the public key as `audit-key.pem` and the signature as `audit.ndjson.sig`, then run `base64 -d < audit.ndjson.sig > audit.ndjson.sig.bin` and `openssl pkeyutl -verify -pubin -inkey audit-key.pem -rawin -in audit.ndjson -sigfile audit.ndjson.sig.bin` (it prints "Signature Verified Successfully"). Rows, privacy rule and the Node way to verify: [plugins/audit.md](./plugins/audit.md). The signing key lives in the secrets store sealed by `MANYTHREADS_KMS_KEY`: keep a copy of the public key beside exports you archive, because a database restored without that key cannot sign new files with the same key.

## Backups and restore
Daily backups of the databases, the attachment store and the team repositories, a tested restore and a drill: [deploy/backup.md](./deploy/backup.md).

## Rollback
Run `ops-rollback` (empty revision = previous). Images in use by running pods stay on the node, so the previous revision normally still has its images.

## Voice rooms (LiveKit)
Voice rooms run on LiveKit (`media.enabled`, chart template `media.yaml`; plugin `media-livekit`, page `docs/plugins/media-livekit.md`; the rooms, transcripts and note-taker: `docs/plugins/meetings.md`). Off by default. The chart makes the key pair once
(Secret `manythreads-media-secrets`, kept across upgrades); the server gets it as `MANYTHREADS_LIVEKIT_*`. The media pod uses the node's network (`hostNetwork`), so its ports are the
node's own ports. Nothing here needs an outside account.

| What | Port | Who connects | Goes through the ingress? |
| --- | --- | --- | --- |
| Signalling (WebSocket) | TCP 7880 inside the cluster; browsers use `publicUrl` (`wss://manythreads.kahf.to/livekit`) | browsers | yes: `media.ingressPath: /livekit` adds an Ingress rule and a Traefik `Middleware` that takes the prefix off; Cloudflare carries the WebSocket |
| Audio over UDP | UDP `media.rtcPortStart`-`media.rtcPortEnd` (50000-50100) | browsers | no: straight to the node |
| Audio over TCP (when UDP is blocked) | TCP `media.rtcTcpPort` (7881) | browsers | no: straight to the node |
| TURN over UDP (`media.turn.enabled`) | UDP `media.turn.udpPort` (3478) | browsers | no: straight to the node |
| TURN relay (`media.turn.enabled`) | UDP `media.turn.relayPortStart`-`media.turn.relayPortEnd` (50101-50300) | browsers, through TURN | no: straight to the node |
| TURN over TLS (`media.turn.enabled`, `media.turn.tlsPort` above 0) | TCP 443 on `media.turn.domain`, forwarded to `media.turn.tlsPort` (5349) | browsers on networks that allow only HTTPS | no: a DNS-only name, never through Cloudflare's proxy |

Values (`values.yaml`, `media:`): `publicUrl` (empty with `ingressPath` set means `wss://<domain><ingressPath>`, so a domain change keeps calls working; a value given always wins), `nodeIp`,
`useExternalIp`, `advertiseInternalIp`, `maxParticipants` (25), `noteTakerMaxRooms` (10, the rooms one server pod's note-taker listens to at once), `ingressPath`, `turn.*`, `resources`.
The live release (`values-live.yaml`) sets `enabled: true`, `publicUrl: wss://manythreads.kahf.to/livekit`, `nodeIp: 10.0.2.15`, `useExternalIp: false`, `ingressPath: /livekit`. The chart's CI
release leaves it off; CI stacks use the stand-in (`MANYTHREADS_MEDIA_PROVIDER=fake`). The chart default is `enabled: false`; the installer (`deploy/install/install.sh`) turns calls and TURN
on for a new install, and `values-install.yaml` does not.

**TURN settings** (`media.turn.*`; the names are the chart's, and each maps to a LiveKit v1.13.11 key under `turn:`):
- `enabled` and `domain`: TURN needs a name (`turn.example.org`); the render fails without it.
- `udpPort` (3478, `udp_port`) and `tlsPort` (5349, `tls_port` with `external_tls: true`). **`tlsPort: 0` runs TURN over UDP only** and writes no TLS key at all: no certificate and no load balancer are needed. A single machine
  with no load balancer in front uses `0`. A render with both ports 0 fails.
- `relayPortStart`-`relayPortEnd` (50101-50300, `relay_range_start` and `relay_range_end`): the ports TURN opens on the machine for the far end of a relay. LiveKit's own default is 30000-40000,
  which overlaps the k3s service ports (30000-32767), so the chart picks a range next to the audio ports. Keep it clear of `rtcPortStart`-`rtcPortEnd`. Wider = more calls through TURN at once.
- `allowRestrictedPeerCidrs` (`allow_restricted_peer_cidrs`, empty): private networks the relay may reach. By default LiveKit refuses every private, loop-back and link-local address. A machine on a
  private network (everyone on one office network, or the machine behind a NAT, where the relay talks to the machine's own private address) lists it, for example `["192.168.0.0/16"]`.
- `denyPeerCidrs` (`deny_peer_cidrs`, empty): addresses the relay never reaches; it wins over the allow list. A CIDR in a wrong form fails the render (LiveKit would not start either).

**Restart on change.** The media pod carries the annotation `checksum/config`, a hash of its LiveKit settings, so `helm upgrade` restarts it when a port, TURN or address setting changes (LiveKit reads its file only at start). A restart ends the calls in progress. The hash does not cover the key pair (Secret `manythreads-media-secrets`): after rotating it, restart the media pod by hand (`kubectl rollout restart deployment/manythreads-media`).

**Ports to open** on the machine's firewall and the router (everything else stays closed):
- UDP 50000-50100 (audio and video, `rtcPortStart`-`rtcPortEnd`) and TCP 7881 (the same over TCP, `rtcTcpPort`).
- With TURN: UDP 3478 (`turn.udpPort`) and UDP 50101-50300 (`turn.relayPortStart`-`relayPortEnd`); with TURN over TLS also TCP 443 on the TURN name, forwarded to 5349.
- **TCP 7880 must not be reachable from outside.** It is the signalling, plain HTTP and WebSocket, and browsers reach it through the main address (`/livekit`), where the ingress adds HTTPS. The media pod uses the
  machine's network, so no Service port or NetworkPolicy is involved: the firewall is the only gate. `NOTES.txt` prints this list after an install or upgrade.

**Behind a NAT, with or without loop-back.** Set `useExternalIp: true` (LiveKit asks a STUN server for the public address) on a machine with a public address or a router that forwards the ports and
lets the machine reach its own public address from inside ("loop-back" or hairpin NAT works). If the machine cannot reach its own public address (the usual home or office router), the audio of people
on the same network never arrives: set `advertiseInternalIp: true` so LiveKit also tells browsers the machine's own private address, and the people inside connect to that one. (LiveKit v1.13.11 has
`advertise_internal_ip` as a yes or no; it cannot name an address, it uses the machine's own.) When the public address cannot be found by STUN, give it with `nodeIp` and `useExternalIp: false`; with
`advertiseInternalIp: true` the private address is still told as well. Callers on other networks need the ports forwarded to the machine, and TURN covers networks that block UDP.

**When TURN over TLS is needed.** TURN over UDP (3478) helps people whose network allows UDP out but blocks the audio ports. A network that allows only HTTPS (many offices, hotels, schools) needs TURN
over TLS: a DNS-only name for the machine (`turn.example.org`; Cloudflare's proxy cannot carry it), TCP 443 on that name forwarded to `tlsPort` by a load balancer that ends TLS (`external_tls`), and
`media.turn.tlsPort` above 0. A machine without such a load balancer leaves `tlsPort: 0`, and those networks cannot call.

**The devbox has no public address.** It is a VM behind NAT (10.0.2.15), and Cloudflare's proxy carries only HTTP(S) and WebSockets, never UDP. So with this setup a call works for
people on the machine itself (and the live checks run there), and **a call between people on different networks needs the owner to do three things at the network edge**. The app does not
change for any of them, only values:
1. Forward UDP 50000-50100 and TCP 7881 from the public address to the VM (the same numbers on both sides), and open them in the VM's firewall.
2. Make a DNS-only name (grey cloud in Cloudflare, not proxied) such as `media.kahf.to` for the public address, and set `media.publicUrl: wss://media.kahf.to` with a certificate for it (or keep the
   signalling on `manythreads.kahf.to/livekit` and only give the audio the public address: set `media.nodeIp` to the public address and `useExternalIp: false`).
3. For people behind a firewall that allows only HTTPS: a second DNS-only name for TURN (`turn.kahf.to`), `media.turn.enabled: true`, `media.turn.domain: turn.kahf.to`, and TCP 443 on that
   name forwarded to the VM's `media.turn.tlsPort` (5349); TURN over UDP uses `media.turn.udpPort` (3478).
Check: `kubectl get pods -l app.kubernetes.io/component=media`, then start a voice room in the app and read the call bar; a call that never connects while the pod is healthy is almost always
a closed UDP port or a wrong `nodeIp`.

Undo: `media.enabled: false` (the Secret stays; the next enable reuses it).

**Server and browser library must be of the same age.** `livekit-client` 2.22 (clients/web/package.json) waits for an answer that carries the offer id; LiveKit server 1.8.4 never sends it, so the first live call connected, published a track and 15 seconds later the browser gave up ("negotiation timed out"). The chart's `media.image` is therefore `livekit/livekit-server:v1.13.11`; move the two together.

**Room size.** The workspace setting `roomCap` (admin; default 25, 2 to 100) decides how many people the app lets into a room, and the app creates each LiveKit room with `max_participants` = that number plus 2 (the hidden note-taker and recorder count as participants on the media server), so the media server refuses the extra person even if a client skips the join route. The number is read when the room opens: raising `roomCap` does not widen a room that is already live. The chart's `media.maxParticipants` is only LiveKit's default for a room created without a number, and the app always gives one.

**The note-taker and recording listener (one server process).** Both are a worker thread inside the **server** pod (the library `@livekit/rtc-node`, a prebuilt linux-x64 glibc binary that works on the `node:22-slim`
image; it loads only when a note-taker is added). There is no separate deployment for them, so: they reach the media server at its in-cluster address, need no extra port beyond the table above, and are limited **per server
pod**: `MANYTHREADS_NOTETAKER_MAX_ROOMS` (chart `media.noteTakerMaxRooms`, default 10; the eleventh room gets 409 "The note-taker is busy, try again in a minute.") and `MANYTHREADS_RECORDING_MAX_ROOMS` (default 10). With two
server replicas a room could get two listeners, so keep one replica while the note-taker is on. The note-taker also needs the speech-to-text server below and a bound `transcribe` alias; without them "Add note-taker" is
disabled with the reason.

**Admin switches after the first deploy** (the app, not the chart; as a workspace admin through `PUT /api/workspace/meetings-settings`): `transcribeCap` (default `on_device`; `server` lets a weak device use the
speech-to-text server), `roomCap`, `notetakerAllowed` (default on) and `recordingCap` (default `off`; recording is opt-in per room and per person). A team narrows them in the front matter of its `TEAM.md` under
`meetings:` (`transcribe`, `noteTaker`, `autoMemory`, `keepAudioDays`).

**Bots in teams that already exist.** Template changes do not reach a team that was made before: the Scribe (`bots/scribe/BOT.md`) and the note-taker (`bots/note-taker/BOT.md`) must be committed into each existing team's
repository (as an admin, through the repository commit route with `baseBlobSha`), and the workspace Brain gains `meetings.search` by itself: its stored `BOT.md` is moved to the shipped file at the next start when the stored text is an earlier shipped one that no admin edited (`SUPERSEDED_BRAIN_SHAS` in `packages/plugins/bots/src/workspace-brain.ts`; add the old file's sha there whenever the shipped Brain changes). New teams get both from their template.

## Speech to text (voice messages, the server fallback and the note-taker)
The page for this part is `docs/plugins/asr.md`. The `asr` workload writes out speech for three users, all through the `transcribe` door of the LLM gateway (plugin `gateway-llm`, `src/transcribe.ts`):
the **voice messages** of channels (the first 20 seconds of each clip, decision D13, plan `docs/plans/voice-messages-server.md`), a device too weak to transcribe by itself (30-second pieces sent to
`POST /api/meetings/:meetingId/audio-chunks`), and the note-taker's listener. Meeting audio is never stored; a voice message's clip is the message's own attachment. The words come from **NVIDIA Parakeet TDT 0.6B v3**
(25 European languages, English among them; **not** Arabic, Bangla, Hindi or East Asian languages), int8, on the CPU, through onnx-asr (MIT) behind a small OpenAI-compatible server (`deploy/images/asr/server.py`).
Voice messages are transcribed on this server: the workspace admin switch (Settings, Workspace) turns it off, and the docs and the recording bar say so.

- **Image** (`deploy/images/asr`): `python:3.12-slim` pinned by digest, Debian's ffmpeg, the Python packages pinned with hashes (`requirements.txt`, made from `requirements.in`), and the int8 model files of
  `istupakov/parakeet-tdt-0.6b-v3-onnx` and the Silero VAD model `istupakov/silero-vad-onnx`, downloaded once while the image is built (needs the network for that one step; the pod never downloads anything, `HF_HUB_OFFLINE=1`). It runs as user 1000, not root.
  About 1.4 GB of files (`docs/spikes/parakeet-measured.md`). `tools/devbox/deploy.sh` builds it, tags it by the content of the folder and imports it into k3s when `asr.enabled` is true in `values-live.yaml`;
  it stops with a message when under 10 GB is free. Import one image at a time and remove the old one after the roll. Check a built image on the devbox (not in CI) with `bash deploy/images/asr/test.sh`.
- **The server**: `GET /health` (answers at once, also while a clip is being worked on), `GET /v1/models`, `POST /v1/audio/transcriptions` with `file`. Any `model` value is accepted (the alias may still name an old Whisper id)
  and `language` is ignored; the answer is `{text, language: null, duration}`. LiteLLM drops form fields the pod does not know, so the cut depends on the input: **a clip that is not WAV (a voice message) is cut at 20 seconds,
  WAV (meeting pieces, at most 30 seconds) at 30 seconds**. The upload is limited to 8 MiB (413 above); only WAV, webm, ogg, mp4, flac, mp3 and aac are opened (400 otherwise). One clip is worked on at a time and one more may
  wait; a third gets 429 and the caller tries again. Every clip is cut into speech segments by **Silero VAD** (MIT, downloaded at build time beside the Parakeet files) before Parakeet reads it, and the segment texts are
  joined: Parakeet alone returned an empty or cut text on whole 10 to 20 s inputs (`docs/spikes/parakeet-measured.md`). About 2.5 s for a 20-second clip on a quiet CPU, 5 to 7 s on the shared devbox CPU.
- **Chart** (`templates/asr.yaml`): `asr.enabled` (off by default), `asr.image`, `asr.threads` (CPU threads per clip, default 4), `asr.resources` (1 CPU and 1792 MiB requested, 2560 MiB limit, from the measurement).
  Deployment `manythreads-asr` and Service `manythreads-asr:8000`, no outside address needed, no key (reachable inside the cluster only).
- **Dev compose**: `docker compose -f deploy/compose/docker-compose.dev.yml --profile asr up -d --build asr` (port 8000 on loopback).
- **Admin step after the first deploy** (the app, not the chart): in the Models page bind the alias `transcribe` to a model with provider "openai-compatible", model `openai/nemo-parakeet-tdt-0.6b-v3` (the name the server lists at `/v1/models`;
  `openai/` makes the gateway speak the OpenAI protocol), `api_base` `http://manythreads-asr:8000/v1`, and mark the provider as running inside this deployment (the same flag as a local model). A binding that still names the old
  Whisper model works too (the server accepts any name), but rebind it so the Models page tells the truth. Until it is bound the door answers "Speech to text is not set up" and the app tells the person so. A voice message is
  refused a `transcribe` target that is not marked local. The alias shows in Spend as "Meeting transcription", costs nothing per call, and is under the workspace's budgets and guardrails like any other.
- **Air-gapped preset**: allowed, because the server is inside the deployment; a `transcribe` model outside it is refused like any other outside model.
- **Who may use it**: voice messages (any sender, while the workspace switch is on); a room whose transcription is `server`, and only while the workspace's and the team's caps both allow `server` (the lower wins), only the
  sender's own speech and only after they said yes (D7; meetings keep it). Tests and screenshots use the stand-in `MANYTHREADS_FAKE_ASR=1` (a scripted text for a voice message, text read from the audio itself for a meeting piece; the
  server refuses to start with it when `NODE_ENV=production`).
- **Check after deploy**: `kubectl rollout status deploy/manythreads-asr`, then send a voice message in a channel and read the transcript under it; Spend shows a `transcribe` line.
- **Undo**: `asr.enabled: false` (the alias then answers "not set up"; nothing else changes).
- **Credits**: the model is NVIDIA's Parakeet TDT 0.6B v3 (<https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>), licensed **CC-BY-4.0**; the ONNX int8 files are istupakov's conversion
  (<https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx>, same licence). The Silero VAD model (<https://github.com/snakers4/silero-vad>) is **MIT**. Debian's ffmpeg in the image is a **GPL** build, run only as a separate program. The full list is `deploy/images/asr/NOTICE`, which is also
  inside the image at `/app/NOTICE`.

## A second release on the same cluster
A fresh install (`values-install.yaml`: its own database through the database operator, LiteLLM, Hindsight, the managed Hermes pods, backups, no demo seed) can run
next to the live site on the same k3s cluster, in a namespace of its own. The live release is not touched by it, and the live chart's output does not change by one byte
(`deploy/helm/test/second-release.test.ts` holds both). Two things belong to a cluster, not to a namespace, so a second release must name them differently:

| What | First release | Second release |
|---|---|---|
| Namespaces of the teams' pods and apps | `hermesPods.namespace` (`manythreads-bots`), `hermesPods.apps.prefix` + team (`apps-<team>`) | set both: `test-bots`, `test-apps-` |
| Apps admission policy and its binding | `manythreads-apps-guard` | `manythreads-apps-guard-<clusterScopedSuffix>` |
| The label that policy selects its apps namespaces by | `manythreads.io/apps=true` | `manythreads.io/apps=<clusterScopedSuffix>` (so the first policy never judges the second release's apps, and the other way round) |
| The reader of the machine list | `<release namespace>-manythreads-nodes-reader` | the same rule, so already different |

`deploy/helm/manythreads/values-second-install.yaml` carries exactly these names, the sizes for a shared machine and the openings a walled namespace needs. It has no domain and no
Kubernetes API address: give them with `--set domain=...` and `--set hermesPods.apiServer.cidr=<node address>/32`. The chart never makes the release namespace itself (only the
pods and apps namespaces, which stay behind on `helm uninstall`), so a namespace someone else owns can be the home of the second release.

**A leased namespace** (a deploy target of the first release, like `test-manythreads`) comes walled in: pod security `baseline` (the install profile's pods pass it: no host path,
host network, host port, privileged container or added capability; voice rooms, which use the host network, stay off there), a quota (memory, volumes, pods), a default-deny network
policy and an admission rule that only lets an Ingress, certificate or volume claim of the namespace's own hosts through. The file sizes the pods to that quota, turns
`networkPolicies.leased.enabled` on (the server reaches the teams' pods and the Kubernetes API, and the teams' pods reach the server; `templates/netpol-leased.yaml`) and sets
`tls.defaultStore=false` (two Traefik stores named `default` fight over one certificate).

The release must be new in its namespace: a release named `manythreads` that is already there (an older test site) has objects of the same names, so remove it first with
`helm uninstall`, or helm will upgrade it instead of installing a fresh one. A second release in a namespace the chart owns itself works the same way with the
four names above changed; a second release makes no deploy targets (`hermesPods.deployTargets` fails the render when `clusterScopedSuffix` is set).

To take it away: `helm uninstall manythreads -n <namespace>`, then delete what is kept on purpose: the namespaces `test-bots` and `test-apps-*`, and (if it was installed
without the file) the volume claims. Do it by name; never by the label `manythreads.io/apps=true`, which is the first release's.

## Temporary test triggers
During development `ops-rollout`, `ops-status` and `ops-logs` had a temporary `push:` trigger on branch
`claude/inspiring-turing-dzp82p` (paths `deploy/.rollout-trigger`, `.status-trigger`, `.logs-trigger`) because
workflow_dispatch only works once a workflow file is on main. The triggers and files are removed; after merging to
main use the Actions tab (Run workflow).

## Notes
- The kernel migrations need `manythreads_owner` to be SUPERUSER (create pgvector, create/alter roles); the chart sets this
  via CNPG `postInitApplicationSQL` and the deploy action re-applies it idempotently.
- Plain `http://` on the domain returns 404 from the front proxy; use https.

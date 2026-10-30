# Install manythreads for your team

This page is for a system administrator who has never seen this repository. It takes one Linux machine to a running
manythreads with a first administrator who can sign in.

## What you get, and what is supported

There is **one supported install path**: the Helm chart in `deploy/helm/manythreads`, on a single-node
[k3s](https://k3s.io) cluster. k3s is a small Kubernetes. Helm is the tool that installs a chart (a bundle of Kubernetes
files) into it.

- `deploy/compose/docker-compose.dev.yml` is for developers and tests. A comment in it says a self-host compose file
  "comes in phase 10". There is no self-host Docker Compose file yet.
- `tools/devbox/deploy.sh` is the project's own release script. It is tied to the project's host name and registry. Do not
  run it. This page replaces it with plain `docker`, `helm` and `kubectl` commands.
- The chart runs **one** server pod. Run more only after reading [rate-limits.md](rate-limits.md) (limits are counted per pod).
- The project itself runs on one k3s node. The steps below were checked against the chart by rendering it
  (`helm template`). A fresh-machine run of every step has not been recorded. Report any step that fails.

Further reading: [docs/deploy.md](../deploy.md) describes the project's own pipeline and the chart in more depth.

## Prerequisites

| You need | Detail |
|---|---|
| One Linux machine | x86-64 with root access, with k3s, Docker, Helm and kubectl (steps below). x86-64 is the only CPU type the project has run. The project's own node has 15 GB of memory and 77 GB of disk. A smaller minimum has not been measured. The memory limits in `values-live.yaml` are 2 GiB for the server, 2 GiB for Postgres, 1.5 GiB for LiteLLM and 4 GiB for Hindsight (the memory engine). The chart gives Postgres a 10 Gi volume. |
| A host name | One DNS name, for example `manythreads.example.com`, pointing at the machine. |
| Ports | 80 and 443 reachable by your users. For Let's Encrypt, port 80 must be reachable from the internet. |
| HTTPS | Choose one: Let's Encrypt (needs port 80), Cloudflare in front (needs an Origin CA certificate), or plain HTTP for a trial. |
| Postgres | The chart installs it. It uses the CloudNativePG operator (CNPG), a Kubernetes add-on that runs Postgres. It needs the `pgvector` and `pg_trgm` extensions. See step 3. |
| File storage | Default is a volume on the node (`local-path`, 5 Gi for uploads, 2 Gi for repositories). Optional: any S3-compatible bucket. See [storage-s3.md](../plugins/storage-s3.md). |
| Mail | An SMTP relay. Password resets, invitations (a new person sets their password from a mailed link) and admin alert mails are mail. The bundled mail catcher (mailpit) is for tests only. |
| A model provider key | From OpenAI, Anthropic, Azure, Bedrock, Google, Ollama or any OpenAI-compatible endpoint. You enter it in the web app after install (step 8). |
| A bot runtime | Bots answer through a Hermes runtime. Without one, people and channels work but bots do not reply. See step 9. |

## Step 1. Install k3s, Docker, Helm and kubectl

Follow each project's own install guide. For k3s the usual command is:

```sh
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get nodes        # the node shows Ready
```

k3s ships Traefik (the ingress, which routes web traffic into the cluster) and the `local-path` storage class. The chart
uses both. If you disable either, the chart will not work as written.

One more k3s setting matters when you do not use Cloudflare. By default k3s hides each visitor's address behind the node's own, so every
visitor shares one sign-in lockout counter. The Traefik service must keep the visitor's address (`externalTrafficPolicy: Local`). The reason
is in [rate-limits.md](rate-limits.md). The project has not run this setting outside Cloudflare, so check it with two addresses before you rely on it.

## Step 2. Get the code and choose a tag

```sh
git clone <your copy of this repository> manythreads && cd manythreads
export TAG=$(git rev-parse --short HEAD)
```

## Step 3. Build the three images and load them into k3s

There is no image registry. You build on the machine and import into k3s's container store (containerd). The chart's
`imagePullPolicy` is `IfNotPresent`, so it uses the imported images.

```sh
docker build -f deploy/docker/server.Dockerfile -t manythreads/server:$TAG .
docker build -f deploy/docker/web.Dockerfile    -t manythreads/web:$TAG .
docker build -f deploy/postgres/cnpg.Dockerfile -t manythreads/postgres-cnpg:19beta4-202609281634-u999 deploy/postgres

for IMG in manythreads/server:$TAG manythreads/web:$TAG manythreads/postgres-cnpg:19beta4-202609281634-u999; do
  docker save "$IMG" | k3s ctr -n k8s.io images import -
done
```

The Postgres image is CloudNativePG's Postgres 19 beta build plus pgvector. `deploy/postgres/cnpg.Dockerfile` pulls the
base from `ghcr.io/cloudnative-pg` (pinned by digest) and clones pgvector v0.8.7 from GitHub, so the build needs internet access.
The chart's default `postgres.image` points at the project's private registry (`registry.local:5000`), which does not
exist on your machine. You **must** override it, as in step 5.

## Step 4. Install the two add-ons

The Postgres operator is required. cert-manager (which gets Let's Encrypt certificates) is needed only for
`tls.mode=letsencrypt`.

```sh
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace

# only for Let's Encrypt:
helm repo add jetstack https://charts.jetstack.io
helm upgrade --install cert-manager jetstack/cert-manager --version v1.21.3 \
  -n cert-manager --create-namespace --set crds.enabled=true
```

These are the commands the project's own script uses. The CNPG chart version is not pinned there either.

## Step 5. Install manythreads

Put your choices in a values file so that every later upgrade repeats them. Keep it out of git if it holds passwords.

```yaml
# my-values.yaml
imageTag: "<the TAG from step 2>"
domain: manythreads.example.com
seed:
  demo: false              # required: see "First administrator"
mailpit:
  enabled: false
mail:
  from: "manythreads <no-reply@example.com>"
  smtpUrl: "smtp://USER:PASSWORD@smtp.example.com:587"
postgres:
  image: manythreads/postgres-cnpg:19beta4-202609281634-u999
backup:
  enabled: true            # see "Backups"
```

Add the HTTPS choice:

- **Let's Encrypt.** Add `tls: { mode: letsencrypt, wildcard: false, letsencrypt: { email: you@example.com } }` (the email is optional; it names the Let's Encrypt account). Certificates
  come by an HTTP challenge on port 80. A wildcard certificate needs a Cloudflare API token, described in [docs/deploy.md](../deploy.md).
- **Cloudflare in front.** Set `tls.mode: cloudflare`. Before the install, make the namespace and the certificate secret:
  `kubectl create namespace manythreads` and `kubectl -n manythreads create secret tls manythreads-origin-cert --cert=cert.pem --key=key.pem`
  (a Cloudflare Origin CA certificate). Then read "HTTPS: Cloudflare or Let's Encrypt" in [docs/deploy.md](../deploy.md).
  That page's Traefik step (trusting Cloudflare's address ranges) is done by `tools/devbox/deploy.sh`, not by the chart. This page has no plain-Helm
  version of it. For a first install, prefer Let's Encrypt.
- **Plain HTTP, for a trial only.** Set `publicUrl: http://manythreads.example.com`. Without that line the server assumes
  `https://` and sets Secure cookies, and the browser then drops the sign-in cookie over HTTP. Use `http://` in the checks of step 6.

Then install:

```sh
helm upgrade --install manythreads ./deploy/helm/manythreads -n manythreads --create-namespace -f my-values.yaml
kubectl -n manythreads get pods -w
```

The first start takes a few minutes. The database pod comes first, then the server, which runs its migrations (see
"Upgrades"). Wait until `manythreads-server` and `manythreads-web` show `1/1 Running`.

The chart makes its secrets on first install and keeps them on upgrades: the encryption key
(`MANYTHREADS_KMS_KEY`), the metrics token, the push-notification key and the database passwords. Read the next warning.

> **Save the encryption key now.** The key encrypts stored provider keys and tokens. It is **not** in the database backups.
> Without it, a restored database cannot decrypt those secrets.
>
> ```sh
> kubectl -n manythreads get secret manythreads-server-secrets -o jsonpath='{.data.kms-key}' | base64 -d
> ```
>
> Store the output in your password manager. Never commit it. To rotate it later, see the paragraph "Admin CLI" (`admin kms-rewrap`) in [docs/deploy.md](../deploy.md).

## Step 6. Check that it is healthy

Replace the host name (use `http://` for a plain HTTP trial):

```sh
curl -s https://manythreads.example.com/healthz
curl -s https://manythreads.example.com/readyz
```

| Endpoint | Healthy answer | Unhealthy answer |
|---|---|---|
| `/healthz` (is the process alive and can it reach the database) | `{"status":"ok","migrations":N,"plugins":[...]}` | 503, "Database unreachable" |
| `/readyz` (can it take traffic) | `{"status":"ready","migrations":N}` | 503, "Migrations pending: a of b applied", or "Database unreachable" |

Kubernetes uses `/readyz` as the readiness probe and `/healthz` as the liveness probe. `/metrics` is not reachable from the
internet by design: see [monitoring.md](monitoring.md).

## Step 7. First administrator and first sign-in

While the database holds no workspace, every server start writes one log line with a single-use setup link:

```sh
kubectl -n manythreads logs deploy/manythreads-server | grep 'first-admin setup'
```

The line reads `first-admin setup: open <public URL>/bootstrap/<token> to create your workspace (works once)`. Open that link
in a browser. The page is titled "Set up your workspace". Fill in Workspace, Name, Email and Password (at least 8
characters) and press "Create workspace". You become the workspace owner and are signed in.

- The link works once. If you lose it before using it, restart the server (`kubectl -n manythreads rollout restart deploy/manythreads-server`). The server then writes a new link and discards the old one.
- The link is offered only when `seed.demo` is `false`. With the default (`true`) the chart seeds a demo workspace called
  "Kahf Software" with random passwords nobody knows, and no setup link appears. If that happened on a throwaway trial, start over:
  `helm uninstall manythreads -n manythreads`, then `kubectl delete namespace manythreads` (this also deletes the volumes and the encryption key),
  then repeat step 5 with `seed.demo: false`.
- If you forget the owner password, set a new one: `printf '%s\n' "$NEW_PASSWORD" | kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password you@example.com`. Run the command from a shell where `NEW_PASSWORD` holds the password.

## Step 8. First model provider and aliases

Sign in. The sidebar shows a "Finish setting up" card (for workspace admins). Its "Next:" link opens the setup wizard. The wizard has
nine steps, and each one is ticked from real facts, never from a click. Step 2 "Models" is where you add your first provider
(gear icon at the foot of the sidebar, Settings, Workspace, LLM). Add a provider with its API key. Then bind the aliases `smart` and `fast`
(the built-in Brain uses these two) and press "Test" on each. A failed test shows the cause in plain words.
Details: [onboarding.md](../plugins/onboarding.md).

Model calls go through LiteLLM, a gateway. Add `litellm: { enabled: true }` to your values file and run
`helm upgrade` again (step 5 command). Without it the server mints keys but pushes no model configuration, so no bot gets a model answer.
The chart pulls the LiteLLM image from `ghcr.io`.

Team memory (what Brain recalls) is a separate engine, Hindsight. Add `hindsight: { enabled: true }` too. It needs LiteLLM and calls the `fast` alias.
The chart default `hindsight.skipLlmVerification: "true"` lets the pod start before `fast` works. Set it to `"false"` once `fast` answers its test.
Without Hindsight the memory tools answer "not configured" and nothing else changes. If you turn it on, add `backup.databases: [manythreads, hindsight]` (see "Backups").

## Step 9. Bot runtime

A bot answers through a Hermes runtime. There are two ways. The plugin pages cover them:

- **Mode A, your own Hermes.** You run a Hermes gateway and connect it. See [runtime-hermes.md](../plugins/runtime-hermes.md).
- **Mode B, a managed pod per team.** Needs `litellm.enabled: true`. Build and import two more images, copied from `tools/devbox/deploy.sh`
  (not run from a clean machine). Then set `hermesPods.enabled: true` and run `helm upgrade`. (The chart looks up the Kubernetes API address itself. Only `helm template`
  needs `hermesPods.apiServer.cidr`.) See [hermes-pods.md](../plugins/hermes-pods.md).

  ```sh
  docker build -f deploy/docker/hermes.Dockerfile -t manythreads/hermes:stable .
  docker build -f deploy/images/hermes-pod/Dockerfile -t manythreads/hermes-pod:1 deploy/images/hermes-pod
  docker build -f deploy/images/workbench/Dockerfile -t manythreads/workbench:2 deploy/images/workbench
  for IMG in manythreads/hermes-pod:1 manythreads/workbench:2; do docker save "$IMG" | k3s ctr -n k8s.io images import -; done
  ```

  The chart's default image names are `manythreads/hermes-pod:1` and `manythreads/workbench:2`, so no image values are needed.
  The builds download from the internet. The Hermes installer is upstream's.
- **Claude Code or Codex CLI** can also run bots, through `tools/agent-bridge`. This page does not cover it.

## Step 10. Next: your team

Create a team from a template, invite people and give a bot a model. Follow [first-week.md](../guide/first-week.md).

## Operator settings

Set any of these through the chart with `server.env`, for example
`--set-string server.env.MANYTHREADS_KNOWLEDGE_MAX_BYTES=20971520`. Use `--set-string` for numbers. Defaults are read from the code.

**Set by the chart (do not set by hand):** `DATABASE_URL`, `MANYTHREADS_APP_DATABASE_URL`, `MANYTHREADS_SYSTEM_DATABASE_URL`,
`MANYTHREADS_APP_PASSWORD`, `MANYTHREADS_SYSTEM_PASSWORD`, `MANYTHREADS_KMS_KEY`, `MANYTHREADS_PUBLIC_URL`,
`MANYTHREADS_TLS_MODE`, `MANYTHREADS_TLS_WILDCARD`, `MANYTHREADS_STORAGE*`, `MANYTHREADS_S3_*`, `MANYTHREADS_SMTP_URL`, `MANYTHREADS_MAIL_FROM`.
Use the chart values `domain`, `publicUrl`, `mail.*`, `server.storage.*`.

| Variable | Meaning | Default |
|---|---|---|
| `PORT`, `HOST` | Server listen port and address. | 3000, 0.0.0.0 |
| `MANYTHREADS_KMS_KEY` | Master key, base64 of 32 bytes. Required in production. The chart makes it. | none (a development key is used outside production only) |
| `MANYTHREADS_KMS_PREVIOUS_KEYS` | Old master keys, kept while rotating. Chart value `kms.previousKeys`. | empty |
| `MANYTHREADS_JOB_WORKERS` | Background-job workers. `0` turns jobs off. | on (anything but `0`) |
| `MANYTHREADS_APP_POOL_MAX`, `MANYTHREADS_SYSTEM_POOL_MAX` | Database connections per role. Minimums 2 and 3. | 10, 10 |
| `MANYTHREADS_TRUST_PROXY` | How many proxy hops add to `X-Forwarded-For`: `0`, a number, or a list of CIDR ranges. Chart value `server.trustProxy`. | chart: 2 (3 behind Cloudflare) |
| `MANYTHREADS_CLIENT_IP_HEADER` | Header that holds the visitor address, for example `cf-connecting-ip`. The chart sets it for Cloudflare. | unset |
| `MANYTHREADS_COOKIE_SECURE` | Force Secure cookies on or off. | on unless the public URL starts with `http://` |
| `MANYTHREADS_SESSION_IDLE_MINUTES` | Sign-out after no activity. | 30 |
| `MANYTHREADS_SESSION_ABSOLUTE_DAYS` | Longest a session lives. | 30 |
| `MANYTHREADS_SESSION_ROTATE_HOURS` | How often the session token is replaced. | 4 |
| `MANYTHREADS_MAX_UPLOAD_BYTES` | Largest attachment. | 50 MB |
| `MANYTHREADS_MAX_CONCURRENT_UPLOADS` | Uploads at once. | 4 |
| `MANYTHREADS_UPLOAD_IDLE_MS`, `MANYTHREADS_UPLOAD_MAX_MS` | Stop an upload that stalls, or runs too long. | 20000, 600000 |
| `MANYTHREADS_KNOWLEDGE_MAX_BYTES` | Largest file a Knowledge base accepts. | 10 MB (10485760) |
| `MANYTHREADS_KNOWLEDGE_EXTRACT_MS` | Time limit for reading one file into text. | 20000 |
| `MANYTHREADS_KNOWLEDGE_EXTRACT_MB` | Memory growth allowed while reading one file; over it the read stops. | 500 |
| `MANYTHREADS_REPO_MAX_BYTES`, `MANYTHREADS_REPO_MAX_FILES` | Size and file-count quota of one team repository. | 512 MiB, 20000 |
| `MANYTHREADS_GIT_WORKERS`, `MANYTHREADS_GIT_MAX_QUEUE` | Concurrent git jobs, and how many may wait. | 8, 64 |
| `MANYTHREADS_BLOB_GC`, `MANYTHREADS_BLOB_GC_GRACE_HOURS`, `MANYTHREADS_FILES_ORPHAN_DAYS` | Deleting file bytes no row uses. Chart `server.blobGc.*`. Modes `on`, `dry-run`, `off`. | `dry-run`, 24, 30 |
| `MANYTHREADS_RETENTION`, `MANYTHREADS_RETENTION_BATCH` | Deleting old data by retention rules. Modes `on`, `dry-run`, `off`. | `dry-run`, 500 |
| `MANYTHREADS_RUN_CONCURRENCY` | Bot runs at once. | 6 |
| `MANYTHREADS_METRICS_TOKEN` | Bearer token for `/metrics`. Under 16 characters, `/metrics` answers 404. The chart makes it. | chart: 40 random characters |
| `MANYTHREADS_AUDIT_EXPORT_MAX_ROWS` | Rows in one audit export (hard maximum 20000). | 20000 |
| `MANYTHREADS_WEBHOOK_RATE_PER_MINUTE` | Webhook calls per minute per address. | 120 |
| `MANYTHREADS_LLM_TEST_TIMEOUT_MS`, `MANYTHREADS_LLM_PROXY_TIMEOUT_MS` | Time limit for a provider test, and for a proxied model call. | proxy: 10 minutes |
| `MANYTHREADS_VAPID_PRIVATE_KEY`, `MANYTHREADS_VAPID_SUBJECT` | Browser push signing key (the chart makes it) and contact address. | subject: the public URL |
| `MANYTHREADS_PUSH_HOSTS` | Extra push-service hosts allowed. | built-in list of push services; extra host suffixes, comma separated |
| `MANYTHREADS_LITELLM_URL`, `MANYTHREADS_LITELLM_MASTER_KEY` | Model gateway. The chart sets both when `litellm.enabled`. | unset |
| `MANYTHREADS_HINDSIGHT_URL`, `MANYTHREADS_HINDSIGHT_API_KEY` | Memory engine. The chart sets both when `hindsight.enabled`. | unset |
| `MANYTHREADS_HERMES_ALLOWED_HOSTS`, `MANYTHREADS_HERMES_PODS_INTERVAL_SECONDS` | Hosts a Hermes connection may use, and how often pods are checked. | pods: 30 |
| `MANYTHREADS_OIDC_ALLOW_PRIVATE_ISSUERS` | Allow single sign-on providers on private addresses. | off |
| `MANYTHREADS_ALERT_*` | Alert hooks. See [monitoring.md](monitoring.md). | |

Never set `MANYTHREADS_TEST_AUTH_TOKEN`, `MANYTHREADS_TEST_PLUGINS`, `MANYTHREADS_SPIKE_SLACK_COMPAT` or the chart value
`testAuth.enabled` on a real install. They exist for automated tests. The server refuses the test token in production
unless `MANYTHREADS_ALLOW_TEST_AUTH_IN_PRODUCTION=1`.

## Upgrades and migrations

```sh
git pull
export TAG=$(git rev-parse --short HEAD)      # then repeat step 3 for the server and web images only
# edit imageTag in my-values.yaml
helm upgrade --install manythreads ./deploy/helm/manythreads -n manythreads -f my-values.yaml
```

- **What runs on start.** The server applies pending database migrations before it listens. They are plain SQL files, each
  in its own transaction, run under a database lock so two starts cannot collide. `/readyz` stays 503 ("Migrations pending")
  until all are applied.
- **Edited migrations.** The server stores a checksum of each applied file and refuses to start if one changed.
- **Pod swap.** The server pod is replaced, not rolled in parallel (it holds read-write volumes). Expect a short outage.
- **Rollback.** There are no down migrations. `helm rollback manythreads <revision> -n manythreads` puts the previous
  images back (see `helm history manythreads -n manythreads`). It does not undo database changes. If a release changed the
  schema, restore a backup taken before the upgrade. Take one before every upgrade: `kubectl -n manythreads create job --from=cronjob/manythreads-backup pre-upgrade`.
  Whether an older server runs on a newer schema has not been tested.
- **Postgres version.** The database is a Postgres 19 beta build. Its data files open only with the build that wrote
  them. Do not change `postgres.image` without a dump and restore.

## Backups and restore

Set `backup.enabled: true`. A nightly job (02:17 UTC by default) writes a dump and the file volumes to the
`manythreads-backups` volume (10 Gi by default) and keeps 7 sets. By default it dumps only the `manythreads` database. With Hindsight on, add
`backup.databases: [manythreads, hindsight]`. Copying sets off the machine, the restore drill and the restore steps are in [backup.md](backup.md)
(`tools/backup/pull.sh`, `restore.sh`, `drill.sh`). Copy the sets off the machine: the backup volume is on the same disk.
Also save the encryption key from step 5. `tools/backup/pull.sh --with-secrets` saves it to a file.

## Monitoring

`/healthz` and `/readyz` are public. Metrics, alerts and the log lines to watch are in [monitoring.md](monitoring.md).

## Rate limits

Sign-in, password reset, invitations, webhooks and similar routes are limited per client address and counted in the
memory of each server pod. The table and the proxy setting that makes them correct are in [rate-limits.md](rate-limits.md).
If every visitor shares one counter, `MANYTHREADS_TRUST_PROXY` is wrong for your proxies.

## Security basics

- **Row-level security (RLS).** Team and person data sit in tables where Postgres itself filters rows by who is asking. The server
  uses three database roles (`manythreads_owner`, `manythreads_app`, `manythreads_system`); requests from signed-in people run as the restricted `manythreads_app`. See [security.md](../plugins/security.md).
- **Data loss prevention (DLP).** The preset is chosen under Settings > Workspace > LLM > Guard: standard (default), strict-egress, air-gapped,
  customer-facing. Settings > Workspace > Data protection (admin only) then sets, per kind of sensitive data, what happens when a bot is about
  to send it. See [guardrails-dlp.md](../plugins/guardrails-dlp.md).
- **Egress list.** Egress means traffic leaving your network. Each team has a list of hosts its bots may reach. It is stored and shown, but no real bot traffic is checked against it yet. See [guardrails-egress.md](../plugins/guardrails-egress.md).
- **Audit.** Settings > Workspace > Audit (admin only) lists recorded events without message text and exports a signed file. See [audit.md](../plugins/audit.md).
- **Keep the metrics endpoint and the database inside the cluster.** Do not expose them with extra ingress rules.
- **Retention and file cleanup ship in `dry-run`.** They log what they would delete and delete nothing until you set `on`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No `first-admin setup` line in the logs | A workspace already exists, usually because `seed.demo` was `true`. Reinstall with an empty database and `seed.demo: false`. |
| Sign-in appears to work, then you are signed out | Plain HTTP with the default public URL. Set `publicUrl: http://<host>`, or use HTTPS. |
| Pods stuck in `ImagePullBackOff` | An image was not imported into k3s. Run the `docker save ... \| k3s ctr -n k8s.io images import -` step again, with the exact tag. |
| Database pod never starts, event names `registry.local:5000` | `postgres.image` still has the default. Set it as in step 5. |
| `/readyz` 503 "Migrations pending" | The server is still migrating, or a migration failed. Run `kubectl -n manythreads logs deploy/manythreads-server`. |
| Server will not start: "was edited after it was applied (checksum changed)" | A migration file differs from the applied one. Use the original file from the release you ran. |
| Server will not start: key missing | `MANYTHREADS_KMS_KEY` is required in production. Check secret `manythreads-server-secrets`. |
| Every visitor shares one lockout counter | Either `server.trustProxy` does not match your proxy count, or (outside Cloudflare) k3s hides the visitor address; see the note in step 1. Details in [rate-limits.md](rate-limits.md). |
| Provider "Test" fails | Read the plain-language cause under the alias in Settings, Workspace, LLM (or the wizard's Models step). Check the key, the base URL, and that the LiteLLM pod is running. |
| Bots never answer | No Hermes runtime is connected (step 9), LiteLLM is off, or no alias works yet (step 8). |
| After a restore, stored provider keys fail | The restored database was encrypted with a different `MANYTHREADS_KMS_KEY`. Put the saved key back. |

Past failures and their fixes are collected in [MISTAKES.md](../../MISTAKES.md).

## Open points

- A full run of this page on a clean machine has not been recorded. The commands were checked against the chart and the scripts.
- The Postgres base image is pinned by digest on `ghcr.io`. If the registry stops serving that digest, the build in step 3 fails.
- The `postgres.mode: statefulset` fallback (a plain Postgres pod, image from `deploy/postgres/Dockerfile`) exists in the chart. It is not covered here.
- The smallest machine that runs the stack has not been measured.
- Outside Cloudflare, the Traefik setting in step 1 (`externalTrafficPolicy: Local`) is not tested by the project.
- Mode B pods and the Cloudflare mode were checked only by the project's own script, not by the plain commands on this page.
- Nothing here sets up single sign-on (Google or Microsoft). Passwords work without it. See Settings > Workspace > Sign-in.

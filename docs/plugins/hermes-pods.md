# hermes-pods

The **hermes-pods** plugin gives every team that has managed bots its own pod in the cluster, named `hermes-<team>`. A *managed* bot is
one whose `BOT.md` places it on the platform's own Hermes gateway (`placement: { gateway: { connection: managed } }`); Hermes is the open-source
agent program that runs the bot. This page is for an operator who wants to know what the plugin creates, how a bot's shell and repositories
are laid out, and how the deployer bot ships apps. You need a cluster the server can reach (k3s on the devbox), the chart's `hermesPods`
values, and the `runtime-hermes` plugin (it renders each bot's profile — the directory Hermes reads as its home).

```
 server pod (plugin hermes-pods)                    pod hermes-<team>  (no Kubernetes token inside)
 ┌────────────────────────────┐   Kubernetes API   ┌───────────────────────────────────────────────────────────┐
 │ reads profiles from the    │ ───────────────▶   │ hermes container (uid 1000)     workbench container (root*) │
 │ hermes.profiles provider,  │  Deployment,       │  hermes gateway run             sshd on 127.0.0.1:2222      │
 │ writes Secret/ConfigMap/   │  Service, PVCs,    │  api_server on :8642            one Unix user per bot       │
 │ Deployment                 │  Secrets,          │  sync loop: Secret → profiles   chromium, git, node, python,│
 └────────────────────────────┘  ConfigMap         │  ssh private keys (here only)   kubectl, /dev/shm 1Gi       │
        │  runs: POST http://hermes-<team>:8642/p/<profile>/v1/runs   └──── ssh as the bot ─────────▶ commands run
        └───────────────────────────────────────────▶ (Bearer <profile API_SERVER_KEY>)               as that bot
 * root only so sshd and useradd can work; every command a bot runs is that bot's own unprivileged user.
```

## What the controller creates, per team

All names start with `hermes-<team slug>` (if another team already holds that name, the first eight characters of the team id are added).

| Object | What it holds |
| --- | --- |
| `Deployment` (one replica, `Recreate`) | two containers, below; zero replicas when the team has no managed bots (volumes stay) |
| `Service` `hermes-<team>:8642` | the Hermes gateway; the server registers `http://hermes-<team>.<namespace>.svc:8642` as the team's `managed` connection (through the `hermes.profiles` provider's `setManagedGateway`) |
| `Secret …-profiles` | one JSON document: every bot's profile files plus its three secrets (`MCP_TOKEN`, `LLM_KEY`, `API_SERVER_KEY`). Only the Hermes container mounts it |
| `Secret …-key` | the gateway's own key (default profile), drawn once and kept |
| `ConfigMap …-bots` | the bots' Unix users and uids, and the repositories of record to create. No secrets |
| `Secret …-deployer` | a kubeconfig for the deployer, only when a bot named by `hermesPods.deployerBot` exists. Only the workbench mounts it, root-only |
| `PVC …-workspace` / `…-home` | `/workspace` of the workbench / the Hermes container's profiles (their `state.db`, sessions) and ssh keys |

The controller runs inside the server: once about twenty seconds after start and then every 30 seconds
(`MANYTHREADS_HERMES_PODS_INTERVAL_SECONDS`), and two seconds after the provider announces a change (`hermes.profiles.changed`). It
uses **server-side apply** (the Kubernetes API merges the fields it sends and keeps the rest), so a pass over an unchanged team changes nothing. It never
deletes a volume. A team that loses its last managed bot is scaled to zero.

The server's ServiceAccount (`manythreads-server`) has a `Role` in the pods namespace (`manythreads-bots`) for deployments, services, secrets, configmaps,
persistentvolumeclaims (get/list/create/patch/update) and pods (get/list), and nothing else (below: one Secret per apps namespace). Nothing cluster-wide, nothing in the platform namespace, no `pods/exec`. (`deploy/helm/manythreads/templates/hermes-pods.yaml`.)

## The two containers

**hermes** (image `manythreads/hermes-pod`, built from `deploy/images/hermes-pod` on top of `manythreads/hermes:stable`, which
`deploy/docker/hermes.Dockerfile` makes with Hermes' official installer). It runs `hermes gateway run` with `gateway.multiplex_profiles: true`
(one gateway process serves every profile) and the `api_server` platform on port 8642. A request to `/p/<profile>/v1/…` is answered by that
profile and needs *that profile's* `API_SERVER_KEY` as a bearer token; the gateway's own key does not open a profile. The *sync* (`sync.mjs`,
every ten seconds) turns the Secret into `~/.hermes/profiles/<name>/` (`config.yaml`, `SOUL.md`, `.env` with the three secrets, mode 0600):

* a **new** profile: written, then `hermes -p <name> gateway run` attaches it, MCP servers included, in about two seconds;
* a profile whose `config.yaml` or `.env` **changed**: rewritten, then `hermes -p <name> gateway restart` (a served profile keeps its old MCP
  connection and token otherwise);
* a **removed** profile: its directory is deleted (the gateway stops serving it within half a minute).

Kubernetes refreshes a mounted Secret within about a minute, so a change takes up to roughly 70 seconds to reach a running profile.

The profile's `terminal:` block is replaced by the sync: backend `ssh`, host `127.0.0.1`, port 2222, user `bot-<slug>`, key = that bot's private key,
working directory `/workspace/bots/bot-<slug>`. So a bot's commands never run in the Hermes container; they run as its own user in the workbench.
The key pair is made by the sync (`ssh-keygen`, ed25519); the **private half never leaves the Hermes container's volume**, the public half goes
through a shared in-memory folder to the workbench, which writes it to a root-owned `authorized_keys` file per user (a bot cannot add a key).
The pod has no Kubernetes ServiceAccount token (`automountServiceAccountToken: false`).

**workbench** (image `manythreads/workbench`, `deploy/images/workbench`): Microsoft's Playwright image (Chromium and its libraries) plus git, node 22
with pnpm, python 3, kubectl, sshd, sudo. `npx playwright` here is pinned to the browsers the image carries. `/dev/shm` is a 1 GiB memory volume so
Chromium does not crash. sshd listens on `127.0.0.1:2222` only, accepts only group `bots`, only keys, no forwarding. A loop (`mt-reconcile.sh`, every
five seconds) reads `/etc/workbench/bots.json` and creates or updates one Unix user per bot (uid from 20000, home `/workspace/bots/<user>`, mode 0700 — bots
cannot read each other's files), installs the public keys, and creates the repositories. A bot that leaves the file loses its login; its files stay.
Bot users have no password and no sudo except the two fixed commands below.

## Repositories: bare repository of record plus one clone per bot

`/workspace/repos/<name>.git` is a **bare** repository (history only, no working files) owned by the `repo` user, readable by everyone. Each bot has
its own full **clone** at `/workspace/bots/<user>/<name>` (made when the repository appears; clones, not shared worktrees, so one bot's checkout can never
disturb another's). A bot commits there and `git push origin <branch>`. Pushing is routed through `sudo -u repo mt-receive-pack.sh` (the system
git config sets `remote.origin.receivepack`), so the *repo user*, not the bot, writes the repository and its **`update` hook cannot be bypassed from a
bot's own git settings**. The hook refuses any push to `refs/heads/main` (or `master`) from a bot; deleting branches and forced pushes are refused
too. Someone with access to the `repo` account (an operator via `kubectl exec`, or the platform) merges into main. A bot may create more repositories:
`sudo -u repo mt-repo-create.sh <name> [https-origin-url]`. The ConfigMap's list comes from `hermesPods.repos` (`"name"` or `"name=https://…"`).

## Namespaces and who may do what

| Namespace | Holds | Walls |
| --- | --- | --- |
| `manythreads` (the platform) | server, database, LiteLLM | the controller has **no rights here at all** |
| `manythreads-bots` (`hermesPods.namespace`) | the teams' pods | pod security *baseline* is enforced (no privileged pod, no hostPath, no host network); the server's ServiceAccount has a Role here only |
| `apps-<team>` (one per entry of `hermesPods.appTeams`) | the apps that team's deployer bot ships | pod security *restricted* enforced; a ResourceQuota; default container limits; default-deny network policy that allows DNS, the internet on 80/443 (no private, link-local or CGNAT address) and ingress from Traefik only; its own `deployer` ServiceAccount, token and Role |

Pod security is Kubernetes' own admission check on pods: a Deployment that asks for a privileged container or a host directory is accepted as an object
but its pods are refused. The `apps-*` namespaces and their rights are written in the chart, not created by the server at run time, on purpose: a server that
could create namespaces and roles could grant itself anything. So **a team must be listed in `hermesPods.appTeams` (and the chart redeployed) before its
deployer bot gets a credential**; the controller logs a warning otherwise. The server's only right in an apps namespace is to read the Secret `deployer-token`.

**The deployer.** The `deployer` Role in `apps-<team>` is full control of deployments, statefulsets, jobs, cronjobs, ingresses, services, configmaps, secrets and
volume claims, read of pods, logs and events (and deleting pods), nothing else, no RBAC objects. An admission policy (`manythreads-apps-guard`) adds: an Ingress
must use a host under `hermesPods.apps.host` and no default backend (a deployer cannot take over the platform's own host), and a Service must be ClusterIP.
The controller turns the team's token into a kubeconfig (server `https://kubernetes.default.svc`, default namespace `apps-<team>`) in the team's `…-deployer`
Secret; the workbench writes it to `/workspace/bots/bot-deployer/.kube/config`, **mode 0600, written by that bot's own user**, and removes it when the bot stops being the deployer. Team B's deployer
cannot touch `apps-<teamA>`.

**Where deployed apps are reached.** Wildcard DNS exists for `*.kahf.to` (it resolves to the devbox), so an app is a Deployment + Service + Ingress with host
`<app>.apps.manythreads.kahf.to` (`hermesPods.apps.host`). Traefik routes by host. Traefik's default certificate is self-signed for that extra
level of subdomain, so browsers warn until a wildcard certificate (`*.apps.manythreads.kahf.to`, needs a DNS challenge) is installed at the front door.

## The workbench is root: how it is kept safe

The workbench container runs as root (sshd and `useradd` need it), so everything it does with files a bot can touch is written defensively:

* `/workspace`, `/workspace/bots` are `root:root 0755` and `/workspace/repos` is `repo:repo 0755`, re-applied before sshd opens and on every five-second pass
  (`mt-lockdown.sh`), so a bot cannot rename or replace them (the volume arrives world-writable).
* `mt-reconcile.sh` only creates a bot's home directory itself; every file operation inside a home (git identity, clone, the deployer kubeconfig) runs as that bot's own user
  (`runuser`), so a symlink a bot plants can only redirect that bot's own writes. A home that is a symlink is refused.
* `mt-receive-pack.sh` (the only way a bot pushes) accepts exactly `/workspace/repos/<name>.git`, no symlinks, directory, `hooks/` and `config` owned by `repo`, and
  forces `core.hooksPath` to the repository's own hooks. `safe.directory` names each repository path (never `*`).
* The `update` hook, for pushes through that script (it sets `MT_BOT_PUSH=1` itself; `sudo` strips whatever a bot sets), allows branches only (`refs/heads/*`) and
  refuses `main`, `master`, the branch `HEAD` points to, tags and every other ref. It does not look at who the user is.
* Only `sudo` keeps a setuid bit; sshd refuses agent forwarding, user environments and rc files.

## Network and resources

`NetworkPolicy manythreads-hermes-pods` (in `manythreads-bots`, enforced by k3s' built-in policy controller): **ingress** to the pods only from the server pods on port 8642.
**Egress** only to DNS (kube-dns), the server (3000), LiteLLM (4000), the Kubernetes API address on 6443 (for the deployer's
kubectl) and the internet on 80/443 with every private range excluded (no database, no other namespace, no node). Each container has requests and
limits (`hermesPods.hermesResources` / `workbenchResources`); the Hermes container is non-root with all capabilities dropped and no privilege escalation; the
workbench keeps only the capabilities sshd, useradd and sudo need.

## Settings

Chart values (`values.yaml`, `hermesPods`), passed to the server as `MANYTHREADS_HERMES_PODS_*`:

| Value | Meaning |
| --- | --- |
| `enabled` | turns the controller on (`MANYTHREADS_HERMES_PODS=1`); off in the base values, on in `values-live.yaml` |
| `images.hermes`, `images.workbench` | built and imported by `tools/devbox/deploy.sh`, tagged by the content of their build folders |
| `workspaceSize`, `homeSize`, `storageClass` | volumes per team |
| `repos` | repositories of record created in every team's workbench |
| `deployerBot` | slug of the bot that gets the deployer kubeconfig (default `deployer`) |
| `namespace` | the teams' pods' namespace (`manythreads-bots`) |
| `appTeams`, `apps.prefix`, `apps.host`, `apps.quota`, `apps.limitRange` | the teams that get an apps namespace, its name prefix, the wildcard host, quota and default limits |
| `apiServer.cidr`, `apiServer.port` | the Kubernetes API address for the network policy (empty: looked up at render time) |

`MANYTHREADS_HERMES_PODS_STATIC` = `{"<team slug>": [<profile specs>]}` stands in for the platform's profiles in tests; the server **refuses it when `NODE_ENV=production`**.

## Verifying a pod by hand

```
kubectl -n manythreads-bots get pods
kubectl -n manythreads-bots exec deploy/hermes-<team> -c hermes -- curl -s -H "Authorization: Bearer <profile key>" \
  -d '{"input":"hi"}' http://127.0.0.1:8642/p/mt-<bot>/v1/runs           # 202 with a run id
kubectl -n manythreads-bots exec deploy/hermes-<team> -c workbench -- runuser -u bot-<bot> -- npx playwright --version
```

Tests: `packages/plugins/hermes-pods/test` runs the controller against a fake Kubernetes API (an in-memory store with apply semantics) and a stand-in for
the provider, and the HTTP client against a local server. No cluster needed.

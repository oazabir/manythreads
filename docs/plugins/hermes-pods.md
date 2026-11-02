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
 └────────────────────────────┘  ConfigMap         │  ssh private keys (here only)   kubectl, helm, /dev/shm 1Gi       │
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
deletes a volume, with one exception: a machine move ("Choosing the machine", below) deletes the two volume claims of the team that is moving, and only those. A team that loses its last managed bot is scaled to zero.

The server's ServiceAccount (`manythreads-server`) has a `Role` in the pods namespace (`manythreads-bots`) for deployments, services, secrets, configmaps,
persistentvolumeclaims (get/list/create/patch/update, and since P19-08 delete, used only by a machine move) and pods (get/list), and nothing else (below: one Secret per apps namespace). Nothing in the platform namespace, no `pods/exec`. The one cluster-wide right is a **read of the machines** (`nodes`: `get`, `list`) in a ClusterRole `<release>-manythreads-nodes-reader`, for the machine picker (P19-08; [security](./security.md#the-one-cluster-wide-permission-nodes-read-only)). It cannot change anything; a chart test checks that. (`deploy/helm/manythreads/templates/hermes-pods.yaml`.)

## The two containers

**hermes** (image `manythreads/hermes-pod`, built from `deploy/images/hermes-pod` on top of `manythreads/hermes:stable`, which
`deploy/docker/hermes.Dockerfile` makes with Hermes' official installer). It runs `hermes gateway run` with `gateway.multiplex_profiles: true`
(one gateway process serves every profile) and the `api_server` platform on port 8642. A request to `/p/<profile>/v1/…` is answered by that
profile and needs *that profile's* `API_SERVER_KEY` as a bearer token; the gateway's own key does not open a profile. The *sync* (`sync.mjs`,
every ten seconds) turns the Secret into `~/.hermes/profiles/<name>/` (`config.yaml`, `SOUL.md`, `.env` with the three secrets, mode 0600):

* a **new** profile: written, then `hermes -p <name> gateway run` attaches it, MCP servers included, in about two seconds;
* a profile whose `config.yaml` or `.env` **changed**: rewritten, then `hermes -p <name> gateway restart` (a served profile keeps its old MCP
  connection and token otherwise). The `# manythreads tools: <digest>` line in `config.yaml` is the full tools digest of the bot (names, descriptions, schemas,
  `needsApproval`), so a changed tool list restarts a profile whose Hermes did not take the push. `SOUL.md` is a fixed one-line identity and never
  restarts anything: Hermes freezes it per thread, so the body of `BOT.md` travels as `instructions` on every run instead;
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
`sudo -u repo mt-repo-create.sh <name> [https-origin-url]`. The ConfigMap's list comes from `hermesPods.repos` (`"name"` or `"name=https://…"`) plus the team's [projects](projects.md): each project is added as a repository named after it, cloned from its address, within about thirty seconds of the change. An address is cloned only if it starts with one of the prefixes in `hermesPods.repoOriginAllow`; a project on any other address gets no copy.

## Publishing a tested branch as a pull request

When a project has a GitHub token (set by a team lead on the Projects page, see [projects](projects.md)), the committer bot can publish a card's tested
branch to the project's origin and open a pull request there; a person merges it in GitHub, and that is the approval.

- **The token's journey.** The server writes it into the Secret `hermes-<team>-push` (one key per project name) through the `project.credentials`
  provider this plugin registers, using the same Kubernetes client as the rest of the controller (the controller's role also needs `delete` on secrets, so
  the last token's Secret can be removed). The workbench mounts the Secret read-only at `/etc/workbench-push`, readable by root only. Every few seconds
  `mt-push-sync.sh` (run by the reconcile loop as root) copies each entry (a JSON document: the token, the repository address and the main branch it was issued for, and when it was set; a project on an owner's shared token holds a pointer `via` to the entry `_owner.<host>.<owner>`, which holds the token, and either may carry `refused: true` once GitHub has answered 401) to
  `/run/mt-push/<project>`: mode 0400, owned by the `repo` user, in a directory only root can write (0755, on a memory volume), so neither `repo` nor a bot
  can plant a link or swap a file there; copies whose key has left the Secret are deleted. The Secret volume is optional, so a team with no token has no Secret and the pod runs as before.
- **Who may publish.** Only bots whose definition grants `tasks.pull_request` (the engineering Committer): the controller marks them `publisher` in the bots
  ConfigMap and the reconcile loop keeps exactly them in the Unix group `publishers`, the only group sudo lets run `mt-publish.sh`. Other bots cannot push
  branches or open pull requests.
- **`mt-publish.sh`**, run as `sudo -u repo /usr/local/bin/mt-publish.sh …` (the sudoers file names exactly these two shapes), so a bot never reads the token:
  - `check <project>` prints `ready` (exit 0) when the project has a plain https GitHub origin and a token issued for that very origin, exits 3 when not, and exits 7 when the token is marked refused (GitHub answered 401). `publish` exits 7 the same way, and when the push or the API answers with a bad-credentials refusal. The script only returns 7; the mark itself is written by the server (the job and the pull-request sync).
  - `publish <project> <card id> <tested commit> <title>` (the pull request's text on standard input) refuses unless the branch `card-<first 8 characters
    of the card id>` of the repository of record is at exactly that commit (exit 4), pushes that one branch to the origin (a plain push of the exact
    commit: never the main line, never forced, so an origin branch that holds other work refuses it, exit 5), opens the pull request against the project's main branch (as the token was issued for it) (or finds the open one for that branch, so running it twice is safe; an open one that is not at the tested commit is refused, exit 4, after waiting up to a minute for GitHub to move it to the pushed commit) and prints `pull_request_number=`, `pull_request_url=` and
    `head_sha=`. Exit 6 means GitHub refused or did not answer.
  - The token reaches git through `GIT_ASKPASS` (`mt-askpass.sh`, which reads the token file) and reaches curl as a header read from standard input, never
    in a command line (other users of the pod can read command lines from `/proc`). Everything the script prints is masked for the token.
- The controller removes, every minute, a token whose project row never got the "token set" flag (a request that failed to commit after writing the Secret) once it is two minutes old.
- Changes to a team's Secret are serialised inside the server process only: the server runs as one replica (the blob volume requires it). Two replicas would need a cluster-side lock.
- The bot then records the pull request on the card with the `tasks.pull_request` tool ([tasks](tasks.md)), and the platform follows it.
- **After changing these scripts**, rebuild the workbench image (the deploy tags it by the content of `deploy/images/workbench`, so a deploy does it).
  The first rollout restarts each team's pod once, because the pod gains the optional Secret volume.

## Choosing the machine (P19-08)

A Kubernetes cluster can have several machines (**nodes**). A team's pod keeps its files on two volumes (`…-workspace` and `…-home`), and with the default storage class (`local-path`) a volume is a folder on one machine: it is made on the machine where the pod first starts and can never be read from another. So "which machine" is a decision, and an admin makes it per pod runner on the Runners page ([bot-runners](./bot-runners.md#the-machine-a-pod-runner-stands-on-p19-08)).

**What this plugin adds.**

* **The node lister.** It registers the provider `runner.nodes` when the controller is on (or, in tests, when `MANYTHREADS_HERMES_PODS_TEST_K8S_URL` points at a local double of the Kubernetes API). `listNodes()` reads `GET /api/v1/nodes` and answers, for each machine, its name (the `kubernetes.io/hostname` label), Ready (the Ready condition, and not cordoned), architecture and allocatable CPU and memory. `podPlacements()` reads the team pods, Deployments and volume claims by label and says, per team, whether a pod is running or waiting, where its volume is, whether a move is under way and whether one is held. `confirmMove()` is its one write: it puts the admin's confirmation (below) on the team's two claims, or takes it off. Where the volume is: this controller's own `manythreads.io/node` annotation when the claim has one (it holds the machine's `kubernetes.io/hostname`); otherwise the scheduler's `volume.kubernetes.io/selected-node`, which names the Node *object* and can differ from the hostname (a node started with a hostname override, some clouds), so that name is looked up in the node list and turned into the hostname before anything is compared. A name that cannot be looked up is an unknown machine, and an unknown machine is never judged stale.
* **The pin.** For a team the controller asks the `bot.runners` provider which machine the team's pod runners name (`teamRunners(...).podNode`: the default runner's machine, otherwise the first by name). A pinned Deployment gets `nodeSelector: kubernetes.io/hostname: <machine>`; the claims get the annotation `manythreads.io/node`. With no machine chosen nothing is emitted, so an install that never uses this behaves as before.
* **The move, and who may start one.** The volumes are deleted only by a move an admin confirmed. Anything else that changes the machine worked out for a team (Make default, Enable or Disable, editing a runner's Teams, a second pod runner that sorts first) changes nothing that holds data. For each team the controller decides one of these:
  * **a new pod** (no volume claims yet): the pod is pinned to the machine chosen;
  * **volumes already on the machine chosen**, or tied to no machine: the pod is pinned to it;
  * **volumes on another machine, move not confirmed: held.** The pod stays pinned to the machine its volumes are on and keeps running; the Deployment gets the annotation `manythreads.io/move-held` (the machine wanted); nothing is stopped or deleted. The Runners page says "Waiting: the machine for this pod changed, and nothing has been moved. Open Machine and confirm the move." (reason `move_not_confirmed`);
  * **volumes on another machine, move confirmed:** a confirmation is the mark `manythreads.io/move-confirmed` = `<machine>@<time>` that `PUT …/node` puts on both claims. It counts when it names the machine wanted, is not older than **15 minutes**, and is on every claim the team has. Before anything is stopped the controller checks the machine: it must be a node of the cluster (the list is read again), Ready, and on the operator's list (`MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES`). If it cannot be checked, the move is held (not started) or stays stopped (already started) and **nothing is deleted**. Then three passes (about a minute): (1) the Deployment is applied with zero replicas and the annotation `manythreads.io/moving`, the claims left alone; (2) when no pod of the team is left (a stopping pod still holds its volumes) **both claims are deleted, or neither**: each must carry this team's `manythreads.io/team-id` label, and one left behind would tie the pod to the old machine; (3) the next pass makes the claims new, annotated with the chosen machine, and starts the pod there. A move under way finishes even after the 15 minutes have gone (the pod is already stopped), and a team whose managed bots are gone is still looked at once more while its Deployment carries the `moving` or `move-held` annotation, so a stopped pod is finished or cleared. Each pass can be repeated safely. **Clearing the choice never moves anything**: pods stay where they are.
  * A claim made before this annotation existed keeps the machine it is on: the controller re-applies it stamped with the machine it found, never with the machine now wanted.
* **What the Secrets do.** Nothing is deleted but the claims: the Secrets (`…-key`, `…-profiles`, `…-deployer`), the ConfigMap and the Service are applied as always, so the gateway key, the bots' keys and the profiles' definitions survive. The server already registered the team's address, and it does not change.

**What is lost in a move, in plain words.** Both volumes are made again empty. Gone: each bot's working copy and any repository there that has not been pushed to its origin, the Hermes profiles' history (`state.db`, sessions) and the SSH keys on the home volume (new ones are made when the pod starts). Kept: everything in a Secret or in the platform's own database (bots, messages, memory, tokens), and the repositories of record, which are cloned again from the list in the ConfigMap. The page says this before it moves anything and asks to confirm. If a clone fails, check the pod's logs; nothing else is left half done.

**What the cluster allows, and what is not done.** It has not been run on a cluster of two machines in this phase (the test environment has one); the move is covered by a local double of the Kubernetes API and by unit tests. A volume on a storage class that follows a pod between machines (a network disk) is not recreated by this logic unless its annotation names another machine, which such a class does not set; moving such a pod just reschedules it. The pod of a team whose chosen machine is not Ready stays Pending and the page says "Waiting: node … is not Ready"; nothing is deleted while it waits. If two pod runners name different machines for one team, the default's machine wins (there is one pod per team); a change in which runner wins is a change of the computed machine, so it is held like any other until an admin confirms. When the `bot.runners` provider is not loaded the pass fails (as it does for the profiles) rather than reading it as "no machine". A machine that is deleted from the cluster after being chosen leaves the pod Pending in the same way.

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
volume claims, read of pods, logs and events (and deleting pods), nothing else, no RBAC objects. An admission policy (`manythreads-apps-guard`, a Kubernetes rule that checks every object before it is stored) adds the rules below, which depend on `hermesPods.apps.routing`
(see "Where deployed apps are reached"). In both modes an Ingress (the object that publishes a Service on a web address) has no default backend, and a Service must be ClusterIP.
* `path` routing (default): every rule host is exactly the platform's own host, and every path is `/apps/<team>/<app>` (a trailing slash is allowed) with pathType `Prefix`, where `<team>` is the
  namespace's own team and `<app>` is one segment of lowercase letters, digits and single hyphens, at most 63 characters. An app can therefore never claim `/`, `/api`, `/mcp` or another team's paths.
  The Ingress must carry exactly the annotation `traefik.ingress.kubernetes.io/router.middlewares: apps-<team>-apps-path@kubernetescrd` (the protective chain below), no other `traefik.*` annotation, and no `tls` section (it could install a certificate for the platform's host).
* `host` routing: a host of the form `<app>--<team>.<hermesPods.apps.host>` (one label; the app part may use single hyphens but never `--`, because `--` separates it from the team, so two teams can never get the same host; at most 63 characters; never a wildcard, never the platform's own host or another team's); no `traefik.*` annotation.
The controller turns the team's token into a kubeconfig (server `https://kubernetes.default.svc`, default namespace `apps-<team>`) in the team's `…-deployer`
Secret; the workbench writes it to `/workspace/bots/bot-deployer/.kube/config`, **mode 0600, written by that bot's own user**, and removes it when the bot stops being the deployer. Team B's deployer
cannot touch `apps-<teamA>`.

**Where deployed apps are reached.** An app is a Deployment + Service + Ingress. `hermesPods.apps.routing` chooses the address:

| `routing` | Address | Needs |
|---|---|---|
| `path` (default) | `https://<domain>/apps/<team>/<app>/`, e.g. `https://manythreads.kahf.to/apps/engineering/money/` | nothing beyond the platform's own domain and certificate |
| `host` | `https://<app>--<team>.<hermesPods.apps.host>/`, e.g. `https://money--engineering.manythreads.kahf.to/` | a wildcard DNS record `*.<domain>` pointing at the cluster and a wildcard certificate (`tls.wildcard: true`; Cloudflare's free certificate does not cover a name two levels below the zone) |

`host` routing is the earlier behaviour, unchanged: one label `<app>--<team>` under the domain, so one wildcard certificate covers every app, and Traefik (the cluster's web router) routes by host.
In either HTTPS mode the certificate becomes Traefik's default, so app Ingresses in the teams' namespaces need no certificate of their own (see "HTTPS: Cloudflare or Let's Encrypt" in `docs/deploy.md`). With `tls.mode: none` Traefik serves its self-signed certificate and browsers warn.

**Path routing and why the apps are sandboxed.** In `path` mode an app shares the platform's address (its *origin*: scheme, host and port), so a browser would otherwise send the platform's session cookies to the
bot-written app and let the app's JavaScript act as the signed-in person. The chart prevents both. In every apps namespace it creates Traefik `Middleware` objects (small request/response filters) that the
deployer cannot change, because its Role has no rights on `traefik.io` objects, and the admission policy accepts only an Ingress that names the chain `apps-path`:

1. `apps-slash`: `/apps/<team>/<app>` without the trailing slash is redirected to the address with one, so relative links in the page resolve under the app.
2. `apps-isolate`: the **`Cookie` and `Authorization` request headers are deleted**, so the app's backend never sees the platform's cookies or tokens. The response gets
   `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads` (the page runs in an *opaque origin*, a throw-away identity that is not the platform's: its scripts cannot read the platform's cookies, storage or API answers),
   `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` (these replace whatever the app set), and any `Set-Cookie` the app sends is dropped (Traefik removes a header whose configured value is empty), so an app cannot plant cookies on the platform's host.
3. `apps-strip`: `/apps/<team>/<app>` is cut from the path before the app sees it; Traefik passes the removed part to the app in the `X-Forwarded-Prefix` header.

**What this means for people who write apps** (the deployer bot is told the same in its kubeconfig file): the app is served from a sub-path, so it must use **relative URLs** (`./style.css`, not `/style.css`) or build
absolute ones from `X-Forwarded-Prefix`; it gets **no cookies** (no sessions of its own: use tokens in the URL fragment or its own API calls); **`localStorage`, `sessionStorage` and IndexedDB are unavailable** in a sandboxed page;
because the page's origin is opaque, calls to the app's own backend count as cross-origin, so the backend must answer with `Access-Control-Allow-Origin: *` (and cannot use credentials). Top-level navigation out of the page, and the platform's cookies, are not available to it.
Apps that need real cookies or storage should use `host` routing, which gives every app its own origin.

## Deploy targets: a namespace the deployer fully controls

Beyond its apps namespace, a team's deployer bot can be given whole namespaces to administer, to try a modified copy of the platform (`hermesPods.deployTargets` in the chart, for example
`{ team: engineering, namespace: test-manythreads, hosts: [test.manythreads.kahf.to] }`). The chart makes the namespace, a `deployer` account whose Role covers that namespace only (workloads, Jobs, Secrets,
volumes, Ingress, `pods/exec`, the database operator's `Cluster`, cert-manager's `Issuer`/`Certificate`; no RBAC objects, nothing cluster-wide), a quota, network policies and an admission rule that limits Ingress hosts to `hosts`.
The controller reads each target's `deployer-token` Secret and adds one **context per target** (named after the namespace) to the deployer bot's kubeconfig; the default context does not change, and a target whose token is
not ready is left out with a warning. The `deployer` bot's workbench image carries `helm` for this. The full story (what is allowed and refused, the in-cluster registry that holds the images, the one host step, sizing and the
build-and-install checklist) is in `docs/deploy-preview.md` and `deploy/preview/README.md`.

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
| `appTeams`, `apps.prefix`, `apps.host`, `apps.quota`, `apps.limitRange` | the teams that get an apps namespace, its name prefix, the host the apps live under (default: the domain), quota and default limits |
| `apiServer.cidr`, `apiServer.port` | the Kubernetes API address for the network policy (empty: looked up at render time) |
| `botRunners.allowedNodes` (outside `hermesPods`) | the machines an admin may choose for a pod runner, by name; empty means every machine. Passed to the server as `MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES` |

`MANYTHREADS_HERMES_PODS_STATIC` = `{"<team slug>": [<profile specs>]}` stands in for the platform's profiles in tests; the server **refuses it when `NODE_ENV=production`**.

## Verifying a pod by hand

```
kubectl -n manythreads-bots get pods
kubectl -n manythreads-bots exec deploy/hermes-<team> -c hermes -- curl -s -H "Authorization: Bearer <profile key>" \
  -d '{"input":"hi"}' http://127.0.0.1:8642/p/mt-<bot>/v1/runs           # 202 with a run id
kubectl -n manythreads-bots exec deploy/hermes-<team> -c workbench -- runuser -u bot-<bot> -- npx playwright --version
```

**Gateway only (P19-10).** A pod never holds a model provider's key. `src/gateway-only.ts` checks what the controller is about to apply: a bot profile whose secrets or environment would set a provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and their kin, or a provider base address) is left out of the pod (the log line starts `hermes-pods: ERROR:` and names the pod profile `mt-<slug>` and the reason, never a value; the plugin logger has no error level, and the bot has no profile in the pod until the cause is fixed), and `assertGatewayOnly` refuses to apply a Secret, ConfigMap or Deployment that holds one. The only model credential a pod may hold is the bot's own gateway key (`LLM_KEY`). The test renders profiles with the real `renderGatewayProfile`, runs them through the reconciler with canary provider keys in the process environment, and proves no provider variable, address or canary appears in any written object. The list of provider addresses is one constant (`MODEL_PROVIDER_ADDRESS` in `@manythreads/sdk`) shared by the renderer and this guard.

Tests: `packages/plugins/hermes-pods/test` runs the controller against a fake Kubernetes API (an in-memory store with apply semantics) and a stand-in for
the provider, and the HTTP client against a local server. No cluster needed.

# claude-pods

The **claude-pods** plugin runs each Claude Code or Codex runner as its own pod in the cluster. A runner is a row of the `bot-runners` plugin with
kind `claude_cli` or `codex_cli`; the plugin keeps one pod per runner and team (since P26-21: several teams may share one runner, see [Shared runners](#shared-runners-p26-21)). Since Phase 26 the pod is an **agent pod**: it starts with no sign-in, the admin signs the agent in from the Runners page, and the pod can code,
test, deploy into a test namespace and check a page in a browser (next section). The older way, a sign-in file the admin uploads, still works for the runners that use it. This page is for an operator.

## Turning it on
- Chart: set `claudePod.enabled: true` (it needs `hermesPods.enabled: true`: same namespace, same Role; the permissions it adds are listed under "Every permission the runners add"). It is off by default.
- `tools/devbox/deploy.sh` builds the image only when `claudePod.enabled: true` is in `values-live.yaml`. `claudePod.fake: true` builds the stand-in image
  (`deploy/images/claude-pod-fake`), which answers like Claude without a sign-in; use it to check the plumbing.
- The server reads `MANYTHREADS_CLAUDE_PODS=1` and `MANYTHREADS_CLAUDE_PODS_*` (namespace, image, storage class, sizes, resources, model aliases).
  Without the first, the plugin does nothing and the runner list says `claudePodsAvailable: false`.

## What it creates, per runner
Names carry the runner's short name. The **runner** has: a claim `state` (`<agent>-<runner>-state`, 256Mi, the agent's home and the one sign-in), the sign-in Secret `<agent>-<runner>-credentials` (made by the upload route, not the controller), and, for the keeper, a ServiceAccount, Role and RoleBinding `<agent>-<runner>-keeper`.
Each **team** that has a bot on the runner has a pod of its own, named `<agent>-<runner>-<team>` (`claude-` or `codex-`; a hash replaces the tail when the name would pass 60 characters): a Deployment (one replica, or zero while the runner is off, is moving, or has an uploaded sign-in file and no bot of that team; a runner with no uploaded file keeps its pods up even with no bot, so the admin can sign in first), a Service
on port 8650, a ConfigMap `…-config` (bridge config with that team's bots only, and `repos.txt`), a Secret `…-key` with the bridge key, and the claim `…-work` (20Gi, since the pod builds and tests).
The init step of every team pod copies the Secret `claude-<runner>-credentials` into the shared state volume when the volume has no file yet, or when the Secret's `upload-id` differs from the one the volume last took (a replaced upload). The pod runs as uid 1000, read-only
root, no service-account token, tini as PID 1. Probes are TCP (the bridge's `/health` needs the key).
The NetworkPolicy lets only the server in (port 8650) and lets out DNS, the server, and public 443 when `egress.mode=public443`. A second policy opens the Kubernetes API at its node address (`hermesPods.apiServer`) only for a pod that carries the label `manythreads.io/kube-api: "true"`: a pod with a keeper, or a pod that holds the team's deploy login.

**The publisher container (P19-09).** With `claudePod.publisher.enabled` (the default; the server gets `MANYTHREADS_CLAUDE_PODS_PUBLISHER` and
`MANYTHREADS_CLAUDE_PODS_PUBLISHER_RESOURCES` from it) the pod has a third container next to the run and the keeper: the same image started as
`publisher.mjs serve`, uid 1001, read-only root, no Kubernetes token. It is how a bot gets its work pushed as one commit and a pull request (GitHub) or merge request (GitLab) opened without ever holding the push token
(the run container mounts no push Secret). The run calls `mt-publish check <project>` or `mt-publish publish <project> <card> <commit> <title> [<author name> <author email>]` (the request's text on standard input); that small command only talks to the publisher over a
Unix socket in a shared `emptyDir`. The publisher takes the run's own MCP token from the request, asks the server `GET /api/runs/self`, and gets back the team, the bot, the run
and `mayPublish` (the bot's definition grants `tasks.pull_request`). It publishes only the folder `/work/<team>/<bot>/<project>` the server's answer names, with that team's
token, through the same script the Hermes pods use (`deploy/images/workbench/mt-publish.sh`: same branch rule, same exit codes, same one squashed commit per card, same GitHub and GitLab support and same signing rules; see [hermes-pods](hermes-pods.md)). The two author words are the person who asked: a project that signs commits as the requester needs them (the script answers exit 2 without), a project that signs as the bot ignores them. The publisher checks them itself before it runs anything (a name of 1 to 100 characters with no line break, `<` or `>`; one email address of at most 200 characters; both or neither). The script's output (`project=`, `provider=`, `pull_request_number=`, `pull_request_url=`, `head_sha=` the squashed commit, `tested_sha=`) comes back unchanged, and the publisher passes `MT_GITLAB_API` (a test double of GitLab) on beside `MT_GITHUB_API` when its own environment sets it. A publish can also end with exit 4 because the project's main branch moved and the card must be rebuilt, or because there is nothing to publish. It needs the server (port 3000, inside the cluster)
and, to reach the git host, public 443; both are in the pod's one NetworkPolicy. With `egress.mode=serverOnly` it can only answer "refused".

**The pod rolls when the bots change.** The pod template carries the annotation `manythreads.io/profiles-sha`, a hash of the bridge's profiles (each bot's folder, model, allowed
tools including `mt-publish`, instructions, and the runs-at-once limit). A change to a bot's placement or grants (for instance `tasks.pull_request` added or removed), or a bot added to or
removed from the runner, changes the hash and **rolls the pod: a run in flight ends** and the next one starts on the new pod. (The bridge reads its profiles from a ConfigMap, so without the
annotation an old pod would keep the old list for about a minute.) A team added to or removed from the runner changes the pod's volumes and rolls it too.

## Moves
The node choice works as for Hermes pods: set a node on the runner, the controller applies it. A work volume is deleted only in an admin-confirmed move;
the confirmation `<node>@<epoch ms>` is valid 15 minutes. A move without it is shown as `waiting_for_node` and nothing is deleted. **A runner moves as one**: the state volume and every team's work volume must be on one machine
(a volume can be mounted by pods of one machine only), so a move holds all the runner's team pods, waits until every one has stopped, and only then deletes the state claim and all work claims (the Secrets are kept) and makes them again on the new machine.
A runner with several team pods and no chosen machine has its pods pinned to the machine its volumes are on, and a team added later has its work claim made on that machine.

## Shared runners (P26-21)
Several teams may use one runner: one agent sign-in and one subscription, shared. The platform keeps the teams apart by giving each team its **own pod** (docs/plans/agents-anywhere.md section 9b):
- **Shared by all pods of a runner:** the `state` volume (the agent's home and sign-in), the sign-in Secret, the keeper's identity. All pods are pinned to the machine of the state volume. The runner is `ready` when the shared sign-in is good.
- **Only the team's own:** Deployment, Service, bridge key Secret, ConfigMap with that team's bots (`<team>--<bot>` profiles), work volume, the repository list sent to the bridge, the push token mount of the publisher, the deploy login (that team's deployer only), the bridge's state folder `/state/bridge/<team>` and the agent's home `/state/home/<team>`. The renderer refuses to build a pod for more than one team, and the controller refuses an object it did not make (a name collision between two runner-and-team pairs).
- **Sign in once per runner:** the Runners page asks one running team pod of the runner (the first by name that is Running, else the first with a key; `bridge({ runnerName })` without a team) and the login lands on the shared volume, so every other pod has it. A run goes to the pod of its own team (`bridge({ runnerName, teamSlug })`), so a team never reaches another team's pod. Concurrency limits (`maxConcurrent`) apply per team pod; the plan's rate limits are the one subscription's and are shared.
- **Accepted risk:** the sign-in folder is on a volume every team pod mounts, so an agent of any team (a full-access Codex too) can read it. Teams on one runner trust each other with the one login, and the page says so ("Teams on this runner share its sign-in and its plan's limits").

**Migrating the single pod of a runner (done by the controller, nothing is copied or deleted but one key).** Before P26-21 a runner had one pod `<agent>-<runner>` with `-work`, `-key` and `-config`. On the first pass of the new controller: (1) the old Deployment is scaled to zero and the team pods are held at zero until the old pods are gone (two pods never write one volume); (2) the old work claim becomes the **first team's** work volume (the team that sorts first by slug, or the one the claim's `manythreads.io/team-id` label already names, so the choice never flips); the other teams get new work claims; (3) the old state claim is the runner's shared state volume as it is, so the sign-in stays; (4) the old key Secret is deleted (the one object the controller deletes; the old Deployment, Service and ConfigMap stay at zero replicas because its Role cannot delete them, and an admin may remove them). The old pod's runs end once; the new team pods start within a pass or two. A volume outside an admin-confirmed move is never deleted.


## The agent pod (Phase 26)
**What is in the pod.** One Deployment per runner and team, with these containers: `bridge` (the agent bridge, [agent-bridge](../agent-bridge.md), which drives the agent over ACP), `repo-sync`, `publisher`, and `keeper` only for a runner that has an uploaded sign-in file (and then only in the first team pod by name; all the team pods mount the sign-in Secret). The image is `deploy/images/agent-pod` (it keeps the name `manythreads/claude-pod` and the paths under `/opt/claude-pod`, so the stand-in image and the chart did not change). It is built on the same pinned Playwright image as the workbench (same digest), and adds `git`, `pnpm`, `kubectl`, `helm`, `claude` (the build the Claude adapter carries), `codex`, the two ACP adapters (`claude-agent-acp`, `codex-acp`), `script` (the Claude paste-code sign-in needs a terminal), `tini` and the bridge. The pod runs as uid 1000 with a read-only root and `allowPrivilegeEscalation: false`; no program in the image has a setuid or setgid bit. Writable: `/state` (the agent's home and sign-in), `/work` (20Gi), `/tmp` (2Gi), and `/dev/shm` (a 1Gi memory volume, so the browser does not crash). The run container is limited to 4Gi of memory. `MANYTHREADS_CLAUDE_PODS_DRIVER` is `acp` (the default); the stand-in image uses `cli`.

**Size and disk (measured on the devbox).** The image is 5.23 GB as Docker counts it, of which about 1.15 GB is new on top of the Playwright base that the k3s node already holds for the workbench: the two adapters and the two agent programs 961 MB, apt packages 153 MB, `kubectl` and `helm` 19 MB, the bridge and scripts a few MB. The plan's target was under 800 MB of new layers; it is not met (the agent programs are large files). One build leaves about 13 GB of build cache: run `docker builder prune -af` after it (disk went from 71 GB used, 74%, to 84 GB, 88%, and back to 71 GB). Never `crictl rmi --prune`.

**Signing in.** A new pod runner has no sign-in file. Its pod starts, and the admin presses **Sign-in** on the Runners page: Codex uses a device code (open a page, enter the code), Claude Code uses a pasted code (open a page, sign in, paste the code it shows). The server proxies this through the same routes as a bridge runner (`/api/admin/bot-runners/<id>/agent-auth`, bot-runners P26-10): the address and key of the pod's bridge come from this plugin's `bridge()` and never leave the server, a code you type goes to the bridge once and is stored nowhere, and the outbound guard is not used because it refuses cluster names on purpose. The login lives only in the pod's `state` volume. The runner is `waiting_for_sign_in` until the bridge's `GET /v1/auth/status` says `signed_in`, then `ready`; the controller asks the bridge on each pass, and the page moves the runner as soon as it sees the answer. A pod with no bot yet has one placeholder profile named `default`, so the sign-in works before any bot is placed. **Remove sign-in** is the same as before: the state claim is deleted and made again empty. Nothing copies a sign-in file from any home.

**Codex full access.** An admin can turn on **Full access** for a Codex runner (Runners page, any number of teams on the runner; every change is audited). Two keys must both be on: the runner's switch, which this plugin writes as `fullAccess: true` into the bridge's Codex profile, and the run's own request. The pod is the sandbox: it reaches the server and the internet on port 443 and no other address in the cluster (the NetworkPolicy above), and it holds no Kubernetes token unless it also has the deploy login below. Full access applies **per team pod**: the switch is the runner's, but each team's Codex runs in its own pod, which holds that team's files, key, push token and deploy login and nothing of another team's. Claude Code never gets it. The one thing the teams of a runner still share is the sign-in folder on the `state` volume, which a full-access Codex of any team could read (the accepted risk of a shared sign-in, written below).

**Deploy.** The bot named `hermesPods.deployerBot` (default `deployer`) of a team pod gets that team's deploy login: the plugin asks the Hermes pods' controller (provider `deploy.kubeconfig`, hermes-pods P26-11) for the Secret `hermes-<team>-deployer`, mounts it read-only into the run container at `/etc/deployer/<team>/`, and sets `KUBECONFIG` in that bot's profile only. The login is a namespace-scoped account for the team's apps namespace and deploy targets (for example `test-manythreads`), the same one the team's Hermes pod uses. The pod gets the kube-api label, so the second NetworkPolicy lets it reach the API. **Every bot of a pod runs as one user, so every bot of the pod can read that file and the bridge key** (the bridge's own key is in the run container's environment too). That is safe because a pod serves one team, and a team's pod never mounts another team's login.

**Repository of record.** The bots of one pod each have their own clone, so one bot's commits were invisible to the next. `repo-sync` now also makes one bare repository per team and project at `/work/<team>/repos/<project>.git`, with an `update` hook that refuses `main`, the default branch, deleting a branch and a forced push. The bots keep the public address as their `origin`; they reach the record only through `mt-git record-push <branch>` and `mt-git record-fetch` (the path is worked out from the clone's own place; links, alternates and worktree files are refused). A fetched branch appears as `refs/record/<branch>`, and the next bot starts its own branch from it (`mt-git checkout -b <new> refs/record/<branch>`). A card's work reaches GitHub only through the publisher as a pull request. Tests: `packages/plugins/claude-pods/test/record.test.ts` (real git).

**Tools for testing.** `pnpm` keeps its store in `/work/.pnpm-store` (the work volume, not the small `/tmp`), `npx playwright` finds the browsers the base image carries (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`), and the bots' instructions say so.

**Turning the agent pods on in the live site (the owner's step).** Nothing here changes `values-live.yaml`. To turn pods on: `claudePod.enabled: true` (needs `hermesPods.enabled: true`, `hermesPods.apiServer.cidr` or the lookup working, and `hermesPods.deployerBot` set); leave `claudePod.useFake` off so the real image is built (`tools/devbox/deploy.sh` builds it, with the disk guard); `botRunners.allowedNodes` if machines are to be chosen. Then, in the Runners page: add a Claude Code or a Codex runner, press Sign-in, sign in, and (Codex, one team) switch Full access on if wanted. The permission list below is what the owner accepts first.

## The sign-in file (P19-06, the older way)
The admin uploads the `.credentials.json` of a Claude login on the Runners page. The bytes are stored exactly as sent in the Secret `claude-<runner>-credentials`
(keys `.credentials.json` and `upload-id`) and nowhere else: the database holds the plan label, the expiry, a SHA-256 of the file and a keyed hash of the login
(to refuse the same login on a second runner); no event, audit row, log or answer holds the file. The upload id is also an annotation on the pod template, so a
replaced file rolls the pod. Removing the sign-in deletes the Secret and the runner goes back to `waiting_for_sign_in`.

The controller never applies the credentials Secret again, so what the keeper writes back survives a reconcile.

**Remove sign-in** (P19-12) deletes the state claim first and the credentials Secret second. The state volume holds the second copy of the login (the one the tool renews), so deleting only the Secret would leave a working login on disk; a claim still mounted stays `Terminating` until the controller has stopped the pod (it does so as soon as the Secret is gone), and is made again, empty, for the next sign-in. A failure deleting the claim stops before the Secret is touched. The work claim (public clones only) is kept. `packages/plugins/claude-pods/test/signin-removal.test.ts`; on the stage `stage-runners-probe.sh remove`.

**Keeper.** A second container in the pod watches the state volume (read-only) for a renewed `.credentials.json`. When the file has been stable for 2 seconds
and differs from the Secret it patches the Secret with the pod's own service account (`claude-<runner>-keeper`). Its Role allows `get` and `patch` on that
one Secret by name; the token is projected into the keeper container only. The chart gives the controller the right to create that ServiceAccount, Role and
RoleBinding (`manythreads-claude-pods-controller`; the one permission this feature adds).

**Gate.** The bridge (see [agent-bridge](../agent-bridge.md)) lets one run go at a time in the last 20 minutes before the access token runs out, so only one
process asks for a renewal, and remembers an account failure (a refused sign-in, or the plan's limit) so later runs fail at once without starting a process.

## Every permission the runners add
Everything below is in the chart (`deploy/helm/manythreads/templates/hermes-pods.yaml` and `claude-pods.yaml`); nothing is created by hand. "The pods namespace" is the
namespace the chart's `hermesPods.namespace` names (live: `manythreads-bots`). The owner has **not yet accepted** this list (PLAN P19-08 row); the Claude and
Codex pods stay off on the live site until then.

| Object | Who it is for | What it allows |
|---|---|---|
| Role `manythreads-hermes-pods-controller` (pods namespace) | the server's service account | `get`, `list`, `create`, `patch`, `update` on Deployments, Services, Secrets, ConfigMaps and claims; `get`, `list` on pods; `delete` on Secrets (a project's push token goes with its Secret) and on claims (only for an admin-confirmed move of a Hermes pod's machine). The Claude controller uses this same Role for its Deployment, Service, ConfigMap, Secret and claims; it adds no verb here |
| ClusterRole `<release>-manythreads-nodes-reader` and its ClusterRoleBinding | the server's service account | `get` and `list` on `nodes`, nothing else cluster-wide, for the machine picker (P19-08). Exists only when `hermesPods.enabled` is true |
| Role `manythreads-claude-pods-controller` (pods namespace) | the server's service account | `get`, `list`, `create`, `patch`, `update` on ServiceAccounts, Roles and RoleBindings of the pods namespace, so the controller can make the keeper's own account. No `delete`, nothing in the release namespace, nothing cluster-wide. Kubernetes refuses a Role that grants more than the controller itself holds |
| ServiceAccount `claude-<runner>-keeper`, its Role and RoleBinding (one set per runner, not per team; `codex-<runner>-keeper` for a Codex runner) | the keeper container only | `get` and `patch` on the one Secret that holds that runner's sign-in file, by name. The token is projected into the keeper container only |
| NetworkPolicy `manythreads-claude-pods` | the run, keeper and publisher containers (one policy for the pod) | in: the server on port 8650. Out: DNS, the server on its port (the MCP address, the API and `GET /api/runs/self`), and (below) public 443 |
| NetworkPolicy `manythreads-claude-pods-api` (P26-09) | only pods labelled `manythreads.io/kube-api: "true"` | out: the Kubernetes API at its node address and port (`hermesPods.apiServer`). The label is set by the controller on a pod with a keeper (it patches its Secret) and on a pod that mounts the team's deploy login |
| Secret `hermes-<team>-deployer` mounted into one pod (P26-09, P26-11) | the run container of the team's pod, when it has the deployer bot | the team's namespace-scoped deploy login, read-only at `/etc/deployer/<team>/`. Made by the Hermes pods' controller (the same Secret the team's Hermes pod mounts); no new Role |

**Mounts of a runner's pod.** The run container: `state` (the tool's home, with the sign-in; 256Mi), `work` (the team repositories and the repository of record; 20Gi), `/tmp` (2Gi) and `/dev/shm` (1Gi, memory), a read-only root
file system, uid 1000, no Kubernetes token (`automountServiceAccountToken: false`; only a pod with a keeper has a service account). The init step reads the sign-in Secret to fill `state`. The keeper container: `state`
read-only and its own projected token. When `claudePod.publisher.enabled` is on, the pod gets a third container, the publisher (P19-09): it is the only container that mounts a team's
push Secret (read-only), and it mounts `work` read-only. The run container mounts no push Secret; it reaches the publisher only through a socket in one shared `emptyDir`. No container of the pod gets a host path, a privileged setting or the Docker socket.

**The repo-sync container never trusts a clone (P19-09, security review).** It clones and fetches the public projects of the runner's teams into `work`, which the bot writes too, as the same user. A plain
`git -C <clone> fetch` reads the clone's own `.git/config` and `.git/hooks`, so a bot that had written `remote.origin.uploadpack`, `core.sshCommand`, an `include`, a `url.*.insteadOf`, `core.hooksPath`,
`core.fsmonitor` or a hook file there had a command run in the one container that has the network (the same attacks run against the old script start the program; see `packages/plugins/claude-pods/test/repo-sync.test.ts`).
`deploy/images/agent-pod/repo-sync.sh` now runs git in a fresh environment (`env -i`: none of the caller's `GIT_*` variables, no global or system config, https only, and hooks, fsmonitor, ssh and proxy commands,
credential helper and auto gc fixed on top of any config) and a fetch never reads the clone's config or hooks. It makes a private git folder in its own scratch folder (`/run/sync`, a 4Mi memory volume that
only this container mounts; `/tmp` and `/work` are shared with the bot, so a file kept there could be changed under the script's feet), with a fresh config and `objects`, `refs` and `packed-refs` linked to the clone's,
and fetches the address on the project list into `refs/remotes/origin/*`. The one thing read from the clone is its origin address, and it must equal the list's address or the clone is left alone. A team, bot,
project, `.git`, `objects` or `refs` folder that is a link is not followed, a clone with an alternates file is not fetched, a list address with a user name, query or odd character is skipped, and the first
clone is made under a hidden name with empty templates and moved into place. Automatic gc is off for these fetches (the clone's own config no longer decides). Tests: `repo-sync.test.ts` (real git, a local
bare origin, ten hostile set-ups, each also run as plain `git fetch` to show the attack works without the script).

**Push Secrets.** Each team on the runner's list has a Secret `hermes-<team>-push` (made by the Hermes pods' controller, one key per project, the same Secret the Hermes pod
reads). The publisher mounts it read-only at `/etc/publisher-push/<team>` (mode 0444 so uid 1001 can read it; optional: it exists only once a lead has saved a token for a project of the
team). The publisher keeps a private copy of one token file per request in a memory-backed `/tmp` and removes it at the end. No other container of the pod mounts these Secrets.

**Commands a bot may run without a question.** The bridge's profile for each bot carries a fixed list (decision E5, `render.ts`); the bot's definition has no field for it, so the
grant list is the permission.
- Every bot: `Bash(mt-git status:*)`, `Bash(mt-git diff:*)`, `Bash(mt-git log:*)`, `Bash(mt-git show:*)`, `Bash(mt-git rev-parse:*)`, `Bash(mt-git add:*)`, `Bash(mt-git commit:*)`, `Bash(mt-git switch:*)`, `Bash(mt-git checkout -b:*)`, `Bash(mt-git branch --show-current)`, and in an agent pod (ACP) also `Bash(mt-git record-push:*)` and `Bash(mt-git record-fetch)` (the repository of record: no other push, fetch or clone). **Never plain `git`.** Enough to look, and to commit on a branch of its own; nothing that reaches the network (no push, fetch or clone) or rewrites history.
  Why a wrapper: a pre-approved `git diff:*` also allowed `git diff --no-index <any file> /dev/null` (prints a file outside the project, such as the shared Claude login under `/state`), `git log --output=<path>` (overwrites a file), `git add --pathspec-from-file=<file>` (leaks a file in its error text) and, once a bot that may write files had put a hook or a `core.fsmonitor`, `filter`, `diff.external` or `core.hooksPath` line into `.git`, `git status` or `git commit` ran any command. `mt-git` (`deploy/images/agent-pod/mt-git.mjs`, installed as `/usr/local/bin/mt-git` by `mt-git.sh` in both pod images; the run's instructions tell a Claude bot to use it) accepts only the commands above, each with a fixed list of options (`-c`, `-C`, `--git-dir`, `--work-tree`, `--no-index`, `--output`, `--pathspec-from-file`, `--exec-path`, `--ext-diff`, `--textconv`, `--amend`, `switch -C` and every abbreviation of a long option are refused; `commit` needs `-m`), refuses a path that leaves the project folder (the folder of every path is resolved through links first), finds the project itself (a real `.git` folder: no `.git` link or file, no `commondir`, no alternates, no `config.worktree`) and runs git with `GIT_DIR` and `GIT_WORK_TREE` set to it, with a fresh environment (no global or system config, no external diff, pager, editor or prompt; the caller's `GIT_*` variables are dropped) and with `core.hooksPath=/dev/null`, `core.fsmonitor=false` and the other program-starting settings fixed on the command line. It also reads the project's `.git/config` as a list of keys first and refuses to run when it holds anything but remotes, branch tracking, `user.name`/`user.email` and a few plain `core` switches, so no alias, filter, textconv, diff driver, `core.worktree`, include, credential or gpg line is ever honoured. A refusal is exit code 2 with a line starting `mt-git:`; git's own exit code is kept otherwise. Tests: `packages/plugins/claude-pods/test/mt-git.test.ts` (real git, a hostile `.git` and made-up canary files, each attack also run as plain git to show it works without the wrapper).
  A bot whose definition grants the `shell` tool group is allowed all of `Bash` by the bridge and can still run plain `git`; that is the shell grant, not this list (PLAN phase 19 decision 9: "by folder, not by wall").
- Only a bot whose definition grants `tasks.pull_request`: also `Bash(mt-publish:*)`, the client of the publisher above. Without the grant the command is not allowed, and the
  server's answer (`mayPublish` false) would refuse it anyway.

**Egress: public 443 until measured.** The chart value `claudePod.egress.mode` is `public443` by default: the pod may reach any public address on port 443 and no private
address. The reason is plain: which host names the Claude and Codex tools really need was never measured (task P19-01 (d)), and a narrower list that is wrong stops every
run. `serverOnly` lets the pod reach only DNS and the server, which is all the stand-in image needs. A team whose egress rule names a proxy is a separate rule for the
Hermes pods (see [hermes-pods](./hermes-pods.md)); it does not narrow a Claude pod. The list of hosts is an open item in [the Phase 19 retro](../retro/phase-19.md).

## Codex pods (P19-13)
A runner of kind `codex_cli` uses the same plugin and the same reconciler, in the same pass as the Claude runners (the runner list is both kinds read together; if either
read fails the whole pass fails, so a pass never takes one kind's pods for pods of runners that are gone). Everything that differs is one table in `render.ts` (`AGENTS`):

| | Claude runner | Codex runner |
|---|---|---|
| Objects | `claude-<runner>`, `-state`, `-work`, `-key`, `-credentials`, `-config`, `-keeper` | the same with `codex-` for `claude-`: no object name is shared with a Claude runner |
| Sign-in Secret key | `.credentials.json` (+ `upload-id`) | `auth.json` (+ `upload-id`) |
| Tool's home | `CLAUDE_CONFIG_DIR=/state/claude` | `CODEX_HOME=/state/codex`, so the file is `/state/codex/auth.json` |
| Bridge profile | `agent: claude-code`, `extraAllowedTools` (git, `mt-publish`) | `agent: codex`, no `extraAllowedTools` (that list is Claude Code's), `modelAliases` from `MANYTHREADS_CLAUDE_PODS_CODEX_MODEL_ALIASES` (empty by default: Codex uses the model its plan gives) |
| Bridge container env | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` and `MANYTHREADS_BRIDGE_IN_POD=1` |
| Keeper | watches `.credentials.json`, accepts a file with `claudeAiOauth.refreshToken` | watches `auth.json` (`KEEPER_KIND=codex`), accepts only a file with `tokens.refresh_token` and no API key, and **waits while `auth.lock` is next to it** |
| Publisher | shared: the same third container, the same push Secrets, the same socket | |

The bridge drops `OPENAI_API_KEY` from the environment of a Codex process when it runs in a pod (`MANYTHREADS_BRIDGE_IN_POD=1`): a key would go around the platform's
model gateway. Only the ChatGPT sign-in file is accepted. The keeper copies a renewed `auth.json` into `codex-<runner>-credentials` only when the file has held the same
size and modification time for 2 seconds **and** `auth.lock` does not exist; while the lock exists it copies nothing and the quiet time starts again once the lock is gone
(it looks once more right before the copy). Whether the real Codex CLI makes a lock file of that name is not measured (the owner test of P19-13); the keeper simply honours
the file if it exists. The keeper's Role is made the same way as for Claude: `get` and `patch` on the one `codex-<runner>-credentials` Secret by name, nothing else.

The pod's network policy and the controller's Roles are the Claude ones (a Codex pod has the same `claude-pod` component label); Codex adds no permission. When a Codex
runner stops taking runs, the catalog writes `codex_pod.runner.paused` (a plan limit, or a sign-in that must be done again); uploads and removals write
`codex_pod.credentials.*`. The machine picker works for a Codex runner exactly as for a Claude one (one pod of its own). Codex pods stay off on the live site with the
Claude ones. How to find the file: [runner sign-in files](../guide/runner-signin-files.md).

## Who may do what
| | Workspace admin | Team lead | Team member | Guest |
|---|---|---|---|---|
| Make, change, delete a runner; upload or remove its sign-in file; pick its machine; set the default; share it with teams | yes | no | no | no |
| See every runner, its address, plan and usage | yes | no | no | no |
| See the short list of runners their team may use (name, label, kind, state, default, owner, plan, how many teams) | yes (any team) | yes | yes | only when the guest sits in that team; otherwise `403` |
| Put a bot on a runner (the "Runs on" select, or `placement.runs_on` in `BOT.md`) | yes | yes, for runners the team may use | no (cannot edit a bot's definition) | no |
| Ask a bot that runs on a runner | yes | yes | yes | where the guest could ask that bot anyway |
| See the runner's account details (login, tokens) | nobody: they are never returned | | | |

A bot on a runner is a normal bot: what it may do is its own capability list, not the runner's.

## Stand-in commands and the seed
`claudePod.useFake: true` swaps the pod image for `deploy/images/claude-pod-fake`. It holds a stand-in `claude` (`fake-claude.mjs`) and a stand-in `codex`
(`fake-codex.mjs`) that speak the real tools' JSON lines, so the real bridge runs on top of them. They check a sign-in file the way the pod does (an access token that
starts `fake-`), call the run's MCP address for real (`initialize`, `tools/list`, and one `tools/call` when asked) and never read the operator's own `~/.claude` or
`~/.codex`. Words steer them, in the prompt or in the file `/state/fake-mode` (override: `FAKE_MODE_FILE`):

| Word | The stand-in |
|---|---|
| `FAKE401` | answers as if the sign-in was refused (the bridge marks the runner `needs_sign_in`) |
| `FAKELIMIT` | answers as if the plan's limit was reached, with a reset an hour away (the runner is `paused`) |
| `FAKEREFRESH` | renews the sign-in file: new access token and expiry, every other byte unchanged, written to a temp file and renamed. The Codex one takes 500 ms to do it, so a second process that starts meanwhile meets `refresh_token_reused`, the two-processes hazard the gate exists to prevent |
| `FAKECALL <tool> [{json}]` | one MCP `tools/call` of that tool, shown as a tool use and its result |

The wording of the refusals is a guess until the real tools are measured. `tools/agent-bridge/test/fake-cli.test.ts` runs both stand-ins under the real bridge against
a local MCP stand-in and a made-up home folder; it also proves a changed `BOT.md` reaches the next run (see [agent-bridge](../agent-bridge.md#a-fresh-process-per-run)).
The stand-in image is for the **stage** (`claudePod.enabled=true, useFake=true`, its own pods namespace), never for a runner made on the live site.

**Test seam for the bridge address (P19-12).** A stack has no pod and no cluster DNS, so the Claude and Codex runners could never be reached in a browser test. When the server runs
with `NODE_ENV=test` and both `MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL` and `MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY` are set, the bridge address the resolver hands to the run is that
stand-in (a server that speaks the bridge's wire, such as `tools/fake-hermes-gateway`) and not the pod's Service. With any other `NODE_ENV`, or only one of the two set, nothing
changes; a real install sets neither. `e2e/runners/placement.spec.ts` uses it so a team lead's bot on each runner kind gets an answer; `packages/plugins/claude-pods/test/bridge-seam.test.ts`
proves the three cases (both set under test, one set, not under test).

**Seed v19** (`packages/test-utils/src/seed-runners.ts`, stack mode `runners`, opt-in) makes five runners through the real routes: a host Hermes gateway, the team pod, a
Claude runner shared by Engineering and Marketing, a Claude runner for Customer support with a different made-up login, and an LLM gateway runner on the alias `fast`,
with one bot placed on each by a proposal that changes its `BOT.md`; it also makes a Codex runner waiting for a sign-in when this build allows it. Sign-in files are
made-up shapes with a canary string. A second run changes nothing. The `runners` stack also starts the Kubernetes stand-in the server talks to.

## Limits of this version
Repositories sync over public https only. The number of runs at once is set when the runner is made (1 to 4, default 2); there is no edit yet.
Each Claude runner needs its own sign-in file. The check on a saved file reads the file's shape and the bridge's remembered failure; it does not ask Claude
(a real probe waits for the owner's measured texts). The words that tell a refused sign-in or the plan's limit from other errors are one table
(`FAILURE_PATTERNS` in `tools/agent-bridge/src/signin.ts`); they hold the stand-in's words and a guess at the real ones, and are changed by one line when the
real texts are known. For a runner with no uploaded file the controller reads the bridge's sign-in state (`GET /v1/auth/status`) on every pass; for an uploaded file the status
moves on upload, on the check route and when a run is refused. The site-side field that lets a run ask for Codex full access (`manythreads.fullAccess` in the run request) is
the runtime's to send; a pod does not need it, because the controller writes the profile's key.

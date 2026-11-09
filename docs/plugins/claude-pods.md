# claude-pods

The **claude-pods** plugin runs each Claude Code runner as its own pod in the cluster. A Claude Code runner is a row of the `bot-runners` plugin with
kind `claude_cli`; the plugin keeps one pod per runner, signed in with that runner's own sign-in file. This page is for an operator.

## Turning it on
- Chart: set `claudePod.enabled: true` (it needs `hermesPods.enabled: true`: same namespace, same Role; the permissions it adds are listed under "Every permission the runners add"). It is off by default.
- `tools/devbox/deploy.sh` builds the image only when `claudePod.enabled: true` is in `values-live.yaml`. `claudePod.fake: true` builds the stand-in image
  (`deploy/images/claude-pod-fake`), which answers like Claude without a sign-in; use it to check the plumbing.
- The server reads `MANYTHREADS_CLAUDE_PODS=1` and `MANYTHREADS_CLAUDE_PODS_*` (namespace, image, storage class, sizes, resources, model aliases).
  Without the first, the plugin does nothing and the runner list says `claudePodsAvailable: false`.

## What it creates, per runner
Names carry the runner's short name. A Deployment (one replica, or zero while the runner is off, has no bots, has no sign-in file, or is moving), a Service
on port 8650, a ConfigMap (bridge config and `repos.txt`), a Secret with the bridge key, and two claims: `state` (the CLI's home, 256Mi) and `work` (10Gi).
The init step copies the Secret `claude-<runner>-credentials` into the state volume when the volume has no file yet, or when the Secret's `upload-id` differs from the one the volume last took (a replaced upload). The pod runs as uid 1000, read-only
root, no service-account token, tini as PID 1. Probes are TCP (the bridge's `/health` needs the key).
The NetworkPolicy lets only the server in (port 8650) and lets out DNS, the server, and public 443 when `egress.mode=public443`.

**The publisher container (P19-09).** With `claudePod.publisher.enabled` (the default; the server gets `MANYTHREADS_CLAUDE_PODS_PUBLISHER` and
`MANYTHREADS_CLAUDE_PODS_PUBLISHER_RESOURCES` from it) the pod has a third container next to the run and the keeper: the same image started as
`publisher.mjs serve`, uid 1001, read-only root, no Kubernetes token. It is how a bot gets a branch pushed and a pull request opened without ever holding the push token
(the run container mounts no push Secret). The run calls `mt-publish check|publish <project> <card> <commit> <title>`; that small command only talks to the publisher over a
Unix socket in a shared `emptyDir`. The publisher takes the run's own MCP token from the request, asks the server `GET /api/runs/self`, and gets back the team, the bot, the run
and `mayPublish` (the bot's definition grants `tasks.pull_request`). It publishes only the folder `/work/<team>/<bot>/<project>` the server's answer names, with that team's
token, through the same script the Hermes pods use (`deploy/images/workbench/mt-publish.sh`: same branch rule, same exit codes). It needs the server (port 3000, inside the cluster)
and, to reach the git host, public 443; both are in the pod's one NetworkPolicy. With `egress.mode=serverOnly` it can only answer "refused".

**The pod rolls when the bots change.** The pod template carries the annotation `manythreads.io/profiles-sha`, a hash of the bridge's profiles (each bot's folder, model, allowed
tools including `mt-publish`, instructions, and the runs-at-once limit). A change to a bot's placement or grants (for instance `tasks.pull_request` added or removed), or a bot added to or
removed from the runner, changes the hash and **rolls the pod: a run in flight ends** and the next one starts on the new pod. (The bridge reads its profiles from a ConfigMap, so without the
annotation an old pod would keep the old list for about a minute.) A team added to or removed from the runner changes the pod's volumes and rolls it too.

## Moves
The node choice works as for Hermes pods: set a node on the runner, the controller applies it. A work volume is deleted only in an admin-confirmed move;
the confirmation `<node>@<epoch ms>` is valid 15 minutes. A move without it is shown as `waiting_for_node` and nothing is deleted.

## The sign-in (P19-06)
The admin uploads the `.credentials.json` of a Claude login on the Runners page. The bytes are stored exactly as sent in the Secret `claude-<runner>-credentials`
(keys `.credentials.json` and `upload-id`) and nowhere else: the database holds the plan label, the expiry, a SHA-256 of the file and a keyed hash of the login
(to refuse the same login on a second runner); no event, audit row, log or answer holds the file. The upload id is also an annotation on the pod template, so a
replaced file rolls the pod. Removing the sign-in deletes the Secret and the runner goes back to `waiting_for_sign_in`.

The controller never applies the credentials Secret again, so what the keeper writes back survives a reconcile.

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
| ServiceAccount `claude-<runner>-keeper`, its Role and RoleBinding (one set per runner; `codex-<runner>-keeper` for a Codex runner) | the keeper container only | `get` and `patch` on the one Secret that holds that runner's sign-in file, by name. The token is projected into the keeper container only |
| NetworkPolicy `manythreads-claude-pods` | the run, keeper and publisher containers (one policy for the pod) | in: the server on port 8650. Out: DNS, the server on its port (the MCP address, the API and `GET /api/runs/self`), and (below) public 443 |

**Mounts of a runner's pod.** The run container: `state` (the tool's home, with the sign-in file; 256Mi) and `work` (the team repositories; 10Gi), a read-only root
file system, uid 1000, no Kubernetes token (`automountServiceAccountToken: false`). The init step reads the sign-in Secret to fill `state`. The keeper container: `state`
read-only and its own projected token. When `claudePod.publisher.enabled` is on, the pod gets a third container, the publisher (P19-09): it is the only container that mounts a team's
push Secret (read-only), and it mounts `work` read-only. The run container mounts no push Secret; it reaches the publisher only through a socket in one shared `emptyDir`. No container of the pod gets a host path, a privileged setting or the Docker socket.

**Push Secrets.** Each team on the runner's list has a Secret `hermes-<team>-push` (made by the Hermes pods' controller, one key per project, the same Secret the Hermes pod
reads). The publisher mounts it read-only at `/etc/publisher-push/<team>` (mode 0444 so uid 1001 can read it; optional: it exists only once a lead has saved a token for a project of the
team). The publisher keeps a private copy of one token file per request in a memory-backed `/tmp` and removes it at the end. No other container of the pod mounts these Secrets.

**Commands a bot may run without a question.** The bridge's profile for each bot carries a fixed list (decision E5, `render.ts`); the bot's definition has no field for it, so the
grant list is the permission.
- Every bot: `Bash(git status)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git add:*)`, `Bash(git commit:*)`, `Bash(git switch:*)`, `Bash(git checkout -b:*)`. Enough to look, and to commit on a branch of its own; nothing that reaches the network (no push, fetch or clone) or rewrites history.
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

**Seed v19** (`packages/test-utils/src/seed-runners.ts`, stack mode `runners`, opt-in) makes five runners through the real routes: a host Hermes gateway, the team pod, a
Claude runner shared by Engineering and Marketing, a Claude runner for Customer support with a different made-up login, and an LLM gateway runner on the alias `fast`,
with one bot placed on each by a proposal that changes its `BOT.md`; it also makes a Codex runner waiting for a sign-in when this build allows it. Sign-in files are
made-up shapes with a canary string. A second run changes nothing. The `runners` stack also starts the Kubernetes stand-in the server talks to.

## Limits of this version
Repositories sync over public https only. The number of runs at once is set when the runner is made (1 to 4, default 2); there is no edit yet.
Each Claude runner needs its own sign-in file. The check on a saved file reads the file's shape and the bridge's remembered failure; it does not ask Claude
(a real probe waits for the owner's measured texts). The words that tell a refused sign-in or the plan's limit from other errors are one table
(`FAILURE_PATTERNS` in `tools/agent-bridge/src/signin.ts`); they hold the stand-in's words and a guess at the real ones, and are changed by one line when the
real texts are known. The controller does not yet read the bridge's `/health` sign-in state to set the runner's status; the status moves on upload, on the
check route and when a run is refused.

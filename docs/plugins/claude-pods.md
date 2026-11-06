# claude-pods

The **claude-pods** plugin runs each Claude Code runner as its own pod in the cluster. A Claude Code runner is a row of the `bot-runners` plugin with
kind `claude_cli`; the plugin keeps one pod per runner, signed in with that runner's own sign-in file. This page is for an operator.

## Turning it on
- Chart: set `claudePod.enabled: true` (it needs `hermesPods.enabled: true`: same namespace, same Role; no new permission is added). It is off by default.
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

## Limits of this version
Repositories sync over public https only. The number of runs at once is set when the runner is made (1 to 4, default 2); there is no edit yet.
Each Claude runner needs its own sign-in file. The check on a saved file reads the file's shape and the bridge's remembered failure; it does not ask Claude
(a real probe waits for the owner's measured texts). The words that tell a refused sign-in or the plan's limit from other errors are one table
(`FAILURE_PATTERNS` in `tools/agent-bridge/src/signin.ts`); they hold the stand-in's words and a guess at the real ones, and are changed by one line when the
real texts are known. The controller does not yet read the bridge's `/health` sign-in state to set the runner's status; the status moves on upload, on the
check route and when a run is refused.

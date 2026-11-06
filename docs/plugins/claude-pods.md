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
The init step copies the Secret `claude-<runner>-credentials` into the state volume only when no file is there yet. The pod runs as uid 1000, read-only
root, no service-account token, tini as PID 1. Probes are TCP (the bridge's `/health` needs the key).
The NetworkPolicy lets only the server in (port 8650) and lets out DNS, the server, and public 443 when `egress.mode=public443`.

## Moves
The node choice works as for Hermes pods: set a node on the runner, the controller applies it. A work volume is deleted only in an admin-confirmed move;
the confirmation `<node>@<epoch ms>` is valid 15 minutes. A move without it is shown as `waiting_for_node` and nothing is deleted.

## Limits of this version
Repositories sync over public https only. The number of runs at once is set when the runner is made (1 to 4, default 2); there is no edit yet.
The sign-in upload, the keeper that renews it, the gate and the use in `resolveRunner` come with the next packages (WP-H). Each Claude runner needs its own sign-in file.

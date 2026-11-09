# Bundle E: what the cluster permissions change on the live site

For the owner to read before the Bundle E chart goes live. One row per change: what it is, why it is there, and how to roll it back. Checked against
`helm template` of `values-live.yaml` at commit 84d5109b (the last push before the bundle) and after it, and against the live cluster (read-only `kubectl get`, 2026-11-09).

Words: the **release namespace** is `manythreads` (server, web, database, LiteLLM, Hindsight). The **pods namespace** is `manythreads-bots` (the teams' Hermes pods,
and the Claude Code and Codex runner pods). The **server account** is the ServiceAccount `manythreads-server` that the server pod runs as.

## A. What changes on the next deploy (claudePod stays off, as values-live.yaml has it today)

Bundle E adds **no new Role, ClusterRole or binding** to live with today's values. It adds four network policies.

| What | Why | Roll back |
| --- | --- | --- |
| NetworkPolicy `manythreads-postgres` (release namespace): the database pods take connections on 5432 only from the server, the seed Job, the backup CronJob, the restore tool, Hindsight and LiteLLM; the database pods among themselves; the database operator's namespace (`cnpg-system`) on every port | Until now every pod in the release namespace could open the database | `networkPolicies.release.enabled: false` in values-live.yaml, deploy (removes all three release policies) |
| NetworkPolicy `manythreads-hindsight`: Hindsight (8888) answers the server only | The same: team memory was open to every pod of the release | The same switch |
| NetworkPolicy `manythreads-litellm`: LiteLLM (4000) answers the server, Hindsight, and the pods namespace | The same: the model gateway was open to every pod of the release | The same switch |
| NetworkPolicy `manythreads-hermes-pods-internet` (pods namespace): the Hermes pods' "public internet on 80/443" rule moves out of `manythreads-hermes-pods` into its own policy, which skips a pod labelled `manythreads.io/egress=proxy` | A team whose egress rule names a proxy may reach only that proxy (one policy per team from `hermesPods.teamProxies`). A pod without the label keeps exactly the reach it had | Remove the team's proxy in Settings > Workspace > Data protection (the controller drops the label), or revert `templates/hermes-pods.yaml` |
| The server pod gets `MANYTHREADS_HERMES_PODS_RUNTIME_CLASS_NAME` and `MANYTHREADS_CLAUDE_PODS_RUNTIME_CLASS_NAME` | gVisor for the bots' pods where the cluster has it (decision E22). Both are empty on live (the cluster has no `gvisor` RuntimeClass today), so nothing changes | Leave `runtimeClassName` empty |

Not changed by the bundle but already on live (from P19-08, before it), listed so the whole picture is in one place:

| What | Why | Roll back |
| --- | --- | --- |
| ClusterRole `manythreads-manythreads-nodes-reader`: `get` and `list` on `nodes`, bound to the server account. The only cluster-wide right | The machine picker on the Runners page lists the machines | `hermesPods.enabled: false` (removes the Hermes pods with it) |
| Role `manythreads-hermes-pods-controller` (pods namespace): `delete` on Secrets and on volume claims, next to get/list/create/patch/update on Deployments, Services, Secrets, ConfigMaps and volume claims | A removed project token deletes its Secret; a confirmed machine move deletes a pod's two volumes; **Remove sign-in** deletes a runner's state volume. Kubernetes cannot limit `delete` to names made at run time, so the limit to "the runner's own state volume, by name" is in the code (`claude-pods/src/index.ts removeCredentials`, `reconcile.ts finishMove`), not in the Role | Revert the rule in `templates/hermes-pods.yaml`; a move and Remove sign-in then fail with a plain message |

## B. What turning the Claude Code and Codex runners on adds (`claudePod.enabled: true`, step 4 of runners-live.md)

| What | Why | Roll back |
| --- | --- | --- |
| Role `manythreads-claude-pods-controller` (pods namespace), bound to the server account: `get`, `list`, `create`, `patch`, `update` on ServiceAccounts, Roles and RoleBindings. No `delete`, nothing cluster-wide, nothing in the release namespace | The controller makes each runner's keeper account (below). **Know this:** with it the server account can bind any right it already holds in the pods namespace (for example reading Secrets there) to any ServiceAccount of that namespace. Kubernetes refuses a Role wider than the server's own rights, so it is not a way out of the namespace; it matters only if the server itself is taken over, which already holds those rights | `claudePod.enabled: false`, deploy. Left-over keeper accounts and Roles stay (the controller cannot delete them); remove them by hand with `kubectl -n manythreads-bots delete sa,role,rolebinding -l app.kubernetes.io/managed-by=manythreads-claude-pods` |
| Per runner: ServiceAccount `claude-<runner>-keeper` (or `codex-`), a Role with `get` and `patch` on the one Secret `<base>-credentials` by name, and its RoleBinding. The token is projected into the keeper container only and expires after one hour; the pod itself mounts none | The keeper copies a renewed login back into its Secret, so a restarted pod does not start from a dead refresh token | Delete the runner on the Runners page, then the three objects as above |
| NetworkPolicy `manythreads-claude-pods`: in only from the server on 8650; out DNS, the server on its port, the Kubernetes API at its node address and port (`hermesPods.apiServer`, 10.0.2.15:6443), and public 443 outside private, link-local and CGNAT ranges | The run talks to the server's MCP address; the publisher asks `GET /api/runs/self` and reaches GitHub; the keeper patches its Secret through the API. The API rule reaches every container of the pod (a policy cannot tell containers apart), but only the keeper holds a token: from the run container the API answers a refusal | `claudePod.enabled: false`; or `claudePod.egress.mode: serverOnly` to drop public 443 (the publisher then cannot reach GitHub) |
| The controller (through the existing Hermes Role) creates per runner the Secrets `<base>-key` (the bridge key) and `<base>-credentials` (the sign-in file, written by the upload route), the volume claims `<base>-state` and `<base>-work`, a ConfigMap, a Service and a Deployment; it deletes `<base>-state` and `<base>-credentials` on **Remove sign-in** | One pod per runner | Remove sign-in, then delete the runner |
| The **publisher** container of each runner pod mounts, read-only, the push Secret `hermes-<team>-push` of **every team on that runner's list** (kubelet volume, no new Role) | It is the one container that pushes a bot's branch and opens the pull request; the run container mounts no token. On a runner shared by several teams, all their push tokens are in that one container; which token is used is decided by the platform's answer to the run's own token | `claudePod.publisher.enabled: false` (no publisher, no push Secret in the pod; bots then cannot open a pull request from a Claude or Codex runner) |
| LiteLLM takes calls on 4000 from the pods namespace (the release policy in part A) | The pods' model calls | The release switch in part A |

## C. What the owner accepts by turning B on (not a permission, but the same decision)

- Bots of different teams on one shared runner run as the same user in the same container. A bot that can run a shell can read another team's run's environment (its run token)
  and the runner's sign-in file. "One runner per team" is the wall (PLAN phase 19, decision 9). See the review note on the git commands in REVIEW-E: today every Claude bot
  is allowed `git diff:*` and friends, which can read files outside its folder, so "a bot without the shell grant" is not yet a wall either.
- k3s Secrets encryption is off until `tools/devbox/secrets-encrypt.sh enable --yes-i-am-the-owner` is run: the sign-in Secrets sit unencrypted in the datastore until then.

# Plugin database security

## What plugins can and cannot do

- Plugins never get a pool. They receive a `PluginTx`: queries inside one actor transaction, nothing else.
- The **system** identity is a Postgres role (`manythreads_system`). `app.is_system()` is true only for connections that log in
  as that role, which only kernel code (`withSystem`, workers, outbox consumers) holds. A plugin transaction runs as
  `manythreads_app`; it cannot `SET ROLE manythreads_system`, and the `app.actor_kind` setting grants nothing.
- Plugin tables are created by the plugin's own migrations with RLS, as for kernel tables. Grant `manythreads_app` what it needs;
  `manythreads_system` gets the standard privileges on every table in schema `app` automatically.
- To write system-only kernel tables from a plugin transaction, use the kernel API (`emit`, `enqueue`), which call narrow
  SECURITY DEFINER functions (`app.enqueue_outbox`, `app.enqueue_job`).

## Known gap: person/bot identity is still a setting

`app.actor()`, `app.workspace_id()` and `app.run_id()` read session settings that `withActor` sets. Code that can run
arbitrary SQL in the transaction can change them with `set_config` and act as another person or bot. In-process kernel code
is trusted; plugin code is not.

## Stopgap: statement filter (not a sandbox)

`@manythreads/sdk` exports `guardPluginTx(tx)` and `assertSafePluginSql(text)`. The plugin context wraps every `tx` it hands to
plugin handlers (event subscribers, hooks, commands, HTTP routes, capability handlers, `emit`). A statement is rejected with
`ForbiddenPluginSqlError` when, after removing `--` and `/* */` comments and ignoring case, it contains:

- `set_config(...)` anywhere;
- a statement starting with `SET`, `RESET`, `DO` or `EXECUTE` (including after a `;`), `SET ROLE`, `SET SESSION AUTHORIZATION`;
- `ALTER ROLE|USER|DATABASE|SYSTEM`;
- a statement starting with `COMMIT`, `END`, `ABORT`, `BEGIN`, `START TRANSACTION`, `PREPARE TRANSACTION` or a plain `ROLLBACK` (ending or restarting the transaction the
  server opened, which would also end a READ ONLY one); `SAVEPOINT`, `RELEASE SAVEPOINT` and `ROLLBACK TO SAVEPOINT` stay allowed.

This stops the obvious spoofing paths and is easy to bypass (for example through a function that calls `set_config`
internally). The durable fix is a dedicated plugin database role with a signed, non-settable identity; until then treat
installed plugins as trusted code.

## Sign-in plugins: `provider.identity`

Sign-in happens before anybody is known, so it cannot run as a person. A plugin whose manifest lists `provider.identity` in
`extends` gets `ctx.identity` (every other plugin throws when it touches it):

- `runAsSystem(fn)` runs one transaction as the real `manythreads_system` role. **RLS does not apply**; the handler must scope
  every query itself (by the caller's person id, by a token hash, by an email). Treat each query like a privileged API.
- `sessions.issue / list / revoke / revokeAll` write the session tables, which only the system role can. `revoke` and `list`
  take the person id: always pass the caller's, never one from the request.
- `ensureActor`, `hashPassword` / `verifyPassword` (argon2id), and `onStart(task)` for a one-off task at server start (the
  first-admin link).

A route returns `setSession` (the `issue` result) or `clearSession`; the server turns that into the `__Host-manythreads_session`
(HttpOnly, SameSite=Lax, Secure) and readable `__Host-manythreads_csrf` cookies (plain `manythreads_session` /
`manythreads_csrf` only when cookies are not Secure, i.e. local http). The `__Host-` prefix means the browser then refuses to store them from any subdomain or with a `Domain=` attribute. That
matters because apps that bots deploy are served from subdomains of the platform host (`<app>.<team>.apps.<host>`), and
without the prefix such a page could plant a same-named cookie for the whole host ("cookie tossing": sign people out, pin a
session id, shadow the CSRF cookie). The prefix needs Secure, so plain http (local dev and tests) keeps the plain names.
The CSRF check reads the CSRF cookie that belongs to the session cookie in use.

There is no migration grace: a Secure server never reads the old plain-named cookies (a subdomain could have planted
them), so the rename signed everyone out once. Every sign-in and sign-out still expires any old host-only plain pair.
The token is opaque random bytes;
only its sha256 is stored (`app.session_tokens`, with the UNLOGGED `app.session_cache` in front for the hot lookup). Never log,
return in a body, or store a session token or a CSRF token.

## Model providers: `provider.llm`, and `ctx.secrets`

`ctx.secrets` is the same envelope-encrypted store sign-in uses, and it has two doors because two trust domains need it: a
plugin that extends `provider.identity` (sign-in client secrets) and one that extends `provider.llm` (model provider API keys,
PLAN P5-06). Everything else throws on `ctx.secrets`. `put` runs in the caller's transaction (a workspace admin's or the
system actor's; the database refuses anyone else) and `get` is system-only, so a plugin that stores a key hands it back
through `provider.llm` at call time, never through a route. A route never returns a secret; it answers only whether one is
stored.

## The runner catalog: `provider.bot.runners`

`bot-runners` (PLAN P19-02) holds the places bots run and offers one provider, `bot.runners`, whose only call is `resolveRunner({ teamId, runner })`: it answers where a run goes (address, key, agent, whether the outbound guard applies) or a plain refusal. It is the one door through which an address or a key leaves the catalog, and only `runtime-hermes` asks. It needs `secret.seal` to store a gateway's key; the key is read back in a system transaction, never in a route. A team member reads runners only through `app.bot_runners_for_team`, which returns name, label, kind, state, default, owner name and plan label. Plugins are trusted code that runs inside the server process, so the provider call is not hardened against a hostile plugin: anything that can register a `bot.runners` provider or hold `secret.seal` is reviewed like a migration. See [bot-runners](./bot-runners.md).

## The one cluster-wide permission: `nodes` (read only)

Phase 19 (P19-08) adds one right in the Kubernetes cluster that is not inside the pods' namespace: the server's ServiceAccount (`manythreads-server`) may **`get` and `list` the cluster's machines** (the Kubernetes resource `nodes`). It is a `ClusterRole` and `ClusterRoleBinding` named `<release>-manythreads-nodes-reader` in `deploy/helm/manythreads/templates/hermes-pods.yaml`, made only when `hermesPods.enabled` is on. It is there so an admin can pick the machine a team Hermes pod runs on (the picker needs each machine's name, whether it is Ready, its size and its CPU architecture).

* **What it can do:** read the machines' names, labels, conditions and sizes. A node object also lists the machine's addresses and the images stored on it; this is information about the cluster that the server's own admins already hold, and the server passes none of it on: the admin API answers a fixed set of fields.
* **What it cannot do:** `create`, `update`, `patch`, `delete`, `watch`, read any other resource (no pods outside its Role, no secrets), or reach `pods/exec`. A chart test (`packages/plugins/hermes-pods/test/clusterrole.test.ts`, which renders the chart with `helm template`) fails if the role gains any verb beyond `get` and `list`, any resource beyond `nodes`, `resourceNames` or non-resource URLs, or a subject other than the server's ServiceAccount.
* **Why not more:** the "free CPU and memory" the plan mentions would need a cluster-wide read of every pod, which is a bigger right. The page shows what a machine *offers* (its allocatable amount) instead.
* **Also new, and namespaced:** the controller's Role in the pods namespace gained `delete` on `persistentvolumeclaims`, used only to recreate a team's volumes in a machine move ([hermes-pods](./hermes-pods.md#choosing-the-machine-p19-08)). It is a loss of data by design, confirmed on the page first; the controller deletes the two claims of a team only when an admin confirmed that move (a mark on the claims, for that machine, written by the admin's own request and valid for 15 minutes), the machine is an existing, Ready node on the operator's list, the claims carry the team's id label, and no pod of the team is left. Any other change of the machine worked out for a team (a different default runner, a runner switched on or off, a Teams edit) deletes nothing: the pod stays where its volumes are and the page asks for the confirmation. The mark is written with `patch` on the claims, which the Role already had.
* **Who may use it:** the routes are workspace-admin only. Anyone else gets `403`. The operator can narrow the list further with `botRunners.allowedNodes`.

An owner who does not want the cluster-wide read sets `hermesPods.enabled` off (no controller, no pods) or removes the template block: the machine picker then says "This install has no cluster to list machines from" and nothing else in the platform changes.

## The release namespace's network policies (P10-08)

Until now only the bots and apps namespaces had network policies; the release namespace (server, web, database, LiteLLM, Hindsight) was open. With `networkPolicies.release.enabled` (on by default) the chart adds
ingress policies there (`templates/netpol-release.yaml`; k3s enforces them):

* `manythreads-postgres` (CloudNativePG installs only): the database accepts port 5432 only from the release namespace's own server, seed, backup, restore helper (`backup-tool`), Hindsight and LiteLLM pods; the database pods talk to each other freely; the CloudNativePG operator (and the backup plug-in) reaches it from its namespace (`networkPolicies.release.operatorNamespace`, default `cnpg-system`).
* `manythreads-hindsight`: Hindsight is reached from the server only. `manythreads-litellm`: LiteLLM is reached from the server, Hindsight and (when the pods controller is on) the bots namespace's pods.
* `manythreads-server` is **off** by default (`networkPolicies.release.server.enabled`): it would close the server to everything but the release namespace, the bots namespace, the ingress controller and `networkPolicies.release.server.extraCidrs`, and the paths from host-network tools are not checked on every install. Turn it on after trying it on a stage.

Policies only add ingress rules and a pod no policy selects stays open, so the effect is limited to the pods named above. **Accepted permission:** the chart now creates NetworkPolicy objects in the release namespace, and a wrong rule can cut a path (the plan's list: operator, backup, seed, Hindsight to database, server to LiteLLM, pods to the MCP address; a chart test evaluates all of them). **Rollback:** `networkPolicies.release.enabled=false` and upgrade; the policies disappear and everything is open as before. The Hermes pods' internet rule moved into `manythreads-hermes-pods-internet`; a live upgrade changes the old policy and creates the new one in the same release, so there can be a moment of a second without internet for those pods.

## The janitor's door: `run.close`

A plugin that extends `run.close` and not `tool.invoke` gets a `ctx.runs` of which one member works: `close(runId, status)` — end a run through the run service (which revokes its tokens and emits `bots.run.closed`). Every other member (`open`, `asBot`, `asReader`, `asApproved`, `authorize`, `may`, `invoke`, `logSource`, `inheritSources`) throws, naming `tool.invoke`. It exists so the bots plugin's stale-run reaper can end a run whose worker died without being handed the whole run door. A plugin with both gets the full door.

**An ended run takes nothing more.** The run service checks, on every door that acts for a run (`asBot`, `asReader`, `asApproved`, `authorize`, `may`), that the run is still `running`: a worker that still holds the handle of a run that was ended (by the reaper, by an approval's re-run, by its own client) gets `RunEndedError` (a denied decision from `authorize` / `may`). Closing a run is therefore final for every call that starts after it: none appends to its source log or acts for it. A call that had already passed the check when the run was closed (a read in flight) can still land its line, so the log is settled shortly after the close rather than at the instant of it; what the memory rule reads, and what an approval's re-run inherits, is read after the run has ended, never while it is open.

## The message path: `provider.messages`

The channels plugin registers the one path a channel message is written on (`ctx.providers.get<MessageProvider>('messages')`, extension point
`provider.messages`). It is for plugin code only: a plugin that finishes a bot's reply with more than text (the answer plugin's Answer) posts
through it, with a `meta` the provider validates. It is deliberately **not** a capability: a capability is what a bot's model can be granted
and call with arguments of its own, and a payload the platform vouches for (whom an answer was for, which sources it rests on) must not be
something a model can write. `messages.post` takes no `meta`. Using the provider needs no `extends` entry; the posting still runs as the
transaction's actor under the channel's own `post` rule.

## The bot tools digest: `provider.mcp.tools`

`gateway-mcp` registers `ctx.providers.get<McpToolsProvider>('mcp.tools')` (extension point `provider.mcp.tools`): `toolsDigest(botId)` answers the SHA-256 of exactly what `tools/list` offers that bot
(names, descriptions, input schemas, destructive flag, `needsApproval`), or `null` for a bot it does not know. It carries no tool, no grant and no token, only the hash, and it is read-only; `runtime-hermes` writes it into the
managed pod's `config.yaml` so a changed tool list re-serves the profile. The table behind it, `app.mcp_bot_tools`, is reachable by the system role only. The bot's tools stream (`GET` on the bot endpoint) is opened
only with the bot's own token, is capped (4 per bot, 2,000 in all, each per process; 429 over that), drops a reader that falls behind, ends within about ten seconds of a revoked or rotated token, and never writes a token, id or counter in a frame.

## The role groups: `provider.role.groups`

The teams plugin registers `ctx.providers.get<RoleGroupProvider>('role.groups')` (extension point `provider.role.groups`): `list(tx, teamId, { handles? })` answers a team's role tags with the people who hold them,
as the transaction's actor. It reads through the roster door (`app.teams_roster`), which answers nothing to a caller who may not read the team, so a plugin cannot use the provider to learn a team's
membership; the callers narrow it further (channels to the people who can read the channel, with `app.channel_role_audience`, which refuses a guest). It is read-only and takes no `extends` to use.

Abuse limits of a group mention (channels): at most 500 people notified per group per message, and per author and team 5 group mentions a minute and 1,000 people an hour, in process memory (`mention-budget.ts`); over the budget the
post is refused with a 429 and nothing is written. The first-name rule and the reserved words (`role-handles.ts`) keep a person from taking a team's tag by joining with a name, and keep tags such as `admin` or `security` from looking like an
authority. `mention-groups` is rate limited (120 a minute) and answers only for a channel the caller can read. `ctx.audit.emitMany` is the batch form of `ctx.audit.emit` (the same event checks for each event, then three statements
whatever their number).

## Who has been away: `provider.presence`

The presence plugin registers `ctx.providers.get<PresenceProvider>('presence')` (extension point `provider.presence`): `lastSeen(tx, personIds)` answers when each person's latest heartbeat arrived (`seenSince` lists the people of a workspace seen after a time, `warmSince` when the heartbeat data started), as the transaction's actor
(the table's own row rules apply). It answers a time and nothing else: no tab, device or status text. The notifications plugin uses it to decide who has been away for the email digest, so it never reads the presence table
itself. It is read-only and takes no `extends` to use.

## The token checker's door: `run.resolve`

A plugin that extends `run.resolve` (and not `tool.invoke`) gets a `ctx.runs` of which one member works: `resolve(sha256)`, which turns a presented run token into the run it opens (or null for an unknown, revoked, expired or finished one). Every other member throws, naming `tool.invoke`. It exists for an endpoint that takes a run's token as its credential without acting for the run: `gateway-llm`'s run-scoped model proxy (`/api/llm/runs/<runId>/v1`, [runners.md](./runners.md)) authenticates an agent on a runner this way, then calls the model with the bot's own key as the system. It cannot open a run, enter a transaction as the bot, or call a tool.

## The call-only door: `capability.call`

A plugin that extends `capability.call` (and not `tool.invoke`) gets a `ctx.runs` of which two members work: `invoke(tx, capability, input)` and `catalog()`. `invoke` calls a capability handler another plugin registered **in the transaction the caller already holds** (so the actor, and the row-level rules with it, are the caller's own), and `catalog()` lists which capabilities have implementations. Every other member (open a run, `asBot`, `asReader`, `authorize`, `asApproved`, ...) throws, naming `tool.invoke`. It adds no actor and no right: a capability still checks its own rules for the actor of that transaction. It exists for a plugin that must use the platform's own tools as the person who is acting, with no bot involved: `workshop`'s "Add a bot" helper calls `knowledge.search` and `proposals.propose` this way ([workshop.md](./workshop.md)). The manifest must also name the capabilities it may call, `calls: [...]` (workshop: `knowledge.search`, `proposals.propose`); `invoke` throws for any other name, even one that exists, and a manifest with `capability.call` and no `calls` (or `calls` without the door) does not load. The door cannot be combined with `run.close`, `run.resolve` or `tool.invoke`: a plugin with this door must not also be able to end runs or act as a bot. Why not `tool.invoke`: that door lets a plugin act as any run's bot, which the helper never needs and a reviewer would have to rule out.

## The MCP gateway's door: `tool.invoke`

A plugin that extends `tool.invoke` (`ctx.runs`, the MCP gateway of PLAN P5-09) may, in the platform's name:

- **open a run** — write a `bot_runs` row and mint a credential for it as the system actor, and close it again. The bot
  and its team are read from the database, and an asker must be a person actor of the same workspace who is on the run's
  team, so a caller cannot start a run for another team's bot or name an asker who is not there. The **public** mint
  (`POST /api/mcp/runs`, a pairing token) names no asker and no trigger at all — a pairing token proves a bot's runtime, not
  a person's request — so only in-process callers (the router) can open a conversation or mention run;
- **enter one transaction as the run's bot** (`asBot`) or **as the person who asked** (`asReader`), with `app.run_id` set.
  These are real role-scoped transactions on the app pool: row level security, the recorded actor and `app.run_id()` all
  see a bot (or a person) they can be held to, and a write made this way is attributed exactly like any other;
- **ask the broker about the run's bot** (`authorize`, and the non-auditing `may` for listings) — so a grant is checked
  against the bot the run belongs to, not against whoever the transaction happens to be;
- **call a capability handler another plugin registered** (`invoke`) in that transaction, and **list** which capabilities
  have implementations at all;
- **make the one call a person approved** (`asApproved(run, capability, fn)`, P5-20): `asBot` whose actor carries
  `approvedCapability`, so the broker does not answer `needsApproval` again for exactly that capability in that transaction. Every
  other check — the grant, the path guard, the destructive tag — still applies; the property lives on the in-memory actor, not in a
  setting SQL can change. It is a door of its own: a plugin needs the manifest extension `approval.resume` besides `tool.invoke`, and only the
  approvals plugin declares it, so `tool.invoke` alone cannot waive an approval. The approvals plugin calls it only after claiming an approved row.

Why it is one door and not four: a tool call has to be `bot capabilities ∩ asker visibility`, and that sentence only
holds if the capability check and the row visibility can come from different actors inside one call. It is trusted-code
territory, like `provider.identity` and `job.register`: a plugin holding it can act as any run's bot (today: `gateway-mcp`, `runtime-hermes` and `approvals`), so a reviewer reads
its routes the way they read a migration. The gateway itself never takes the bot, the team or the asker from the request —
it resolves them from the run token the database handed out.

## Plugin sockets: origin, session and guard

A plugin socket is a route declared with `ws: true`. Before this was written, such a socket was checked only by the cookie session at the moment of the upgrade. Three checks now hold for **every** plugin socket, in the server (`mountPluginRoutes` in `packages/server/src/build-server.ts`), whatever the plugin does:

* **Origin.** A browser always sends the page's `Origin`. If it is present and its host is not the request's `Host`, the upgrade is refused with `403` ("Origin not allowed") before anything runs. This closes cross-site WebSocket hijacking (a page on another site opening the socket with the visitor's cookie). The web proxy must keep the `Host` header (the shipped nginx does: `proxy_set_header Host $host`). A client that sends no `Origin` (a script, a test) is not refused by this check; it still needs the cookie session.
* **Session.** The socket is registered with the caller's session id. Signing out, or the server's revalidation of every plugin socket every 15 seconds finding the session gone, closes it with code 1008. A socket cannot outlive the session that opened it. The route is told first (`PluginSocket.on('sessionEnded')`, then the close), so a plugin can record that the sign-in ended rather than that the page was closed.
* **Guard.** A route may declare `guard(request, tx)` (SDK `HttpRouteDefinition.guard`). It runs **as the caller**, in a transaction with the caller's row policies (wrapped by the same plugin-transaction guard as a route handler, so the plugin's SQL filter applies), **before the upgrade**, so a thrown `HttpError` becomes a real HTTP status on the handshake (a `403` for a role check, a `404` for a row the caller may not see). The plugin's SQL filter applies as in any route. A route without a guard behaves as before.

Tests: `packages/plugins/workshop/test/terminal.test.ts` (non-admin `403` on the upgrade, foreign `Origin` `403`, sign-out closes the socket).

## The terminal into a sandbox (P7-09)

The `workshop` plugin lets a workspace **admin** open a shell into a throwaway test sandbox of one bot ([the page](./workshop.md#the-terminal-into-a-sandbox-p7-09) has the full description). The security rules, each with its test:

* **Admin only, on every road.** Every route starts with a check of the caller's workspace role (`app.workspace_role()` is `owner` or `admin`); a member, a team lead who is not an admin and an anonymous caller are refused (`403`, `401`), and so is the WebSocket upgrade (the guard). The page hides the way in, but the server never relies on it. Another workspace's admin cannot reach the bot (`404`/`403`).
* **Never production.** `placementOfRun` (shared) is the one definition: a sandbox is a run whose row says `rehearsal = true` and `trigger = 'conversation'`; everything else, and anything unknown, is production and is refused by name with no override. The database also refuses a rehearsal flag on any other trigger (`bot_runs_rehearsal_conversation`).
* **No credential in the shell.** The sandbox run is opened and **closed in the same function** (`openTerminalSandbox`, gateway-mcp), which revokes every token it minted. The function then proves it (no live token row, run not `running`, the minted token refused by `resolve`) and **throws, so no terminal opens, if the proof fails**. The test keeps the token and tries it afterwards. The sandbox run has no asker.
* **Unprivileged, jailed, no network.** The shell runs as a user number of its own for that terminal (60000 to 64999; the helper refuses root and refuses to run a shell as the server's own user) in a new mount, process, network, IPC and host-name namespace on a `tmpfs` root that the helper enters with `pivot_root` and then unmounts the old root (a `chroot` can be escaped; this cannot be walked back out of). The server's files, environment and processes are not visible, there is no network interface, no capability (the bounding set is dropped too) and no way to gain one (`no_new_privs`), and a system-call filter (seccomp) refuses a new user namespace (`unshare`, `clone` with a namespace flag, `clone3`), `setns`, `mount`, `chroot`, `pivot_root`, `ptrace`, `bpf`, `keyctl`, `perf_event_open` and `io_uring`. It is killed with everything it started when the socket closes (and by the parent-death signal if the server dies), and its folder is removed. The terminal root is a `0700` folder proved to be the server's own, and each folder is made by `mkdtemp`. The system's programs (`/usr`, `/bin`, `/lib`) are readable by the shell, by design, `/usr/local` included: keep secrets and deployments out of them. Where cgroup v2 cannot be used the memory bound is only 1 GiB of address space for each of at most 128 processes. In plain mode the random user numbers may overlap a systemd `DynamicUser` range. Signing out ends the socket within about 15 seconds (the revalidation poll), with the 10 second role watch as a second net. Tests: `terminal-pty.test.ts` (runs `unshare -Ur` and a chroot escape inside the real jail and expects both to fail). **What this is not:** it is a Linux namespace jail on the host kernel, not a virtual machine; **plain mode** (`MANYTHREADS_TERMINAL_ISOLATION=none`) needs the root user, drops to the unprivileged user and keeps the system-call filter, but gives no network or process isolation and a visible host file system, so it must not be used where the host holds anything to protect.
* **Off by default, and it says why.** `MANYTHREADS_TERMINAL_ENABLED=1` switches it on, and a probe must be able to start a real sandbox. Settings can only lower the built-in limits.
* **Hard limits.** Idle 300 s, longest 30 minutes, output 128 KiB/s and 8 MiB in all, input 1 MiB in all and 4096 bytes per frame, one open terminal per admin (a unique index), 60 s to connect; a frame that is not valid closes the socket. A terminal is claimed once, by the admin who asked for it.
* **Recorded, minimised, redacted.** Who, which bot, when, how it ended and the shell's **output** (never the raw keystrokes) are stored in `app.terminal_sessions`. The output goes through the data-protection pre-egress chain (`destination: terminal`, fail closed: a part that cannot be checked is not stored). 256 KiB at most. A private key block is masked whole. Only an admin of the workspace reads a record; the table is written only by the system (row policy). Typed secrets that the shell does not echo are not recorded. Retention does not sweep these rows yet.
* **Audit.** `terminal.opened` and `terminal.closed` appear in the audit log with the admin's name.
## A source of tools: `tool.source`

A plugin that extends `tool.source` may register **tool sources** with `ctx.toolSources.register(source)`: a list of tools plus `offered(tx, run)` and `call(tx, run, tool, input)`. The kernel checks at load time and refuses the plugin if it breaks any of these:

- every tool is a capability the plugin's own manifest declares (so the broker knows its name and whether it is destructive; a source cannot smuggle in an undeclared tool or a destructive one the broker would not tag);
- no tool is offered by two sources, and no tool is also a capability handler (in either order of registration), so a call has one landing place;
- the source id is unique, there is at least one tool, and each tool is a plain read or write.

The kernel keeps a frozen copy, so changing the list afterwards adds nothing. Looking at the registered sources (`list`, `find`) is the MCP gateway's job and needs `tool.invoke`; what it gets back is a **view** (`id`, `tools`, `offered`) with no `call`, so no plugin can reach a source's credentials except through the run service, which reads the run from its own row first (a kernel test proves the view has no `call`, however it is read). A source gives a plugin **no new right**: the run service calls it only after the broker authorized the call, inside the transaction of the run's bot (a write) or of the asker (a read), and only for a run that is still open. The source must check its own rows again under that transaction's row-level rules; it is never handed the system role. The source whose tools carry credentials (connections) reads them at the moment of use and never returns them.

## Background jobs: `job.register`

A plugin that extends `job.register` gets queues named `<plugin>.<name>` and a worker in the server. Its handler receives one transaction **as the
system actor** (`app.is_system()` is true: no RLS), scoped to `payload.workspaceId` when the payload has one. That is the same trust as `provider.identity`,
so it is declared in the manifest, and a reviewer should read every handler of such a plugin like a migration: validate the payload (it is whatever any caller of `ctx.jobs.enqueue`
put there), re-check access to every row it touches, never trust ids from the payload for another workspace. The statement filter (`guardPluginTx`) still applies to handler SQL.

## Rights of the runner pods (P19-12)

A Claude Code or Codex runner is a pod in the pods namespace (`claude-<runner>` or `codex-<runner>`, [claude-pods](./claude-pods.md)). What each identity around it may do in the cluster is below. `tools/devbox/stage-runners-probe.sh check` asks the stage cluster the same questions with `kubectl auth can-i --as=...` and fails when an answer differs from this table, so a chart change that widens a right shows up as a red line, not as a surprise.

| Who | May | May not |
| --- | --- | --- |
| The **keeper** service account of one pod (`claude-<runner>-keeper`, `codex-<runner>-keeper`) | `get` and `patch` the one Secret `<base>-credentials`, by name, in the pods namespace | `update` or `delete` that Secret; read the bridge key Secret `<base>-key` or any other Secret; list or create Secrets; read another runner's Secret; `pods/exec`; list nodes; anything in the release namespace |
| The **server** service account, as the pod controller (Roles `manythreads-hermes-pods-controller` and `manythreads-claude-pods-controller`, pods namespace) | create and change Deployments, Services, ConfigMaps, ServiceAccounts, Roles and RoleBindings; read, create and change Secrets; delete Secrets and volume claims (a token's removal, a confirmed machine move, and **Remove sign-in**, which deletes the runner's state claim as well as its credentials Secret); `get` and `list` pods | delete Deployments, ServiceAccounts, Roles or RoleBindings; `pods/exec`; read pod logs; anything in `kube-system` or the release namespace's Roles; create ClusterRoles; read Secrets across namespaces |
| The server service account, cluster-wide | `get` and `list` `nodes` (the machine picker, see above) | `watch`, change a node, read any other cluster-wide resource |
| The **run container** of a pod (the one that runs `claude` or `codex`) | nothing in Kubernetes: no token is mounted (`automountServiceAccountToken: false`); only the keeper container mounts one | reach the Kubernetes API with data, `169.254.169.254` or a private address the policy does not list (see below) |

The network policy `manythreads-claude-pods` applies to every container of the pod (a policy cannot tell containers apart): ingress only from the server on port 8650; egress DNS, the server on its port, and public port 443 outside the private, link-local and CGNAT ranges. The keeper reaches the API server by the cluster address, which the policy does not list; if that path is blocked the keeper's copy of a renewed login fails (the probe's "keeper renews" line says so) and the fix is a rule for the API server's node address, not a token for the run container. What the probe asks from the run container is that the API answers it no data (no connection, or a refusal without a token), that the node metadata address and an unlisted private host do not connect, and that the server (allowed) does, so a closed door is closed on purpose.

**What an operator can read.** `kubectl describe`, the pod and Deployment YAML, the events, the logs and the run container's environment and command line never hold a sign-in byte: the file reaches the pod as a Secret volume mounted only by the init step, and the bridge reads it from the state volume. The probe searches all of them for the canary strings of the stage's made-up logins. The Secret itself is still readable by anyone who can `get secrets` in the pods namespace: the cluster admin and the controller. Encrypting it at rest is a separate step (`tools/devbox/secrets-encrypt.sh`, below).

## The Claude sign-in file
The file an admin uploads for a Claude Code runner is a live login. It is read once in the upload route, handed to the pod provider and dropped; it lives only in
the runner's Secret and the pod's state volume. Never in the database, an event, an audit row, a log or an answer (tests plant a canary string in a made-up file
and search for it everywhere). The file may hold other services' sign-ins (`mcpOAuth`); it is stored as it is and the page says so and asks for a tick. A login
another runner holds is refused, because two copies sign each other out. The keeper may only get and patch its own Secret. k3s Secrets encryption on the devbox
is still off until the owner runs `tools/devbox/secrets-encrypt.sh enable --yes-i-am-the-owner` (owner decision O7; the script checks the datastore afterwards and `status` shows the state), so the Secret sits unencrypted in the datastore until then. **Remove sign-in** deletes the credentials Secret and the pod's state claim (the second copy of the login, which the tool renews); the work claim only holds public clones and stays. Data protection hides the shapes of the sign-in tokens (`signin-token`: Anthropic access and refresh tokens, JSON web tokens, ChatGPT refresh tokens and the values of the file's own token fields) in every outbound message, and the agent bridge hides the same shapes in a run's answer.

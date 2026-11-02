# bot-runners

bot-runners is the **runner catalog**: the list of places a bot can run, set up once by a workspace admin and chosen from by everyone who edits a bot. A **runner** is one place: a Hermes gateway on a machine the company owns, the team Hermes pod inside the
cluster, or (later) the Claude Code pod and the Codex pod, or the LLM gateway, which calls a model alias and nothing else (P19-10). The admin types the address and the key once, decides which teams may use the runner, and may mark one runner as the default. A team lead no longer types addresses
or keys; they only pick a runner by its name. PLAN P19-02 (backend); the admin screen (Settings > Workspace > Runners, clients/web/src/screens/admin/runners) is P19-04, built; the picker in the bot editor is P19-03, later.

Words used on this page. A **Hermes gateway** is the program that runs Hermes, an open-source agent, and answers on an address with an API key. A **kind** says what sort of runner it is. A **state** says whether the runner is ready to run bots. A
**guard** is the check on outbound addresses (loopback, cluster-internal and cloud metadata addresses are refused); see [runtime-hermes](./runtime-hermes.md#hermes-connections-mode-a). **Adopting** means turning a connection that a team lead made in the old way
into a runner an admin owns.

## What a runner is

Table `app.bot_runners` (one row per runner, owned by the workspace) and `app.bot_runner_teams` (which teams may use a runner whose `all_teams` flag is off; the list **is** the permission). Both are forced-RLS tables that only workspace
owners and admins can read or write.

| column | meaning |
|---|---|
| `name` | the short name a `BOT.md` uses (`placement.runs_on: host`); lower case, unique in the workspace, **never changes** |
| `label` | the name people read, up to 80 characters |
| `kind` | `hermes_gateway`, `hermes_pod`, `claude_cli`, `codex_cli` or `llm_gateway` (all five are allowed by the database; see below for which can be made now) |
| `enabled`, `all_teams`, `is_default` | switched on; open to every team; the workspace default (at most one, enforced by a unique index) |
| `base_url`, `secret_id`, `profile_rule` | for `hermes_gateway`: the address, the id of the encrypted key (the key itself is **not** a column) and the profile name rule (default `{bot}`) |
| `node` | for `hermes_pod`: the machine the team pods stand on (`kubernetes.io/hostname`), or empty for "the cluster chooses". Set only through `PUT …/node` (below); a create or a patch that carries it is refused. Admin only |
| `model_alias`, `owner_actor_id`, `plan_label`, `credentials_expires_at`, `login_id`, `terms_*`, `max_concurrent` | for the kinds that come later (the LLM gateway and the Claude and Codex pods); not shown to teams |
| `status` | `not_set_up`, `waiting_for_sign_in`, `starting`, `ready`, `needs_sign_in`, `waiting_for_node`, `moving`, `paused`, `off`, with `status_detail` and `last_checked_at` |

**Which kinds can be made now.** `hermes_gateway`, `hermes_pod` and `llm_gateway`. `claude_cli` and `codex_cli` answer `409` ("not available yet") until their pods are built; the database already allows them so the later migration changes nothing here.

**The key is never returned.** A Hermes gateway's key is encrypted with the secrets mechanism (`ctx.secrets.put`, extension `secret.seal`) and only `hasKey` is shown to an admin. A Claude or Codex sign-in will live in the pod's own Secret, never in a column.

## What a team sees

Teams do not read the tables. `app.bot_runners_for_team(team_id)` is a `SECURITY DEFINER` function (owned by the system role, fixed `search_path`, no access for `PUBLIC`) that answers the runners open to that team and returns **only**
`name`, `label`, `kind`, `status`, `is_default`, the owner's name, the plan label and `shared_with` (how many teams may use it; for a runner open to every team, the number of teams in the workspace). No address, key, node, sign-in or expiry. The caller must be a member of that team (or a workspace admin); anyone else gets a `403` (database code `42501`), the same whether the team exists or not, not an empty list. `GET /api/teams/:slug/bot-runners` calls it. A
runner outside the team's list, or switched off, is not in the answer.

## Routes

All admin routes require a workspace owner or admin (`403` "Only a workspace admin can do that" otherwise) and are the shapes in `packages/shared/src/api/bot-runners/`. Credential routes have abuse limits (see [rate limits](../deploy/rate-limits.md)).

| route | what it does |
|---|---|
| `GET /api/admin/bot-runners` | every runner with its team list, `hasKey`, `botCount` and the names of the teams that have bots on it |
| `POST /api/admin/bot-runners` | make a runner. `hermes_gateway` needs `baseUrl` (passes the outbound guard) and `apiKey` (at least 8 characters). `409` for a taken name and for `claude_cli`/`codex_cli` |
| `PATCH /api/admin/bot-runners/:id` | change label, address, key, profile rule, `enabled`. A new address or key marks the state `not_set_up` until a test passes. The default runner cannot be switched off |
| `DELETE /api/admin/bot-runners/:id` | delete. Refused with `409` while bots are placed on it; the message says how many and in which teams |
| `POST /api/admin/bot-runners/:id/test` | ask the runner whether it answers; the state becomes `ready` or stays `not_set_up`. Answers one of fixed sentences; nothing the remote side said comes back |
| `PUT /api/admin/bot-runners/:id/teams` | `{ all: true }` or `{ teams: [ids] }` |
| `PUT /api/admin/bot-runners/default` | `{ runnerId }` or `null`. The default must be enabled and of a kind that runs bots today |
| `GET /api/admin/bot-runners/old-connections` | the connections team leads made before runners existed, listed as "Team-owned (old)" (see Adopting) |
| `POST /api/admin/bot-runners/old-connections/:connectionId/adopt` | make a runner from one |
| `GET /api/admin/bot-runners/nodes` | the machines of the cluster the operator allows, for the machine picker (P19-08; see "The machine a pod runner stands on"). `?runnerId=` adds, for that pod runner, where its work volume is and where its pods stand |
| `PUT /api/admin/bot-runners/:id/node` | `{ node }`: a machine name, or `null` to let the cluster choose. Pod runners only; the name must be on the operator's list and Ready. Answers `{ runner, recreatesWorkVolume }` |
| `GET /api/teams/:slug/bot-runners` | for team members: the short list above (eight fields: the seven plus `sharedWith`) |

**The delete guard.** A runner that a bot still runs on cannot be deleted. The count is every bot with `placement.runs_on` naming it (status `active` or `disabled`) plus every bot placed through an adopted connection. The `409` text names the count and the
teams, for example `3 bots still placed on "Office Hermes" (teams: Engineering, Marketing). Move them to another runner first.` Deleting an adopted runner also removes the link on the old connection.

## The machine a pod runner stands on (P19-08)

A cluster can have several machines (Kubernetes calls each a **node**). A team's Hermes pod keeps its files on a volume that lives on one machine, so where the pod runs matters. A workspace admin may name the machine for a pod runner; every team's Hermes pod of that runner then runs there. The page is Settings > Workspace > Runners > **Machine** on a pod row; it shows a select of the machines and one state line: `Running on <machine>`, `Waiting: node <machine> is not Ready`, `Moving to <machine>` or, before a pod exists, what is set.

* **Who lists the machines.** This plugin cannot read the cluster (plugins do not import each other and this one holds no cluster rights). `hermes-pods` registers a provider `runner.nodes` (`listNodes()`, `podPlacements()`; see [hermes-pods](./hermes-pods.md#choosing-the-machine-p19-08)) and this plugin asks it. When the provider is absent (an install with no cluster behind the server) `GET …/nodes` answers `available: false` with one sentence, and naming a machine is refused with `409`; clearing it (`null`) always works.
* **The operator's list.** The Helm value `botRunners.allowedNodes` (empty: every machine) reaches the server as `MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES`, a comma-separated list read on each request. A machine that is not on it is never listed, and naming it is refused with the same `400` as naming a name that is no machine, so the answer does not tell which names exist.
* **What a machine shows.** `name`, `ready` (the cluster's Ready condition and not cordoned, that is, not marked "do not place new pods"), `architecture`, `cpuAllocatableMillis` and `memoryAllocatableBytes`, `hasWorkVolume` and `workVolumes` (how many of this runner's team pods keep their volume there). **CPU and memory are what the machine offers to pods (its allocatable amount), not what is free.** Free needs a read of every pod in the cluster, which is a second cluster-wide right this phase does not ask for. The page says "offers".
* **One machine.** An install with exactly one allowed machine returns `singleNode: true`; the page shows that machine and the line "This install has one machine, … There is nothing to choose".
* **Refusals.** `400` a runner that is not a pod runner, a name that is not a valid machine name, a name that is not allowed or not in the cluster. `409` a machine that is not Ready ("That machine is not Ready, so a pod could not start on it. Pick a machine that is Ready."), or no cluster to ask. Nothing the cluster said is passed on (it can contain addresses).
* **The state line is live, not stored.** `placement` is worked out on each `GET …/nodes?runnerId=` from the pods, the Deployments and the volume claims: `idle` (no pod yet), `running`, `waiting` (reason `node_not_ready`, `not_placed`, `starting` or `move_not_confirmed`) and `moving`. Only the pods of the teams this runner decides the machine of are counted (below). The runner's stored `status` column is not changed by a move; `waiting_for_node` and `moving` stay in the list of states but this plugin does not write them.
* **Changing the machine recreates the work volume, and only this call can start that.** See [hermes-pods](./hermes-pods.md#choosing-the-machine-p19-08) for exactly what is lost and kept. The reply's `recreatesWorkVolume` says whether a pod's volume sits on a different machine than the one now chosen, and the page asks to confirm first, in plain words. `PUT …/node` is the admin's confirmation: when volumes would be recreated it writes the confirmation on those teams' volume claims (through the `runner.nodes` provider's `confirmMove`) before it answers, and if the cluster does not take it the request fails with `409` and nothing is changed. Nothing else (Make default, Enable or Disable, `PUT …/teams`, a new runner) deletes a volume: the pod is held where its volumes are and the page says "Waiting: the machine for this pod changed … confirm the move". Sending the machine that is already set, while a move is held, confirms it again (and writes the event); with nothing held it writes nothing. Clearing the machine moves nothing: pods already placed stay where they are, and any waiting confirmation is taken off. The runner's row is locked for the call, so two admins take turns.
* **Several pod runners, and which teams a change governs.** There is one pod per team, shared by all pod runners. When more than one pod runner names a machine for a team, the default runner's machine wins, otherwise the first by name. A runner governs a team only when it is enabled, the team may use it and it is the one that wins. `recreatesWorkVolume`, the confirmation and the "has the work volume" marks count only the pods of the teams the runner governs: a runner that is outranked on every team it serves moves nothing and says `recreatesWorkVolume: false`.
* **The confirm text is the page's, not the server's.** The server answers per machine how many work volumes sit there (`workVolumes`, for the governed teams); the page words the question from that. A text written by the server (or a dry-run call that returns it) is not built.
* **Claude pods.** The Claude pod runner (P19-05) is not built; when it is, it asks the same provider. Nothing in this plugin is specific to Hermes.

## One door to a place to run: `resolveRunner`

`resolveRunner(ctx, { teamId, runner })` is the only code that turns a runner name into where to send a run. It is offered to other plugins as the provider `bot.runners` (`provider.bot.runners`; the SDK type is `BotRunnersProvider`), so
`runtime-hermes` never imports this plugin. It works in a system transaction and answers either a target
`{ runner, kind, address, key, agent, guard, profileRule, status, modelAlias }` or a refusal with a fixed reason: `unknown`, `disabled`, `not_available_to_team`, `not_runnable` (a kind that cannot run a bot yet), `not_set_up`, `not_ready`. The refusal words hold no address or key, and
a team of another workspace gets `unknown`.

- `hermes_gateway`: the address from the row, the key opened from the secret (only here, only for the call), `guard: true` so the outbound guard still runs on every request.
- `hermes_pod`: the address of the team's own pod (the team's `managed` connection row), no key, `guard: false` because the platform registered that address.
- `llm_gateway` (P19-10): no address and no key; the target carries `modelAlias`, the model alias the runner names (the answer is `not_set_up` when the runner has none). The run is a loop of model calls made through the platform's own gateway, see the model runtime below.

**Which states run (P19-03).** `ready` runs. `not_set_up` runs only when the runner has an address and key (a runner that was set up before states existed keeps working); without them it is refused as `not_set_up`. `waiting_for_sign_in`, `starting`, `needs_sign_in`, `waiting_for_node`, `moving` and `paused` are refused as `not_ready`. A switched-off runner is `disabled`. The sentence is one plain line that names the runner by its label, for example "This bot runs on Main Hermes, which an admin has switched off." A team that may not use a runner, or a name that is no runner, hears the same line that names nothing ("This bot runs on a runner this team may not use. An admin can add the team to its list.").

The provider has three more members: `checkPlacement(tx, { teamId, runner, runtimeGrants?, nativeGrants? })` is the bot loader's question (does the runner exist and may the team use it; a switched-off runner still passes, it is judged when a run starts) and runs on the caller's transaction, because the loader works inside the outbox consumer's transaction. When the runner is an `llm_gateway` runner and the bot's `capabilities.runtime` lists anything (a shell, files or a browser), the answer is a refusal in plain words (below). When `nativeGrants` (the bot's `capabilities.native`) is given and lists neither `messages.post` nor `answer.post` (nor `messages.*` / `answer.*`), the answer is also a refusal, because the platform posts the reply for the bot and the run would end in "this bot is not set up to post messages" (P19-10c). The proposal check "BOT.md loads" asks the same question through the shared function `botPlacementProblem` in the SDK, so a proposal the loader would refuse says so before it is applied. `kindOf(tx, { teamId, runner })` answers the kind of a runner and its model alias (or null), so the run job can pick the runtime without opening the runner's secrets. `teamRunners({ teamId })` answers the workspace default runner (only when it is enabled, can run bots and the team may use it) and the names of the pod runners the team may use; an `llm_gateway` runner is never the default and never a pod runner.

## The model runtime: a bot on an LLM gateway runner (P19-10)

A bot whose `placement.runs_on` names an `llm_gateway` runner is answered by the `model` runtime (`src/model-runtime.ts`), a `bot_runtime` provider this plugin registers (manifest `extends: ['provider.bot_runtime']`). There is no Hermes and no process. The run job (runtime-hermes) asks `kindOf`, and for an `llm_gateway` runner it hands the run to this provider instead of Hermes; a bot with no `runs_on`, or on any other kind, runs as before.

The loop, one **step** per model call: the model is asked on the runner's **alias** (the platform's name for a model, bound by an admin under LLM settings) with the body of the bot's `BOT.md` as the system text, the person's question, and the tools the bot may use. A step that comes back with no tool call ends the run and its text is the reply, posted exactly as a Hermes run's reply is. A step that asks for a tool calls it through the **same door the MCP gateway uses** (`provider.mcp.tools`, members `offered` and `call`): the bot's grants, approvals, the data-loss check, the rehearsal hold and the source log all apply, and a refused call goes back to the model as the tool's answer, not as the end of the run. The tools are the bot's `native` tools and its memory; a tool name is sent to the model with any character a provider does not accept (the dot of `memory.recall`) turned into an underscore, and the call goes to the real tool. A tool answer is cut at 20,000 characters before the model reads it. A tool that throws is answered to the model as a fixed tool error (`failed`; the error text stays in the log); only the end of the run itself ends the loop. The model may ask for several tools in one step: at most 8 are run per step (the rest are answered "too many") and at most 40 in a whole run (more is the failure `steps`); the tool name shown in the run's events has control characters removed and is cut at 100 characters, because the model chose it.

The model call itself is `chat` of the `provider.llm` door ([gateway-llm](./gateway-llm.md#one-turn-of-a-bot-run-chat)): the pre-call guard, budgets, rate limits and redaction apply to every step, and each step writes a line in the spend ledger under the bot and the run. The runtime never touches the database; the run job supplies the two doors (`scope.model`, `scope.tools`). The check is made on every user and tool message added since the previous step (parallel tool calls bring several), and the gateway hands back the conversation with any redaction applied; the runtime replaces its own history with that copy, so a secret in the prompt is redacted once and is never sent again in clear text on a later step. A model call or a tool call that never answers cannot hold the run: each is raced against the run's remaining time and against a stop, and the run ends as `timeout` (the late answer is dropped). An answer the model had to cut off at its length limit is the failure `too_long`, never a reply that looks complete.

**Limits.** At most 12 steps (the default; `limits.maxTurns` is the hook, and nothing in a `BOT.md` sets it yet) and the run's time budget (`limits.timeoutSeconds`, default 600 seconds). Running out of steps is the failure `steps`; a guard, budget or rate refusal is `limit`; an alias nobody bound, a proxy that does not answer or an empty answer is `gateway`; the clock (or a stop) is `timeout`; an answer cut off at the length limit is `too_long`; a runner that is off, not open to the team or not ready is `runner_refused` with the runner's own sentence. Each is the one fixed line in the thread (`FAILURE_NOTICE` in runtime-hermes); nothing the gateway said is repeated.

**What it does not have.** No shell, no files, no browser. A bot whose `BOT.md` lists any `capabilities.runtime` cannot be placed on this kind of runner: the loader marks the definition invalid on `placement.runs_on` with "<runner> only calls a model: it has no shell, files or browser to give this bot (the bot asks for: shell, files). Take those out of the bot's runtime capabilities, or pick a Hermes runner.", and the Runs on picker on the bot's page shows the runner disabled with the same reason. The same goes for a bot with no way to post its reply (its `capabilities.native` has neither `messages.post` nor `answer.post`): "<runner> only calls a model and posts the bot's reply for it, but this bot is not allowed to post: add messages.post (or answer.post) to the bot's native capabilities, or pick a Hermes runner." Brain-style bots (they read and write memory and post a reply) are what it is for.

**Cost.** The platform does not price a call, so every line has a cost of zero and tokens are counted; a USD budget does not bite on this runtime until a price table exists (a token or call limit does).

## How runtime-hermes uses it

**A runner can be named like a connection.** When a bot's `placement.gateway.connection` (`gateway: host` in `BOT.md`) matches no connection of the team, runtime-hermes asks `resolveRunner` for a runner of that name, with the same refusals a `runs_on` placement uses. See [runtime-hermes](./runtime-hermes.md#placing-a-bot-on-a-runner-runs_on). So on a fresh install an admin makes a `hermes_gateway` runner called `host`, lists the team, and `gateway: host` works with no team connection. A runner the team is not listed on answers like a name that is nothing at all, and the sentence never names the runner, so a team learns nothing about runners it may not use. A connection of the team with that name wins over a runner.

[runtime-hermes](./runtime-hermes.md) keeps its Hermes connection routes. A connection that has been adopted carries `runner_name`; a run on it asks `resolveRunner` and uses the runner's address and key, so rotating the key on the runner is
enough, and switching the runner off or taking the team off its list stops the run with a plain failure notice (without calling the gateway). A connection that has not been adopted works as before. `resolveRunnerTarget` in runtime-hermes is also what a
`runs_on` placement will use.

**A team lead can no longer make, change or delete a connection.** `POST`, `PATCH` and `DELETE` on `/api/teams/:slug/hermes/connections` answer `403` with: "Runners are set up by a workspace admin now. Ask an admin to add or change this under Runners."
(for everyone, admins included; an admin uses the runner routes). Migration `runtime-hermes/0004_adopted_connections.sql` also tightens the table's own write policies to workspace admins and the system, so the same is true below the API. Listing
connections still works for the team, but the address is shown only to workspace admins.

## Adopting a connection

`GET /api/admin/bot-runners/old-connections` lists the connections with no `runner_name`, with team, bot count and whether they can be adopted (only the agent `hermes`; Claude Code and Codex connections are not adoptable). `POST …/adopt` takes an optional `name` and
`label`:

- an **external** connection becomes a `hermes_gateway` runner with a **copy** of the key (the old secret is not shared), open to that team only, `ready` if the connection's last check passed (a status of `unknown` means it was never checked, so the runner starts as "not set up" until Test passes);
- a **managed** connection (the team's pod) becomes the shared `hermes_pod` runner `team-pod` ("Team Hermes pod"), and the team is added to its list. If `team-pod` exists and an admin has switched it off, adopting answers `409` ("switch it on first") instead of linking a team to a runner that would stop its bots;
- the connection is linked (`runner_name`) and no `BOT.md` is rewritten, so every bot keeps running.

## Events and audit

`bot_runner.runner.created|updated|deleted|tested`, `bot_runner.node.changed` (the machine was set or cleared; it holds ids, the runner name, whether a machine was set before and is set now, and whether the change recreates a work volume, **never the machine's name**; audited as `bot_runner.node_changed`), `bot_runner.availability.changed`, `bot_runner.default.changed`, `bot_runner.terms.accepted`, and `bot_runner.run.refused` (emitted by runtime-hermes, not by this plugin: a run was turned away at its start; it holds ids, the runner name and one reason word from `unknown|disabled|not_available_to_team|not_runnable|not_set_up|not_ready`) and `bot_runner.run.unmetered` (also runtime-hermes: a run on a Hermes pod ended well and left no line in the spend ledger, so a model call may have gone around the gateway; it holds ids and the runner name, audited as a failed `bot_runner.run_unmetered` row). Event names have three parts, so they differ from the shorter names in the plan. They say that something happened and to
which runner (id and name); never an address, key, node or sign-in, and `updated` lists the names of the settings that changed from a fixed list. The audit plugin records each as a `settings` row with the actor and the runner name
(see [audit](./audit.md)). `bot_runner.terms.accepted` is registered and audited but nothing emits it yet; it waits for the Claude and Codex runners.

## Rules this plugin keeps

- No address, key or node reaches a lead, a member, an error text, an event, an audit row or a log. (An admin reads the node in the runner list and the machine picker; that is all.)
- Every outbound address passes the guard when it is saved and again when a call is made.
- Plugin code never calls the database outside `ctx.db`; reading a key needs a system transaction.
- Migrations are forward-only (`migrations/0001_bot_runners.sql`; `0002_runner_node.sql` first sets `node` to null on any row that breaks either rule, then adds two checks on `node`: a machine-name shape, and only on pod kinds. They are `NOT VALID`, which skips the old rows when the check is added but still judges a row again whenever it is updated, so without the clean-up an unrelated edit of a legacy row would fail with `23514`).

## Tests

`test/rls/bot-runners-rls.test.ts` (the tables, the team function, who can read what), `test/nodes-api.test.ts` (the machine routes over HTTP with a local double of the Kubernetes API: the operator's list, a machine that is not Ready or not allowed refused, the event holds no machine name, a move says it recreates the volume, the state line's four states, no cluster), `test/bot-runners-api.test.ts` (every route, a lead and a member never see the address, key or node, delete guard, adopt), `test/resolve.test.ts` (the refusals, the `llm_gateway` target, `kindOf`, the placement refusal for a shell, files or a browser, and for a bot that cannot post its reply), `test/model-runtime.test.ts` (the loop alone with a stub model and a stub tool door: a tool call is made and its result used, the step limit, a guard refusal, a missing alias, the runner's own refusal), and
`runtime-hermes/test/gateway-run.test.ts` (an adopted connection keeps working; the old routes answer `403`), `runtime-hermes/test/model-run.test.ts` (a mention end to end on an `llm_gateway` runner with a stand-in proxy: the tool call, the reply, the spend under the bot, a spent budget, the step limit). The events contract is `packages/shared/test/events/phase19-bot-runner-contracts.test.ts`.

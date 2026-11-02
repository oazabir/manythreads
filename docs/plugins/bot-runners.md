# bot-runners

bot-runners is the **runner catalog**: the list of places a bot can run, set up once by a workspace admin and chosen from by everyone who edits a bot. A **runner** is one place: a Hermes gateway on a machine the company owns, the team Hermes pod inside the
cluster, or (later) the Claude Code pod, the Codex pod and the LLM gateway. The admin types the address and the key once, decides which teams may use the runner, and may mark one runner as the default. A team lead no longer types addresses
or keys; they only pick a runner by its name. PLAN P19-02 (backend); the admin screen is P19-04 and the picker in the bot editor is P19-03, both later.

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
| `node`, `model_alias`, `owner_actor_id`, `plan_label`, `credentials_expires_at`, `login_id`, `terms_*`, `max_concurrent` | for the kinds that come later (pods and the LLM gateway); not shown to teams |
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
| `GET /api/teams/:slug/bot-runners` | for team members: the short list above (eight fields: the seven plus `sharedWith`) |

**The delete guard.** A runner that a bot still runs on cannot be deleted. The count is every bot with `placement.runs_on` naming it (status `active` or `disabled`) plus every bot placed through an adopted connection. The `409` text names the count and the
teams, for example `3 bots still placed on "Office Hermes" (teams: Engineering, Marketing). Move them to another runner first.` Deleting an adopted runner also removes the link on the old connection.

## One door to a place to run: `resolveRunner`

`resolveRunner(ctx, { teamId, runner })` is the only code that turns a runner name into where to send a run. It is offered to other plugins as the provider `bot.runners` (`provider.bot.runners`; the SDK type is `BotRunnersProvider`), so
`runtime-hermes` never imports this plugin. It works in a system transaction and answers either a target
`{ runner, kind, address, key, agent, guard, profileRule, status }` or a refusal with a fixed reason: `unknown`, `disabled`, `not_available_to_team`, `not_runnable` (a kind that cannot run a bot yet), `not_set_up`. The refusal words hold no address or key, and
a team of another workspace gets `unknown`.

- `hermes_gateway`: the address from the row, the key opened from the secret (only here, only for the call), `guard: true` so the outbound guard still runs on every request.
- `hermes_pod`: the address of the team's own pod (the team's `managed` connection row), no key, `guard: false` because the platform registered that address.

Whether a runner must be `ready` before a run starts is decided by the picker work (P19-03); today an enabled runner on the team's list that has an address and key runs.

## How runtime-hermes uses it

**A runner can be named like a connection.** When a bot's `placement.gateway.connection` (`gateway: host` in `BOT.md`) matches no connection of the team, runtime-hermes asks `resolveRunner` for a runner of that name, with the same refusals a `runs_on` placement will use. So on a fresh install an admin makes a `hermes_gateway` runner called `host`, lists the team, and `gateway: host` works with no team connection. A runner the team is not listed on answers like a name that is nothing at all, and the sentence never names the runner, so a team learns nothing about runners it may not use. A connection of the team with that name wins over a runner.

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

`bot_runner.runner.created|updated|deleted|tested`, `bot_runner.availability.changed`, `bot_runner.default.changed`, `bot_runner.terms.accepted`. Event names have three parts, so they differ from the shorter names in the plan. They say that something happened and to
which runner (id and name); never an address, key, node or sign-in, and `updated` lists the names of the settings that changed from a fixed list. The audit plugin records each as a `settings` row with the actor and the runner name
(see [audit](./audit.md)). `bot_runner.terms.accepted` is registered and audited but nothing emits it yet; it waits for the Claude and Codex runners.

## Rules this plugin keeps

- No address, key or node reaches a lead, a member, an error text, an event, an audit row or a log.
- Every outbound address passes the guard when it is saved and again when a call is made.
- Plugin code never calls the database outside `ctx.db`; reading a key needs a system transaction.
- Migrations are forward-only (`migrations/0001_bot_runners.sql`).

## Tests

`test/rls/bot-runners-rls.test.ts` (the tables, the team function, who can read what), `test/bot-runners-api.test.ts` (every route, a lead and a member never see the address, key or node, delete guard, adopt), `test/resolve.test.ts` (the refusals), and
`runtime-hermes/test/gateway-run.test.ts` (an adopted connection keeps working; the old routes answer `403`). The events contract is `packages/shared/test/events/phase19-bot-runner-contracts.test.ts`.

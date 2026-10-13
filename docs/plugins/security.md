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
- `ALTER ROLE|USER|DATABASE|SYSTEM`.

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

A route returns `setSession` (the `issue` result) or `clearSession`; the server turns that into the `manythreads_session`
(HttpOnly, SameSite=Lax, Secure outside local http) and readable `manythreads_csrf` cookies. The token is opaque random bytes;
only its sha256 is stored (`app.session_tokens`, with the UNLOGGED `app.session_cache` in front for the hot lookup). Never log,
return in a body, or store a session token or a CSRF token.

## Model providers: `provider.llm`, and `ctx.secrets`

`ctx.secrets` is the same envelope-encrypted store sign-in uses, and it has two doors because two trust domains need it: a
plugin that extends `provider.identity` (sign-in client secrets) and one that extends `provider.llm` (model provider API keys,
PLAN P5-06). Everything else throws on `ctx.secrets`. `put` runs in the caller's transaction (a workspace admin's or the
system actor's; the database refuses anyone else) and `get` is system-only, so a plugin that stores a key hands it back
through `provider.llm` at call time, never through a route. A route never returns a secret; it answers only whether one is
stored.

## The janitor's door: `run.close`

A plugin that extends `run.close` and not `tool.invoke` gets a `ctx.runs` of which one member works: `close(runId, status)` — end a run through the run service (which revokes its tokens and emits `bots.run.closed`). Every other member (`open`, `asBot`, `asReader`, `asApproved`, `authorize`, `may`, `invoke`, `logSource`, `inheritSources`) throws, naming `tool.invoke`. It exists so the bots plugin's stale-run reaper can end a run whose worker died without being handed the whole run door. A plugin with both gets the full door.

**An ended run takes nothing more.** The run service checks, on every door that acts for a run (`asBot`, `asReader`, `asApproved`, `authorize`, `may`), that the run is still `running`: a worker that still holds the handle of a run that was ended (by the reaper, by an approval's re-run, by its own client) gets `RunEndedError` (a denied decision from `authorize` / `may`). Closing a run is therefore final for every call that starts after it: none appends to its source log or acts for it. A call that had already passed the check when the run was closed (a read in flight) can still land its line, so the log is settled shortly after the close rather than at the instant of it; what the memory rule reads, and what an approval's re-run inherits, is read after the run has ended, never while it is open.

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

## Background jobs: `job.register`

A plugin that extends `job.register` gets queues named `<plugin>.<name>` and a worker in the server. Its handler receives one transaction **as the
system actor** (`app.is_system()` is true: no RLS), scoped to `payload.workspaceId` when the payload has one. That is the same trust as `provider.identity`,
so it is declared in the manifest, and a reviewer should read every handler of such a plugin like a migration: validate the payload (it is whatever any caller of `ctx.jobs.enqueue`
put there), re-check access to every row it touches, never trust ids from the payload for another workspace. The statement filter (`guardPluginTx`) still applies to handler SQL.

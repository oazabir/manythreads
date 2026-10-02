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

## Background jobs: `job.register`

A plugin that extends `job.register` gets queues named `<plugin>.<name>` and a worker in the server. Its handler receives one transaction **as the
system actor** (`app.is_system()` is true: no RLS), scoped to `payload.workspaceId` when the payload has one. That is the same trust as `provider.identity`,
so it is declared in the manifest, and a reviewer should read every handler of such a plugin like a migration: validate the payload (it is whatever any caller of `ctx.jobs.enqueue`
put there), re-check access to every row it touches, never trust ids from the payload for another workspace. The statement filter (`guardPluginTx`) still applies to handler SQL.

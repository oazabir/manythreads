# Writing a manythreads plugin

A plugin is one package under `packages/plugins/<name>` that adds behaviour through the extension points of spec §3.
Start from `packages/plugins/example-hello` (see [example-hello.md](./example-hello.md)); read
[security.md](./security.md) before writing SQL.

## Layout

```
packages/plugins/<name>/
  package.json        "manythreads": { "entry": "./src/index.ts" }, deps: @manythreads/sdk, @manythreads/shared, zod
  src/index.ts        export default definePlugin({ manifest, register })
  migrations/         0001_<what>.sql ... (optional)
  tsconfig.json
```

The plugin name is lowercase letters, digits and dashes. It is also the migration namespace and the `plugin` key of
scoped storage.

## SDK-only imports

A plugin imports **only `@manythreads/sdk` and `@manythreads/shared`** (plus `zod`). Never `@manythreads/kernel`, `pg`, or another
plugin's files. Everything a plugin may touch is on the `ctx` that `register(ctx)` receives. This is the public API;
the kernel can change behind it.

## Manifest

```ts
export default definePlugin({
  manifest: {
    name: 'tasks', version: '0.1.0', kind: 'server',
    extends: ['event.subscribe', 'event.emit'],      // extension points you use (anything else throws at register)
    capabilities: [{ name: 'tasks.claim', destructive: false }],
    events: { emits: ['tasks.task.claimed'], consumes: ['channel.message.posted'] },
    dependsOn: [],                                    // loaded after these
    migrations: 'migrations',                         // directory of numbered .sql files
  },
  register(ctx) { /* ... */ },
});
```

The manifest is validated when the module loads (a bad field throws a Zod error naming it). Using an extension point
that is not in `extends`, or an event not in `events.emits` / `events.consumes`, throws in `register` with the plugin name.

## Extension points

| `extends` entry | `ctx` API |
|---|---|
| `event.subscribe` / `event.emit` | `ctx.events.subscribe(type, handler)`, `await ctx.events.emit(tx, event)` |
| `hook.pre_persist`, `hook.pre_egress` | `ctx.hooks.prePersist(fn)`, `ctx.hooks.preEgress(fn)` |
| `provider.<kind>` | `ctx.providers.register(kind, impl)` |
| `command.register`, `trigger.register`, `component.register` | `ctx.commands`, `ctx.triggers`, `ctx.components` |
| `surface.nav/screen/card/panel`, `settings.page`, `composer.action` | declarative client surfaces (`ctx.surfaces`, `ctx.settings`, `ctx.composer`); no client JS is loaded at run time |
| (always available) | `ctx.http.route(def)`, `ctx.capabilities.register(name, handler)`, `ctx.storage`, `ctx.mail.send({ template: 'verify' \| 'reset' \| 'invite', to, ... })`, `ctx.runtime` (`publicUrl`, `now()`), and the helpers below: `ctx.db`, `ctx.audit`, `ctx.templates` |
| `job.register` | `ctx.jobs.register(queue, handler, options?)`, `await ctx.jobs.enqueue(tx, queue, payload, options?)`: background work; handlers run as the **system actor** (see Background jobs below, and [security.md](./security.md)). Not in spec §3: it is declared like `provider.identity` because of that privilege |
| `provider.identity` | `ctx.identity`: run as the system actor, create and end sessions, hash passwords, a start-up task. Sign-in plugins only; read [security.md](./security.md) |

### Helpers: do not copy kernel code into a plugin

A plugin cannot import the kernel, so anything the kernel already does is on `ctx`; re-implementing it a fourth time is how
statements drift apart.

```ts
// Get-or-create: one INSERT ... ON CONFLICT ... DO SELECT (a hit writes nothing; concurrent callers converge on one row).
const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
const row = await ctx.db.getOneOrCreate<{ id: string }>(tx, {
  table: 'app.teams', values: { id, workspace_id, slug, name }, conflict: ['workspace_id', 'slug'], returning: ['id'],
});
const created = row.id === id;               // the pre-drawn id came back: this call created it

// Audit/domain event with the envelope filled in (schemaVersion 1, the transaction's workspaceId unless you pass them).
await ctx.audit.emit(tx, { type: 'workspace.team.created', teamId, slug, name, template: null });

// The shipped team templates (templates/ at the repo root or MANYTHREADS_TEMPLATES_DIR); read once, cached, validated.
const template = await ctx.templates.get('engineering');   // or await ctx.templates.list()
```

`ctx.audit.emit` is `ctx.events.emit` with defaults: it needs `event.emit` in `extends` and the type in `events.emits`, and the
registry validates the payload. Conflict targets and `conflictWhere` (a partial unique index predicate) are trusted SQL, never user input.

### Cohesion services: read state, entity links, live push

Three kernel services make plugins cohere (spec §3). They are always on `ctx`; details in [../kernel/read-state.md](../kernel/read-state.md) and
[../kernel/entity-links.md](../kernel/entity-links.md).

```ts
// The plugin that inserts a message, in the same transaction: everyone but the author gets one more unread.
await ctx.readState.onPosted(tx, { targetType: 'channel', targetId: channelId, messageId, authorId, recipientPersonIds });
// The plugin that owns the messages says how to count what is newer than a read position (markRead uses it).
ctx.readState.registerCounter('channel', async (tx, { targetId }, after) => countMessagesAfter(tx, targetId, after));
await ctx.readState.markRead(tx, personId, { targetType: 'channel', targetId: channelId }, upToMessageId);
await ctx.links.create(tx, { teamId, src: { type: 'message', id }, dst: { type: 'task', id: taskId }, kind: 'created_from' });
ctx.links.registerResolver('message', async (tx, id) => /* an RLS-filtered lookup */ ({ title, subtitle, href }) /* or null */);
await ctx.realtime.pushToPerson(tx, personId, 'notifications.item.added', { id });   // delivered at commit, to every replica
```

### Background jobs

A plugin that extends `job.register` owns queues named `<plugin>.<name>`; the server starts one worker per registered queue (and one for
the kernel's `kms.rewrap`), `MANYTHREADS_JOB_WORKERS=0` turns them off in a process.

```ts
ctx.jobs.register('digest.send', async (payload, tx, job) => {
  // tx: ONE transaction as the SYSTEM actor (no RLS), scoped to payload.workspaceId when it is a string.
  // Throw to roll it back; the worker retries with backoff (default 5 attempts), then dead-letters. Be idempotent.
}, { concurrency: 2, maxAttempts: 5 });
await ctx.jobs.enqueue(tx, 'digest.send', { workspaceId: tx.actor.workspaceId, teamId }, { dedupeKey: `digest:${teamId}` });
```

`enqueue` happens in the caller's transaction (the job exists when it commits); a `dedupeKey` returns the waiting or running job instead of adding
a second. The handler sees whatever was enqueued: validate the payload and re-check access, because nothing else does.

### HTTP routes

Routes are mounted at the absolute `path` you declare (spec paths such as `/api/channels/:channelId/messages`); two plugins declaring the same method + path fail at load, naming both. Give the server what it needs to validate and protect them:

```ts
ctx.http.route({
  method: 'POST',
  path: '/api/echo',                           // -> POST /api/echo
  schema: { body: z.strictObject({ message: z.string().min(1) }), response: z.object({ echoed: z.string() }) },
  rateLimit: { limit: 60, windowMs: 60_000 },  // per caller, in server memory, per replica
  handler: (req, tx) => ({ body: { echoed: (req.body as { message: string }).message } }),
});
```

- A body or query that fails its Zod schema is `400` with `{ error: { code: 'validation_failed', message, path, details } }`.
  Use `z.strictObject` for bodies so unknown keys are rejected.
- A handler result that fails `schema.response` is a `500` and is logged: it is your bug, never sent to the client.
- Over the limit is `429 rate_limited`. Counters live in the process, so with N replicas each allows the full limit.
- Routes need a signed-in actor. `public: true` opts a route out (health-like or test routes); it then runs as an
  anonymous actor that RLS lets see nothing.
- Real callers authenticate with the session cookie (`manythreads_session`); unsafe methods (POST, PUT, PATCH, DELETE) on a
  cookie-authenticated request also need the double-submit `x-csrf-token` header or they are `403`. The handler's `tx` runs as
  that person. `req.caller` (actor id, person id, session id) and `req.headers` / `req.ip` are on the request.
- Tests send `x-manythreads-dev-actor: {"kind":"person","id":"<uuid>","workspaceId":"<uuid>"}`, honoured **only** when
  `NODE_ENV=test`, or use real sessions; see [../testing.md](../testing.md).
- Throw `HttpError(status, code, message)` (from `@manythreads/sdk`) to answer with the error envelope; the transaction rolls
  back. Return `{ status, body, headers }` instead to keep the writes. `setSession` / `clearSession` on the response set or
  clear the session cookies (sign-in plugins only).

### Events

Event types are `domain.noun.verb` and must exist in the registry in `packages/shared/src/events` (the registry is the
only place a payload shape is defined). `emit` validates, writes `events` and `outbox` in your transaction and throws
(writing nothing) on an invalid payload. Subscribers run from the outbox, at least once; make effects idempotent. The
host dedupes per subscriber, so a handler's own transaction is the unit of exactly-once effect.

## Migrations with RLS

One SQL file, one manifest line (`migrations: 'migrations'`). Files are `NNNN_name.sql`, forward-only, never edited
after they are applied (the runner checks checksums and stops the start naming the file). Rules (PLAN D3):

- `uuid PRIMARY KEY DEFAULT uuidv7()`, `timestamptz`, `text` (never `varchar`), enums as `text` + `CHECK`, every FK indexed.
- Every team- or person-scoped table: `ENABLE` **and** `FORCE ROW LEVEL SECURITY` plus a policy, otherwise `pnpm test:rls`
  fails and names the table. A truly global table must be on the `global_tables` allowlist with a comment.
- **Read policies hoist visibility (see "Visibility sets").** Never call `app.can()`/`can_in_team()`/`is_team_member()` per row in a
  `SELECT` policy of a table that grows.
- Every such table also carries `COMMENT ON TABLE app.x IS 'rls: team|person|workspace|system|global'` (free text may
  follow the kind); `pnpm test:rls` reports a missing or unknown kind. Policies go through the helpers of schema `app`
  (`is_team_member`, `team_role`, `is_workspace_admin`, `can(type, id, permission)`, `can_in_team(team_id, permission)`);
  a policy cannot look its own new row up by id, so write policies judge the row's `team_id` (`can_in_team`).
- `GRANT` `manythreads_app` only what requests need.

```sql
CREATE TABLE app.tasks_task (id uuid PRIMARY KEY DEFAULT uuidv7(), team_id uuid NOT NULL, title text NOT NULL);
CREATE INDEX tasks_task_team ON app.tasks_task (team_id);
ALTER TABLE app.tasks_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tasks_task FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE app.tasks_task IS 'rls: team — T: tasks of one team.';
CREATE POLICY tasks_task_select ON app.tasks_task FOR SELECT
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY tasks_task_write ON app.tasks_task FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR app.can_in_team(team_id, 'post'));   -- one row: the per-row helper is fine here
GRANT SELECT, INSERT ON app.tasks_task TO manythreads_app;
```

### Visibility sets: hoist a `uuid[]` of ids the caller may see

A policy that runs a `STABLE` function per row costs 70 to 250 microseconds a row: on 300,000 rows an unscoped `count(*)` took 77 s
(P2 gate), and counts, unread badges, listings and search all hit it. What the caller may see does not depend on the row, so compute it
**once per statement** as an array and let the policy probe it. The scalar subquery becomes an InitPlan, and `col = ANY (InitPlan)` can drive an index scan:

```sql
USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))
```

| Helper (kernel 0011, `SECURITY DEFINER`, `STABLE`, answers only about the caller) | Returns |
|---|---|
| `app.readable_team_ids(permission)` | teams the caller sits in at `>= permission` (`read`, `post`, `manage`); a workspace owner/admin gets every team of the workspace; a guest, a suspended person, the system or no actor gets `{}` |
| `app.member_team_ids(permission)` | the same without the admin override: "members only" tables (events, entity links, capability grants) |
| `app.acl_grant_ids(resource_type, permission)` | ids of that resource type the caller holds an `acl_entries` grant on, as a person, a member of a granted team, or a holder of a granted role (grants only: combine with the team set) |
| `app.held_role_ids()` | role tags the caller holds |

```sql
-- team rows readable by team access OR by an ACL grant (the stub_resources policy of the test-kernel plugin):
USING ((SELECT app.is_system())
   OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
   OR (workspace_id = (SELECT app.workspace_id()) AND id = ANY ((SELECT app.acl_grant_ids('stub_resource', 'read'))::uuid[])))
```

Rules of the idiom:

- Wrap **every** caller-dependent call in `(SELECT ...)`, `app.is_system()` and `app.workspace_id()` too: a bare call is evaluated per row (0.45 s on 300,000 rows; wrapping took the
  three benchmark counts from 0.5 s to 0.05 s).
- The array is fixed when the statement starts. `INSERT ... RETURNING` is checked against the SELECT policy, so a row the statement itself makes visible
  (a new team, a new private channel) is not in the array: give the policy a second branch that does not look the row up (as `teams_select` does for admins), or do not `RETURNING`.
- **Not team-based visibility (private channels, DMs: one membership row per channel).** Same idiom with a helper of your own: a `SECURITY DEFINER` function owned by
  `manythreads_system` (migration pattern of kernel 0006/0011), caller from `app.actor()`, checked with `app.lookup_*` (never `is_*`, which are always true inside a definer
  owned by the system role), returning the ids the caller may see (`channels` will ship `app.visible_channel_ids()`), and `channel_id = ANY ((SELECT app.visible_channel_ids())::uuid[])` in the policy.
- Single-row checks (a route, an INSERT/UPDATE `WITH CHECK`) keep `app.can()` / `app.can_in_team()`.
- `pnpm test:rls` enforces it: `findPerRowPolicyCalls` (test-utils) runs `EXPLAIN (VERBOSE)` of `SELECT count(*)` as `manythreads_app` for every table and fails one whose plan
  calls `app.can`, `can_in_team`, `is_team_member`, `team_role` or `has_role` outside an InitPlan. A table that is genuinely per row goes on the allowlist in
  `packages/kernel/test/rls/harness.test.ts` with a reason. Benchmark: `pnpm --filter @manythreads/tools-bench bench:rls` (300,000 rows, each unscoped count must stay under 2 s).

Plugins never get a pool: handlers receive a `PluginTx` bound to the acting person or bot, so RLS decides what rows exist.

## Capabilities

Declare `{ name: 'namespace.verb', destructive }` in the manifest, then bind code with
`ctx.capabilities.register(name, handler)`. Bots call capabilities through the broker, which checks grants, denies bot
writes to `bots/`, `TEAM.md`, `skills/`, `routines/`, allows `person:*` only for `conversation` and `mention` triggers,
and logs every denial as a `kernel.capability.denied` event. Mark anything that deletes or sends as `destructive: true`.

## Scoped storage

`ctx.storage` is key-value storage namespaced to your plugin and scoped to a `workspace`, `team` or `person`:
`get(scope, key)`, `set(scope, key, json)`, `delete(scope, key)`. It lives in `app.scoped_kv`. Use it for small settings,
not for records (use a migration).

## Testing

- Unit: build the definition with `definePlugin`, load it with `loadPlugins({ plugins: [{ definition }] })` (no DB) to check
  ordering and registration.
- Integration (Vitest): `startTestServer()` from `@manythreads/test-utils` gives a fresh migrated database and a server on a
  random port with dev auth on. Helpers: `readAs(persona, fn)` runs queries as Omar, Nadia, Rafi, Sameera, Tariq, Priya
  or Lena under RLS; `captureEvent(type, fn, { pool })` returns the event `fn` emitted.
- API (Playwright `request`): `pnpm e2e --project=api` starts the server with `MANYTHREADS_TEST_PLUGINS=1` on a fresh database.
  `packages/plugins/test-kernel` is the reference for echo, rate limit and event round trips.
- `pnpm test:rls` proves every table has RLS; `pnpm lint` and `pnpm typecheck` must stay green.

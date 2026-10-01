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
| (always available) | `ctx.http.route(def)`, `ctx.capabilities.register(name, handler)`, `ctx.storage` |

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
- Until phase 2 adds sign-in, tests and local dev send `x-manythreads-dev-actor: {"kind":"person","id":"<uuid>","workspaceId":"<uuid>"}`.
  The server honours it **only** when `NODE_ENV=test` or `MANYTHREADS_DEV_AUTH=1`; phase 2 deletes it.

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
CREATE POLICY tasks_task_team ON app.tasks_task
  USING (app.is_team_member(team_id)) WITH CHECK (app.is_team_member(team_id));
GRANT SELECT, INSERT, UPDATE ON app.tasks_task TO manythreads_app;
```

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

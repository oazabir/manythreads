# example-hello

The smallest useful plugin: one capability, one event subscription, one team-scoped table with RLS.
Copy `packages/plugins/example-hello` to start a plugin.

## What a plugin is

A package with a `manythreads.entry` field in `package.json` whose entry default-exports `definePlugin({ manifest, register })`.
Plugins import only `@manythreads/sdk` and `@manythreads/shared`, never kernel internals.

## Add a table with RLS: one SQL file, one manifest line

1. Write `migrations/0001_<name>.sql` (plain SQL, numbered, forward-only). Every team- or person-scoped table needs
   `ENABLE` and `FORCE ROW LEVEL SECURITY` plus a policy, or `pnpm test:rls` fails and names the table.
2. Add `migrations: 'migrations'` to the manifest. The host runs the directory through the migration runner with
   the plugin name as namespace (`example-hello/0001_hello_greetings.sql` in `app.schema_migrations`).

```sql
CREATE TABLE app.hello_greetings (id uuid PRIMARY KEY DEFAULT uuidv7(), team_id uuid NOT NULL, message text NOT NULL, ...);
ALTER TABLE app.hello_greetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.hello_greetings FORCE ROW LEVEL SECURITY;
CREATE POLICY hello_greetings_team ON app.hello_greetings
  USING (app.is_team_member(team_id) OR app.is_system());
GRANT SELECT, INSERT ON app.hello_greetings TO manythreads_app;
```

## Manifest

| Field | Value |
|---|---|
| name / version / kind | `example-hello` / `0.1.0` / `server` |
| extends | `event.subscribe` |
| capabilities | `hello.greet` (not destructive) |
| events | consumes `channel.message.posted`, emits nothing |
| migrations | `migrations` |

A plugin may only use extension points listed in `extends`; calling another one from `register` throws, naming the
plugin and the point. `events.subscribe` also requires the type to be in `events.consumes`, and `events.emit`
requires it in `events.emits`.

## Capabilities

`hello.greet` inserts a greeting for a team. Capability names are `namespace.verb` with a destructive tag; destructive
capabilities can never be granted to a bot. Bots need an allowlist entry in `app.capability_grants`.

## Events

Consumes `channel.message.posted` (schema v1): inserts a greeting row for the message's team.

## Extension points

Only `event.subscribe`. See SPEC-FINAL section 3 for the full list the SDK context exposes.

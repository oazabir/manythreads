# connections

A team's links to outside services, and the tools a bot gets from them. A **connection** is a named place (a mailbox, later a code host or a drive) with the credentials that open it, kept sealed. A **grant** says which bot may call which of its tools. This plugin is the **source** those tools come from: the bot's tool list is made of it, and a call is handed to it. It is the first source of tools that is not a built-in capability (PLAN Phase 8, P8-01 and P8-28).

Package: `packages/plugins/connections`. Manifest: `extends: ['tool.source', 'secret.seal', 'event.subscribe', 'event.emit']`, `dependsOn: ['teams', 'bots']`, migrations `connections/0001_connections.sql`; the bots plugin adds `0022_bots_connections.sql` (the `connections` column that carries what a BOT.md asked for). Consumes `bots.bot.loaded`, `bots.bot.removed` and its own `connections.connection.changed`; emits `connections.connection.changed`.

## What it is made of

| Piece | What it holds |
|---|---|
| `connections` | One row per connection: `kind` (today `email`), `slug`, `name`, `scope` (`team`, `person` or `workspace`), the team (team scope only), the owner, `status` (`disabled` until credentials are put in and someone turns it on), an optional expiry, an environment tag (`production`, `staging`, `development`, `test`) and `has_credentials` (a yes or no, kept by the database, never the credentials themselves). |
| `connection_grants` | One row per bot and tool: the connection, the bot's actor and the tool name. (It also carries a `needs_approval` column, informational only: the one gate that makes a call wait for a person is `capability_grants.needs_approval`, the broker's row the compile writes beside this one.) A bot has at most one grant per tool, so it is never unclear which connection answers. |
| `connection_secrets` | The credentials, one row per name (`password`, `token`, ...), each a pointer to a sealed secret of the platform's own secret service. |

### Credentials

* Sealed with the same service every other secret uses (`ctx.secrets`, phase 2): envelope encryption, the key outside the database. This plugin keeps no cipher of its own.
* **No read-back.** No route, event, audit line, log line or error text carries a credential, and the API's `Connection` has no field that could (`hasCredentials` says only whether any exist). The only reader is the code that opens the connection for a tool call, and it asks for the credential at the moment it needs it.
* `connection_secrets` has no grant to the application database role at all: a person's or bot's session cannot select it even with a bug in a policy. Only the system role reads it, and only inside one workspace.
* A sealed secret never outlives the row that pointed at it. Deleting a connection through the plugin removes its sealed secrets in the same transaction, and a database trigger on `connection_secrets` (`connection_secrets_reap`, after delete) removes the sealed value of any credential row that goes, including rows that go by cascade when a team, an owner or a workspace is deleted. A test covers the direct, connection, team and workspace paths.

### Who sees and changes what (row-level security, forced on all three tables)

* A **team** connection is visible to the members of that team; a **workspace** connection to workspace admins; a **person** connection to its owner alone. Nothing crosses a workspace.
* Creating or changing a team or workspace connection takes a workspace admin. A person's own connection is theirs to change. The team, scope, owner, kind and slug of a row never change after it is made, and an ordinary session can never set `has_credentials` (a database guard enforces it).
* Grants are visible to the team's members. Only the system writes them (the compile below), so a person cannot grant a bot a tool by writing a row.
* Deleting a connection is a system act. A bot that leaves its team, or is removed, loses its grants with its team membership.

## The tools

A kind says which tools it serves. Today: `email.read`, `email.draft`, `email.send`. All three are declared in the manifest, none is destructive. A tool that deletes outside data is not offered through a connection at all: the compile skips it and the broker never grants a destructive tool. A test (`test/destructive-lint.test.ts`) fails if a destructive tool appears among what a connection serves or in any template bot's `capabilities.connections`.

**Arguments are checked.** Each tool has a strict zod schema in `src/kinds.ts`; the JSON Schema a model is shown is generated from it, and the source parses a call's input with it (unknown field, wrong type, missing field, value past its limit) before any kind sees the input. A refusal is `validation_failed`, names the fields and never repeats a value.

The `email` kind is a **stub** until the mail transport exists (P8-29): a call that gets all the way through answers `{ ok: false, code: 'not_available', message: 'This mailbox is not connected to a mail service yet, ...' }`. Everything around the call is real: the listing, the grant, the broker, the approval, the run, the row-level checks.

## How a BOT.md reaches a grant

```yaml
capabilities:
  native: [messages.post]
  connections:
    - name: support-mail
      tools: [email.read, email.draft, email.send]
approvals:
  needsApproval: [email.send]
```

1. The bots loader reads the file and writes the bot's row and, in `bots.connections`, the list of `{ connection, tools, needsApproval }`.
2. It emits `bots.bot.loaded`. This plugin's subscriber compiles that row, as the system, after the loader's commit. The compile is idempotent: a repeat changes nothing.
3. For each named team connection it writes a `connection_grants` row and the matching `capability_grants` row (the broker's table), with the connection's slug in the grant's constraints. A tool the bot no longer names loses both rows; a bot that is removed loses all of them.
4. A tool is **skipped** (never granted, logged without any credential) when: the connection does not exist on the bot's own team, the connection's kind does not serve the tool, the tool is not a declared capability, it is destructive, or the name is a wildcard. `person:*` (the person's own connections) is not built yet (P8-02) and is skipped too.

**A tool is in `native` or in `connections`, never both.** The BOT.md schema refuses a file that has the same tool (or a `namespace.*` wildcard that covers it) in both lists, and names the field. The same tool through two different connections is refused too. The two lists never share a grant row.

## How a call goes

The MCP gateway ([gateway-mcp.md](./gateway-mcp.md)) asks the registry of tool sources, not this plugin by name.

* **Listing** (`tools/list`): a tool is offered when the capability broker allows the bot **and** the source says yes. The source says yes when the bot has a grant on a team connection that is on (`status = enabled`), not expired, has credentials, and whose kind serves the tool. If the source throws, nothing is offered (fail closed).
* **Calling** (`tools/call`): the broker authorizes first (grant, destructive tag, approval). A tool that needs approval waits for a person exactly as a built-in one does, and when approved it runs through the same source. Only then is the call handed to the source, which checks again, in the caller's own transaction: the grant exists, the connection is usable, the kind serves the tool. A read runs as the person who asked, a write as the bot (the same rule as every tool), so a tool can never reach a connection its caller could not see.

### Whose rights a call uses

* **Listing** is judged as the **bot**: the source is asked in a transaction as the bot, so only grants the bot itself can see are offered.
* **Reads** are additionally gated by the **asker's** visibility at call time: a read runs in the transaction of the person who asked, so if that person cannot see the grant and connection (they left the team), the call is refused with the same answer as no grant.
* **Writes** run **as the bot** (intended rule, the same as every other write tool): the bot's grant is what counts, and a write that must wait for a person does so through the broker's approval.
* Every successful read also leaves a `connection` line in the run's source log, so the retention rule sees it (see [gateway-mcp.md](./gateway-mcp.md)).
* A tool is named in `approvals.needsApproval` either exactly (`email.send`) or by a `namespace.*` wildcard (`email.*`), with the same meaning as in `capabilities.native`.

### bot capabilities ∩ asker visibility

For every source there is one shared test that proves the rule in four states (granted or not, visible to the asker or not): `describeToolSourceIntersection` in `packages/test-utils/src/tool-source-intersection.ts`. A new source (drives, a code host, knowledge) runs it as its first test. Connections run it for `email.read` (a read) and `email.draft` (a write).

## The routes (P8-06)

| Route | Who | What |
|---|---|---|
| `GET /api/teams/:slug/connections` | members of the team | The team's connections, never a credential (`hasCredentials` says only that one is stored). |
| `GET /api/me/connections` | the signed-in person | Their own connections and nobody else's. |
| `POST /api/teams/:slug/connections` | workspace admin | Adds one: `kind`, `name`, optional short name (`slug`, made from the name when left out, with `-2`, `-3` for a repeat), `environment`, `expiresAt`. It starts switched off with nothing stored. A short name already taken answers 409; an unknown kind 400; a kind that is not available yet (Kubernetes) 409 with its reason. |
| `PATCH /api/connections/:id` | workspace admin (team), the owner (person) | Name, switch (`enabled`/`disabled`), environment, end date. Switching on with nothing stored answers 409 ("Put the credential in first"). The kind, short name and team never change. |
| `PUT /api/connections/:id/credentials/:name` | same | Stores or replaces one credential, sealed. The answer is the connection, not the value. A name the kind does not have answers 400. |
| `DELETE /api/connections/:id` | same | Removes the connection, its sealed credentials and the broker rows that came from it (a subscriber of `connections.connection.changed` with `change: deleted` removes the `capability_grants` that named it). |

Everyone who is not a workspace admin and tries to add or change a team's connection gets 403 with one sentence (`CONNECTION_ADMIN_ONLY` in `@manythreads/shared`): "Only a workspace admin can add or change a team's connections. Ask one of them to set it up." The screens show the same sentence.

**A connection is made in three calls.** The credential is sealed in a separate transaction (the table is closed to the application role), which cannot see a connection the request has not committed yet, so the client creates the connection, then puts the credential in, then switches it on. The Add connection dialog does the three in a row and, if a later one fails, says which step is still to do; Change finishes it.

**The kinds a person can choose** are in `@manythreads/shared` (`CONNECTION_KINDS`): the Mailbox (available; its tools are in `CONNECTION_KIND_TOOLS`, kept equal to this plugin's `TOOLS` by a test) and the Kubernetes cluster, which is listed but shut, with its reason, until the cluster broker exists. The plugin has no Kubernetes kind.

### Events and audit

Every add, change, switch, credential put and removal emits `connections.connection.changed` (v1): the ids, the short name, the kind, the scope, the actor and `change` (`created`, `updated`, `switched`, `credential_set`, `deleted`). It has no field for a credential or a display name. The audit plugin turns it into `connection.created`, `connection.updated`, `connection.switched`, `connection.credential_set` and `connection.deleted` lines. The event is emitted before the credential is written, so a failed write leaves a line rather than a silent change.

### The screens

* Team settings → **Connections** (`/settings/team/:slug/connections`): the list for every member of the team; Add connection, Change, switch and Remove for a workspace admin only; the sentence above for everyone else.
* Account → **Connections** (`/account/connections`): a person's own connections, with Remove, and the mail option that says mail arrives with the mail transport. There is no way to add a person's own connection yet.
* The bot page's **Capabilities** tab shows, under each connection named in the definition, whether the team has a connection of that name and whether it is on, off, expired or has no credential yet.

## Not yet

* `person:*` (a person's own connections for a conversation or a mention) and workspace-scoped grants to a bot (P8-02); adding a person's own connection.
* A real mail transport (P8-29).
* A Kubernetes kind (the cluster broker).

# connections

A team's links to outside services, and the tools a bot gets from them. A **connection** is a named place (a mailbox, later a code host or a drive) with the credentials that open it, kept sealed. A **grant** says which bot may call which of its tools. This plugin is the **source** those tools come from: the bot's tool list is made of it, and a call is handed to it. It is the first source of tools that is not a built-in capability (PLAN Phase 8, P8-01 and P8-28).

Package: `packages/plugins/connections`. Manifest: `extends: ['tool.source', 'secret.seal', 'event.subscribe', 'event.emit']`, `dependsOn: ['teams', 'bots']`, migrations `connections/0001_connections.sql`; the bots plugin adds `0022_bots_connections.sql` (the `connections` column that carries what a BOT.md asked for). Consumes `bots.bot.loaded`, `bots.bot.removed` and its own `connections.connection.changed`; emits `connections.connection.changed`.
Package: `packages/plugins/connections`. Manifest: `extends: ['tool.source', 'secret.seal', 'event.subscribe', 'event.emit', 'job.register']`, `dependsOn: ['teams', 'bots', 'channels']`, migrations `connections/0001_connections.sql`, `0002_mail.sql` (mail), `0003_person_connections.sql` (a person's own sign-ins) and `0004_mail_hardening.sql` (which claim is behind a run; replies bound to it); the bots plugin adds `0022_bots_connections.sql` (the `connections` column that carries what a BOT.md asked for). Consumes `bots.bot.loaded`, `bots.bot.removed` and `channel.message.posted`; emits `connections.inbox.claimed` (ids only).

## What it is made of

| Piece | What it holds |
|---|---|
| `connections` | One row per connection: `kind` (today `email`), `slug`, `name`, `scope` (`team`, `person` or `workspace`), the team (team scope only), the owner, `status` (`disabled` until credentials are put in and someone turns it on), an optional expiry, an environment tag (`production`, `staging`, `development`, `test`) and `has_credentials` (a yes or no, kept by the database, never the credentials themselves). |
| `connection_grants` | One row per bot and tool: the connection, the bot's actor and the tool name. (It also carries a `needs_approval` column, informational only: the one gate that makes a call wait for a person is `capability_grants.needs_approval`, the broker's row the compile writes beside this one.) A bot has at most one grant per tool, so it is never unclear which connection answers. |
| `connection_secrets` | The credentials, one row per name (`password`, `token`, ...), each a pointer to a sealed secret of the platform's own secret service. |
| `connection_messages` | The **mailbox** of a mail connection (the dummy transport's, see below): one row per mail that arrived (`in`), was sent (`out`) or was saved and not sent (`draft`). |
| `connection_mail_claims` | One row per bot per mail thread: the bot's `inbox` trigger claimed the thread, and one run was opened for it. Remembers the bot's post about the thread (see "The inbox trigger"). |

### Credentials

* Sealed with the same service every other secret uses (`ctx.secrets`, phase 2): envelope encryption, the key outside the database. This plugin keeps no cipher of its own.
* **No read-back.** No route, event, audit line, log line or error text carries a credential, and the API's `Connection` has no field that could (`hasCredentials` says only whether any exist). The only reader is the code that opens the connection for a tool call, and it asks for the credential at the moment it needs it.
* `connection_secrets` has no grant to the application database role at all: a person's or bot's session cannot select it even with a bug in a policy. Only the system role reads it, and only inside one workspace.
* A sealed secret never outlives the row that pointed at it. Deleting a connection through the plugin removes its sealed secrets in the same transaction, and a database trigger on `connection_secrets` (`connection_secrets_reap`, after delete) removes the sealed value of any credential row that goes, including rows that go by cascade when a team, an owner or a workspace is deleted. A test covers the direct, connection, team and workspace paths.

### Who sees and changes what (row-level security, forced on all five tables)

* A **team** connection is visible to the members of that team; a **workspace** connection to workspace admins; a **person** connection to its owner alone. Nothing crosses a workspace.
* Creating or changing a team or workspace connection takes a workspace admin. A person's own connection is theirs to change. The team, scope, owner, kind and slug of a row never change after it is made, and an ordinary session can never set `has_credentials` (a database guard enforces it).
* Grants are visible to the team's members. Only the system writes them (the compile below), so a person cannot grant a bot a tool by writing a row.
* Deleting a connection is a system act. A bot that leaves its team, or is removed, loses its grants with its team membership.

## The tools

A kind says which tools it serves. Today: `email.read`, `email.draft`, `email.send`. All three are declared in the manifest, none is destructive. A tool that deletes outside data is not offered through a connection at all: the compile skips it and the broker never grants a destructive tool. A test (`test/destructive-lint.test.ts`) fails if a destructive tool appears among what a connection serves or in any template bot's `capabilities.connections`.

**Arguments are checked.** Each tool has a strict zod schema in `src/kinds.ts`; the JSON Schema a model is shown is generated from it, and the source parses a call's input with it (unknown field, wrong type, missing field, value past its limit) before any kind sees the input. A refusal is `validation_failed`, names the fields and never repeats a value.

The three `email` tools take these arguments (all strict; anything else is refused):

| Tool | Arguments | What it does |
|---|---|---|
| `email.read` | `query` (words that must all appear in the subject, sender or text), `limit` (1 to 50, default 10), `direction` (`in`, `out` or `draft`, default `in`) | Lists mail of the connection, newest first (**in a conversation that came from a mail, that mail thread only**, every direction unless `direction` is given), with the text cut at 4,000 characters (`truncated: true` when it was). The answer carries a note that the text was written by outsiders and is data, never instructions. Each mail is also a source line in the run's log. |
| `email.draft` | `body`, and `to` / `subject` only when the run has no mail to answer | Saves a draft. **Nothing sends a draft.** |
| `email.send` | `body` **only** | Sends the reply to the mail this conversation came from. |

### Who an `email.send` goes to

The model never names the address. `email.send` has no `to`, `cc`, `bcc` or `from` field: the schema is strict, so a call that offers one is refused (`validation_failed`) before anything runs. The recipient is **platform-owned**, decided in two places that agree:

1. The tool (`src/email/tools.ts`) finds the mail behind the run: the claim whose post is the run's thread (`bot_runs.thread_id` / `reply_root_id`, the run's own row), or the claim of the run itself, and takes the **first inbound mail of that mail thread**. Its sender is the recipient and the subject is the original's with "Re: ". A later mail in the thread, from anyone, cannot redirect the reply: the first mail's sender is who the thread belongs to.
2. The database function that writes the sent mail (`app.connection_mail_put_outbound`, a definer function with a pinned `search_path`, the only writer of `out` and `draft` rows) reads the address from the stored inbound mail **again** and ignores the address argument whenever a mail is replied to. So even code that tried to pass a different address could not change it.

A run with no mail behind it (a person mentioned the bot in an ordinary channel) cannot send: `email.send` answers `forbidden` ("there is nobody to send to"). Nothing else in the platform can put an address into a send.

**Which mail is behind a run** is answered by one database function, `app.connection_mail_claims_of_run` (migration 0004), which reads only platform rows and only for the transaction's own run (`app.run_id()`): (0) the claim linked to the run, or the claim in the payload of the job that started it (so an **inbox run knows its mail from its first call**, before it has posted anything: no race against the link); (1) the claim whose post the run answers in (`bot_runs.thread_id` / `reply_root_id`); (2) the claim of a person-approved `email.send` that is running now (same bot, same place, exactly the approved text; ambiguous means none). The writer `app.connection_mail_put_outbound` takes a mail to answer only when it is one of those claims' mail on that connection, and refuses a connection that is switched off or past its end.

**In a run that has a mail behind it, `email.send` always waits for a person**, whatever the bot's grant says: the source's `approval` hook (SDK `ToolSource.approval`, asked by the MCP gateway before the call) returns a card made from the stored mail, `email.send · reply to <sender>`, with `to`, `subject` and `body` in the preview. The model's words cannot change the recipient shown. An approved send resumes through the approvals job (route 2 above) and goes to the same sender. A grant's own `needsApproval` still applies to runs with no mail behind them.

## The mail transport and the dummy mailbox

`EmailTransport` (`src/email/transport.ts`) is the one interface the `email` kind talks to a mailbox through: `list`, `fetch`, `send`, `draft`. The tools and the inbox watch are written against it, so a real transport (IMAP, Gmail, Outlook; P8-02, P8-03) implements those four members and nothing above it changes. A transport only delivers what it is given: the recipient is decided above it.

The **dummy transport** (`src/email/dummy.ts`) is what exists today: its mailbox is the `connection_messages` table, read in the caller's own transaction (so the caller's row-level security decides what it sees). Tests and the support journey use it.

* **Reading** the mailbox: the people of the connection's team and its bots, never a guest. A mail is stored as it came and never changes.
* **Delivering a mail** (`POST /api/teams/:slug/connections/:connection/mail`, the *delivery door*): **workspace owners and admins only**. Body `{ from, to, subject, body, messageRef?, inReplyTo?, folder? }`. A mail with an `inReplyTo` that the mailbox holds joins that thread; any other starts its own (the thread is the first mail's `messageRef`). The same `messageRef` twice is one mail: the second answer is `200` with `duplicate: true`. A new mail answers `201` and asks the inbox watch to look at the connection at once. The door is the dummy's way in; a real transport reads its provider instead.
* **Writing** `out` and `draft` rows is done only by `app.connection_mail_put_outbound`, which checks that the caller holds the grant for that tool on that connection (a bot with no grant writes nothing, whatever it calls). What is sent is from `<connection>@mail.manythreads.invalid`.
* A connection must still look usable to be offered (switched on, not expired, `has_credentials`), so a dummy mail connection needs a **placeholder credential** stored like a real one. Nothing reads it.

### The workspace mailbox for team inboxes (P8-19)

Team memory inboxes take mail on one workspace-wide `email` connection with the short name `inbox` (`src/email/inbox-door.ts`). `POST /api/workspace/inbox-mail` (workspace owners and admins only; 403 otherwise) finds or makes it, switches it on when it was off, and leaves the usual `connections.connection.changed` audit line (`created` or `switched`); the answer is `{ connection: { slug, name }, created, domain }` (201 the first time, 200 after). It holds no credential and stores no mail: the **memory-inbox plugin** owns the address (`inbox+<team>@<MANYTHREADS_MAIL_DOMAIN>`), the delivery route and the sender check, and only looks the connection up. It does not use the dummy mailbox or the inbox trigger above, so a mail to a team address starts no bot run. A slug `inbox` that already belongs to a connection of another kind is a 409. See `docs/plugins/memory-inbox.md`, "Email to the team's address".

## The inbox trigger

A bot whose BOT.md lists `- type: inbox` is woken by mail, not by a message in a channel:

```yaml
triggers:
  - type: inbox
    connection: support-mail   # optional: any mail connection of the team when left out
    folder: INBOX              # optional, default INBOX
    filter: refund             # optional: words that must ALL appear in the subject or the sender, any case
    channel: "#support"        # optional: where the bot posts about a new mail thread
```

How a mail becomes **one** run:

1. **Watch** (`src/watch.ts`): a job on queue `connections.inbox-watch`, every minute for every workspace and at once for one connection when the delivery door takes a mail. It asks each watched connection's transport for the newest inbound mail of the last 48 hours (at most 200). A bot is watched when it is active, has an `inbox` trigger naming the connection (or none), the connection is usable, **and the bot holds `email.read` on it** (the mail's text goes into the bot's prompt, so the bot must be one that may read it).
2. **Dedupe by mail thread, per bot**: the first matching mail of a thread inserts a claim (`connection_mail_claims` is unique on connection, bot and thread). The claim and the event `connections.inbox.claimed` (ids only: never an address, a subject or a word of the mail) are written in one transaction. The same mail twice, a poll that sees the same mail again, and a later mail in a thread the bot already claimed all find the claim and do nothing. At most 20 new threads are claimed per bot and connection per pass; the rest wait for the next.
3. **Run** (runtime-hermes, `src/router-inbox.ts`): the event becomes one run (job key = the claim). The run's payload takes `trigger: 'inbox'` and `inbox: { claimId, connectionId, mailId }`. The prompt lists the platform's facts (connection, sender, subject, time) and puts the mail's text inside one fenced block labelled as the sender's words and as data; the fence markers are defanged inside it. There is no asker (nobody asked): the bot's own rights count. The run posts at the top of the trigger's `channel`, or of the first public channel of the team the bot may post in.
4. **Link** (`src/link.ts`): when the run posts, its post carries `meta.runId` (set by the platform alone; the messages capability stamps it on a thread reply and on an **`inbox` run's** top-level post, and on no other run's top-level post, so a routine, rhythm or task run is not taken for having answered). The connections plugin sees the post and records, on the claim, the run and the post that opened the thread. That is how a later run in that thread (a person or another bot mentions the bot there) finds the mail it answers. The first post wins; a bot that posts twice does not move the link. **Only a top-level post links**: a post the bot steers into an existing thread (an explicit `threadRootId`) is never the link, so a bot steered by a mail cannot bind the claim to someone else's thread.

### Limits, stated plainly

* A follow-up mail in a thread the bot already claimed starts **no new run**. The conversation then lives in the channel thread; the follow-up stays in the mailbox for `email.read`.
* A bot that is switched on answers mail that arrived in the last 48 hours and is still unclaimed, not older mail.
* An inbox run can `email.send` from its first call (the job names its claim); the send waits for a person's approval.
* **Open item (review finding 5, volume cap).** Nothing caps how many mails a bot can read, draft or send per run, hour or day, or how many mails one mailbox may be delivered. Approval makes a send rare in a mail thread; a cap (per run and per bot per day) is still to be decided and built.
* Real mail providers, sending a draft, attachments and HTML mail are not built.

## Owner questions

* **Follow-ups.** Should a new mail in a claimed thread wake the bot again (a second run, or a message in the channel thread)? Today it does not.
* **Approval card.** Done: the card shows the recipient. Should a send in a mail thread be allowed without approval for a bot a lead has marked as trusted? Today it never is.
* **`email.send` takes no `to`.** The plan's wording was "no mail context and no `to` is refused"; this build is stricter: there is no `to` at all, and a send without mail context is refused. A bot that must write to a new person can only draft.
* **The watch needs `email.read`.** A bot with an `inbox` trigger and no `email.read` grant is not woken. Right, or should it be woken without the text?
* **The `channel` field** on the trigger is new (additive in the BOT.md schema).

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
4. A tool is **skipped** (never granted, logged without any credential) when: the connection does not exist on the bot's own team, the connection's kind does not serve the tool, the tool is not a declared capability, it is destructive, or the name is a wildcard.  `person:*` entries are compiled separately (see [A person's own connections](#a-persons-own-connections)); a tool that is not one of the person tools is skipped there as `tool_not_personal`.

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

For every source there is one shared test that proves the rule in four states (granted or not, visible to the asker or not): `describeToolSourceIntersection` in `packages/test-utils/src/tool-source-intersection.ts`. A new source (drives, a code host, knowledge) runs it as its first test. Connections run it for `email.read` (a read) and `email.draft` (a write), and for a person's own connection with `google_drive.search` (a read) and `google_calendar.create_event` (a write).

## A person's own connections

A person can connect their own **Google**, **Microsoft 365** and **Notion** account (PLAN P8-02). The connection belongs to that person alone (row-level security shows it to nobody else, not a lead or an admin). A bot uses it only for a run that this person asked, in a conversation or a mention: never for a run that nobody asked (a schedule, a webhook), and never another person's.

### Signing in

One piece of code does the OAuth sign-in for all three providers (`src/oauth/flow.ts`, with each provider's differences in one table, `src/oauth/providers.ts`). It is the authorization code flow with a PKCE proof (a one-time secret that ties the code to the browser that asked, so a stolen code is useless), a random single-use `state` that is bound to the signed-in person and runs out after 10 minutes, and no redirect is followed on any call to a provider. Notion has no PKCE; its sign-in relies on the `state` and the app's secret.

| Route | What it does |
|---|---|
| `GET /api/me/connections/providers` | The three providers: whether the server is set up for it (`configured`), whether the caller has connected it, `needs_reconnect` when the provider stopped honouring the sign-in, the account's address, the redirect address an admin registers, and the services each offers (with the tools it gives and whether any of them writes). |
| `POST /api/me/connections/:provider/start` | `{ services?, returnTo? }` gives `{ url }`: where to send the browser (the provider's consent page). Without `services`, the read-only set is asked for. Answers a plain **409** when the server has no app for the provider. |
| `GET /api/me/connections/:provider/callback` | Where the provider sends the browser back. The answer is a redirect to `returnTo` (a path of this site, default `/settings/connections`) with `connected=<provider>` or `connect_error=` set to `denied`, `expired`, `failed`, `not_configured` or `wrong_person`. The sign-in must finish as the person who started it. |
| `DELETE /api/me/connections/:provider` | Tells the provider to forget the token (best effort), then deletes the connection and every sealed token. |

All four are limited per person (`docs/deploy/rate-limits.md`). No answer, log line or event carries a token.

**What the server needs.** An admin makes an app at each provider and puts its id and secret in the server's environment (names only here; the values are never committed): `MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID` and `MANYTHREADS_OAUTH_GOOGLE_CLIENT_SECRET`, the same two with `MICROSOFT` and with `NOTION`, and optionally `MANYTHREADS_OAUTH_MICROSOFT_TENANT` (default `common`). The redirect address to register is `<public address of the site>/api/me/connections/<provider>/callback`; `GET /api/me/connections` shows the exact one. Until both values exist the start route answers 409. (Typing these in a screen instead is the later workspace-settings work, P16-02.)

**Tokens.** The access token and the refresh token are sealed with `ctx.secrets` like every other connection secret and live in `connection_secrets`. Table `connection_oauth` (what the person agreed to, the account's address, when the access token ends, and `ok` or `needs_reconnect`) holds no token. Unfinished sign-ins live in `connection_oauth_flows` (the state is kept only as a hash; the application role has no access to it).

**Keeping it alive.** The access token is renewed when it is used and has under a minute left, or when the provider answers 401. The renewal holds the connection's row for its whole length, so many calls at once renew once (a provider that rotates refresh tokens would refuse the second use of the first one). If the provider says the sign-in is no longer valid (`invalid_grant`), the connection is switched off, marked `needs_reconnect`, its tools disappear for the bot and a call says the person has to connect again; connecting again fixes it. A provider that is down changes nothing. Notion's token does not expire.

**More services later.** A second sign-in for another service adds to what the person already agreed to, on the same connection (Google's `include_granted_scopes`; the plugin keeps the union).

### Services, scopes and tools

A person ticks services; each one is a set of the provider's scopes. A tool is offered to a bot only when the run's asker agreed to its service.

| Provider | Service (ticked by default: read-only ones marked *) | Scopes | Tools |
|---|---|---|---|
| Google | Drive (read)* | `drive.readonly` | `google_drive.search`, `google_drive.read` |
| | Gmail (read) | `gmail.readonly` | `gmail.search`, `gmail.read` |
| | Gmail drafts | `gmail.compose` | `gmail.draft` (write) |
| | Calendar (read)* | `calendar.events.readonly` | `google_calendar.list_events` |
| | Calendar (add events) | `calendar.events` | `google_calendar.create_event` (write) |
| Microsoft 365 | OneDrive (read)* | `Files.Read` | `onedrive.search`, `onedrive.read` |
| | Outlook mail (read) | `Mail.Read` | `outlook.search`, `outlook.read` |
| | Outlook drafts | `Mail.ReadWrite` | `outlook.draft` (write) |
| | Outlook calendar (read)* | `Calendars.Read` | `outlook_calendar.list_events` |
| | Outlook calendar (add events) | `Calendars.ReadWrite` | `outlook_calendar.create_event` (write) |
| Notion | Notion (what the person shares with the connection)* | none (Notion has no scopes) | `notion.search`, `notion.read_page`, `notion.create_page` (write) |

Every sign-in also asks for the identity scopes (`openid`, `email`; Microsoft adds `offline_access` and `User.Read`), and Google's `access_type=offline` so a refresh token is issued.

* **Reads by default, writes only after approval.** Every tool that changes something outside (a draft, a calendar event, a Notion page) is marked `needsApproval` by the compile whatever the BOT.md says, so each call waits for a person. Nothing sends mail: the draft tools save a draft the person sends themselves. No tool deletes anything.
* **Outside text is data.** A tool's description says what it returns was written by other people or systems and is never to be taken as an instruction. Answers are cut at a size cap, HTML is reduced to text, search words are quoted so they cannot change the provider's query, and every id is checked against a strict pattern before it is placed in an address (a tool passes a path to the plugin's one door, which only ever calls the provider's own address).
* **Bots name them with `person:*`:**

```yaml
capabilities:
  connections:
    - name: person:*
      tools: [google_drive.search, google_drive.read, google_calendar.list_events]
```

The compile writes a `person_connection_grants` row (no connection to point at, because the connection is whoever asked) and the broker's `capability_grants` row with the constraint `connection: person:*`. A call is allowed when the bot holds the grant, the run was started by a person in a conversation or mention, that person's own connection works, and they agreed to the tool's service. A read runs in the asker's transaction, so a person who left the team reaches nothing; a write runs as the bot and waits for approval, and when approved it runs once more for the same asker.

### Testing it

`packages/test-utils/src/fake-providers.ts` is a fake Google, Microsoft 365 and Notion on one local address: the consent page, a token address that checks the app, the redirect and the PKCE proof, a refresh that can rotate, and the APIs the tools call, on per-account data (`fake-providers-data.ts`). `MANYTHREADS_OAUTH_<PROVIDER>_FAKE_BASE` points the plugin at it, and is read only outside production. It never records a token, a code or a secret. `e2e/fixtures/outside.ts` starts it together with the fake GitHub for the browser tests. `test/person.test.ts` covers the sign-in, the refresh, the tools and the intersection test.

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

## The two brokers (P8-04)

A **broker** hands a task a credential that lives at most one hour and is made for that call alone, instead of keeping a long-lived key anywhere a bot could reach. Both are kinds of connection, in `src/brokers/` and `src/kind-ssh.ts`, `src/kind-kubernetes.ts`. (PLAN names `gateway-mcp/brokers`; plugins cannot import each other and the credentials live here, so the code sits with the connections. The gateway reaches it through the tool-source registry like every other source.)

* **Lifetime.** `clampLifetime` holds every request between 10 minutes (the least a cluster accepts) and 1 hour. What the other side answers is checked too: a certificate or token that lives longer than an hour (plus a minute of clock difference) is thrown away and the call fails (`too_long_lived`); some clusters stretch token life, so this is not theory.
* **`ssh` kind, tool `ssh.run`** (a write: runs as the bot, held back in a rehearsal, can wait for approval). Credentials: `ca_url`, `provisioner`, `provisioner_key` (the step-ca JWK provisioner's P-256 key), `user`, `hosts`, `known_hosts`, `commands`, optional `ca_cert`. Each call makes a fresh Ed25519 key in memory, has step-ca sign it for the one account `user` (the certificate is checked: it vouches for that key, names only that account, is a user certificate, ends within the hour), writes the key into a private temporary folder, runs `ssh` with agent, forwarding, proxy and password login off and the host key checked against `known_hosts`, and removes the folder. The command must be one of the lines the administrator wrote in `commands`, word for word, on a host listed in `hosts`; anything else is refused before a certificate is asked for. That list is why the tool is not tagged destructive: a model cannot add a line. Output is cut at 20 000 characters; a command that runs past 30 s is stopped.
* **`kubernetes` kind, tool `kubernetes.get`** (a read). Credentials: `api_url`, `token` (the bootstrap token, allowed only to ask for tokens of the service account), `service_account`, `namespace`, optional `namespaces` (comma list the tool may read; default `namespace`) and `ca_cert`. Each call asks the cluster for a `TokenRequest` token of `service_account`, reads once with it and drops it. Readable: pods (and their logs), services, events, deployments, replicasets, statefulsets, jobs, ingresses, namespaces, nodes. Never secrets or config maps, nothing that writes. What the token may do is also the service account's own role in the cluster, which is where an administrator limits it.
* A connection missing a credential its kind needs answers `{ ok: false, code: 'not_set_up', message }` naming the credential names that are missing; one that cannot be reached answers `unreachable`. Nothing is run or asked until it is whole.
* **step-ca only.** The signer is an interface (`SshSigner`); Teleport would be a second implementation. Teleport is not built.
* Tests: `test/brokers.test.ts` (against a local step-ca double that signs with a real `ssh-keygen` authority, a cluster double, and, when the machine is root with `sshd`, a real OpenSSH server), `test/kind-ssh.test.ts`, `test/setup-brokers.test.ts` (routes plus a bot reading a cluster through the MCP endpoint). `MANYTHREADS_TEST_SSH_BIN` (only with `NODE_ENV=test`) points the kind at a stand-in `ssh`.

## The eval check on a pull request (P8-05, first half)

`src/github-pr-evals.ts`: `evaluatePull` lists the files a pull request on the team's GitHub repository changes (`GET /pulls/:n/files`), keeps those that are a bot's `BOT.md` or a scenario file under `bots/<slug>/evals/`, reads them **at the head commit** through the contents API (never checked out, never run), loads each bot with the shared `loadBotEval` and runs the set in the quick mode (the shared judge, no model: a case fails when the new BOT.md lacks a capability it requires; wording assertions are left to the full run on the bot's page). A BOT.md that does not load, or a set that cannot be read, fails with the reason. `publishReport` writes the verdict on the head commit: a **check run** (`manythreads / bot evals`) when the token is a GitHub App's, a **commit status** when it is a personal token (GitHub lets only apps write checks). A pull request that touches no bot writes nothing.

Not built: the webhook that calls it, the GitHub App credentials, and "merge reloads the bot" (the platform's own repository is where a bot is loaded from, and nothing yet brings a merge on GitHub back into it; see the owner question in the PLAN row).

## Not yet

* `person:*` (a person's own connections for a conversation or a mention) and workspace-scoped grants to a bot (P8-02); adding a person's own connection.
* A real mail transport (P8-29).
* The Activepieces team project, the GitHub App (hourly tokens), the GitHub and GitLab MCP servers and the team repo push (P8-03), and the Add connection screen.
* `person:*` (a person's own connections for a conversation or a mention) and workspace-scoped grants to a bot (P8-02).
* A real mail transport (IMAP, Gmail), audit lines and events for connection changes (P8-06), the Connections screen.
* The screens that consume the mail (P8-34 to P8-36).
* Creating a connection and putting credentials in for a team connection: no route yet (P8-03). The functions exist (`putConnectionSecret`, `deleteConnectionAndSecrets`) for the code that will.
* Workspace-scoped grants to a bot, an admin screen for the provider apps (P16-02), and the person's connections page in the web client.
* A real mail transport (P8-29), audit lines and events for connection changes (P8-06), the Connections screen.

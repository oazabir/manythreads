# gateway-mcp

The one MCP endpoint a bot's run calls its tools through (SPEC §11, PLAN P5-09). A bot's runtime holds a pairing token
and nothing else; this gateway turns that token into a run, and one run into one URL that speaks MCP.

## Where the package lives

PLAN.md writes `packages/gateway-mcp`. `discoverPlugins` only scans `packages/plugins/*` and a plugin needs a
`manythreads.entry` in its `package.json` (the same deviation P5-03, P5-04 and P5-06 recorded), so the package is
**`packages/plugins/gateway-mcp`**.

## A run, not a bot, is the unit

The week-3 spike (`docs/spikes/per-run-scoping.md`) checked Hermes v0.21.5 for a per-run tool-scope primitive and found
none: an MCP server is declared once in a config file, so two sessions sharing a profile share one endpoint. The adopted
fallback is a **URL per run**: `runtime-hermes` launches one Hermes invocation per run against a URL it was handed, and
this gateway maps that URL back to the run — which is the only way a tool call can be attributed after the fact.

```
POST /api/mcp/runs                { pairingToken, threadId?, ttlSeconds? }
   → 201 { runId, botId, url, token, expiresAt }          url = <publicUrl>/mcp
POST /mcp                          Authorization: Bearer <run token | bot pairing token>   { "jsonrpc": "2.0", ... }
POST /api/mcp/runs/:runId          Authorization: Bearer <token>   { "jsonrpc": "2.0", "id": 1, "method": "tools/call", ... }
POST /api/mcp/runs/:runId/close    Authorization: Bearer <token>   { "status": "done" | "failed" | "stopped" }
```

All three are public in the session sense — the pairing token, then the run token, is the credential. **The run token is an
`Authorization: Bearer` header and never part of the URL** (a path lands in proxy and access logs; `server/src/log-redact.ts`
also masks anything that is not a run id in that position, as a backstop). The URL names the run and must agree with the
token's run. Unknown, revoked, expired and already-closed tokens, a missing or non-Bearer header, and a run id that is not the
token's all answer the same **401**, so a probe cannot tell which it hit. A run that is ended *while* a request is in flight
(the reaper, an approval's re-run, a close from the same client) answers a `tools/call` with the tool result
`{ ok: false, code: "run_ended" }` and anything else with the same 401 — never a 500. **Client rule: treat a 401 on `/close`
after an approval as done** (the approval's re-run ends the run itself, so the run is already closed by the time the client closes it). The token is shown once;
`app.mcp_run_tokens` keeps its sha256 and nothing else, has no GRANT for `manythreads_app`, and is read and written only
by the kernel's run service (below).

What the mint does *not* trust: the bot, its actor row, its team and its workspace are read from the database. **The caller
chooses neither an asker nor a trigger** (the request schema is strict, so sending either is a 400). A pairing token proves
"I am this bot's runtime", not "this person asked the bot something" — if it could name an asker, anyone holding a bot's
token could open a run as any teammate and read their private channels and DMs, or claim `conversation` to be offered
`person:*` tools. So a publicly minted run has **no asker** (its reads run as the bot: team-public data only) and the fixed
trigger `webhook`, which never carries `person:*`. A conversation or mention run — with the person who asked — is opened
only in-process by the router (`runtime-hermes`, `ctx.runs.open`), which reads the asker from the message it is answering.
The run service still checks that an in-process asker is a `person` actor of the same workspace on the run's team.

## What a call runs as

`ctx.runs` (the kernel's run service, PLAN P5-09) is the whole mechanism, and two promises in it are the point:

- **a read runs as the asking person** (`asReader`), so a search answers what that person may see, never more — the bot
  has no wider view than the person talking to it;
- **a write runs as the bot** (`asBot`), so a commit carries the bot as its author;
- both carry `app.run_id`, which is what `app.run_source_log`'s insert policy insists on (`run_id = app.run_id()`), so a
  run's reader is the only writer of its own source log;
- **authorization is always the bot's**, through the broker, asked about the run's bot actor rather than about whoever
  the transaction happens to be. `tools/list` uses the non-auditing `may` — offering a tool is not a request to use one,
  and a denial per ungranted tool per listing would drown the audit log — while `tools/call` uses `authorize`, which
  audits every denial as `kernel.capability.denied`. A mutation is offered at grant level (a listing has no arguments,
  so there is no path to judge) and authorized with the path its arguments name, so the broker's path guard refuses
  `bots/`, `TEAM.md`, `skills/` and `routines/` before any handler runs.

`ctx.runs` is declared by the manifest (`extends: ['tool.invoke']`) and documented in `docs/plugins/security.md`.

## The data-loss check (P10-04)

A tool call is a way for text to leave a run, and what a read tool answers is a way for a secret to walk into a model. So `tools/call` runs the `pre_egress` chain (see [guardrails-dlp](./guardrails-dlp.md)) twice around the tool, in `src/guard.ts`:

1. **Before the tool**, over every text value in the arguments and over the field names (read together as one text; a finding in a name refuses the call, since a name cannot be redacted without changing the call; UUID-shaped values are skipped). `block` refuses the call (`blocked_by_guardrail`, a message that names the kind of thing found, never the thing); `redact` runs the call with each finding replaced by a marker such as `[redacted:api-key]`; `require_approval` on a write
   sends it to the Approvals inbox with the **redacted** arguments (a secret is never stored in an approval), and on a read counts as a refusal because nobody can be asked.
2. **After a read tool**, over the answer before the bot sees it: `redact` hands back the redacted copy, `block` or `require_approval` withholds it (`withheld_by_guardrail`). A write's answer is not scanned.

The gateway judges under the `standard` preset because the workspace's own preset lives in settings only an admin can read; the admin's per-detector choices and custom rules (Settings → Workspace → Data protection) are what decide. It fails closed: if no guardrail answered, or the arguments are too deep (20 levels), hold more than 20,000 pieces of text or more than 8 million characters, the call is refused unread; if the check itself throws, the call is refused (`blocked_by_guardrail`) and the real error goes to the server log. Not covered: encodings (base64, hex, URL escapes), text split across several values or calls, look-alike letters, and a bot's final reply or rules-runtime steps, which invoke capabilities without passing the gateway.
One `guardrails.dlp.decided` event is written per call (`destination` `mcp` or `mcp_result`), naming the rules and never the text. The manifest gained `hook.pre_egress` and `event.emit` in `extends`, and `dependsOn: ['bots', 'guardrails-dlp']`. Test: `test/guard.test.ts`.

## Rehearsal runs (P7-11)

A run whose row says `rehearsal` (set by the router for a question filed by the bot page's Test action, see [bots](./bots.md)) makes no write. In `callTool`, after the data-loss check on
the arguments and before the approval branch, a tool whose kind is not `read` or `stub` and that is not marked `rehearsalSafe` is **not called**: the gateway records one line
(`ctx.runs.logIntercept`: the tool name, the first path, channel, card, message, bot or team the arguments name, clipped to 300 characters, and whether a real call would have waited for
approval; never the text of the call) and answers `{ ok: true, rehearsal: true, done: false, message: "Rehearsal: “<tool>” was NOT done. ..." }` so the model carries on to its reply and does not
say it happened. The flag is read from the run's row (resolved from the bearer token), so no argument can change it. Only `answer.post`, the reply itself, is `rehearsalSafe`, and only while the call would go straight out: a reply whose grant needs a person's approval (or that the data-loss check holds for one) is held back like a write, so no card reaches the Approvals inbox, and the run's closing text carries the answer. A tool the
catalog does not describe has no kind and counts as a write, so a tool added later is held back until someone says otherwise. If the line cannot be written the call is still not made and
the model is told it failed. Approvals are never created in a rehearsal. Test: `test/rehearsal.test.ts`.

## The Workshop sandbox (P7-05)

The Rehearse mode of a bot's Workshop tab ([workshop](./workshop.md#rehearse)) needs a rehearsal that is not started by a question in a channel, so the provider has four members: `openSandbox`, `sandboxTools`, `sandboxCall` and `closeSandbox` (`src/sandbox.ts`). `openSandbox` makes a run of the bot with `rehearsal: true`, for the asker, and hands back a handle; `sandboxTools` lists what the same run would be offered, plus the stub write tool `test.write`, which exists only here; `sandboxCall` makes the call through the same `callTool` path as a real run, so the rule above holds: a tool that is not a read is held back, logged in `rehearsal_intercepts` and answered "was NOT done". `closeSandbox` ends the run with the status the caller gives it (`done` when the turn replied or the person ended it, `failed` when the turn did not finish). A handle is never believed: each member reloads the run's row and refuses anything that is not a running rehearsal of the same bot, team and asker. A name that was not offered is refused, wire names are the capability names with every character outside `a-z A-Z 0-9 _ -` turned into `_`. The run is not counted among the bot's real runs. Tests: the workshop plugin's `test/workshop-session.test.ts` (a hostile scripted model through the real server): every write a hostile model tries is held or refused; a capability the catalog has no entry for (`hello.greet`) is a write by default and is held; a read-kind tool whose grant needs approval (`messages.search`) is held, files no approval card and its line says it would have waited; a turn the model could not finish closes the run as `failed`. There is still no gateway-mcp test of the four members on their own (they need a whole plugin context); the Workshop test is the one that drives them through the real broker.

## The tools

`tools/list` offers every capability with an implementation **that the broker would allow** — no grant, no tool. The
catalog is not a second list of names; the descriptors in `src/catalog.ts` only say how to describe a tool to a model and
what a call does beyond asking the broker:

| tool | kind | what a call does |
|---|---|---|
| `messages.search` | read | searches the run's team; each hit is one `run_source_log` line |
| `files.search` | read | the same over file names |
| `messages.post` | write | posts a message (or a thread reply) into a channel of the run's team, as the bot — the same call the post route and a runtime's own reply go through (channels plugin, PLAN P5-10) |
| `pages.write` | write | creates, replaces or appends a page through the repo writer, as the bot |
| `memory.recall`, `memory.retain` | read / write | the `memory` plugin's bank tools ([memory-hindsight.md](./memory-hindsight.md)): the description is here, the handler is there |
| `memory.write` | write | proposes ONE OKF concept into `memory/**` through the `memory` plugin ([memory.md](./memory.md), P5-26): the path is judged by the broker before the handler runs, provenance is the platform's, and a concept a person wrote is never overwritten (a `draft` sibling is filed). The description and the JSON Schema come from the same `OkfProposal` the plugin validates with |
| `answer.post` | write | finishes the run's reply with an Answer: a text, the sources it cites by id and some suggestions; the `answer` plugin re-reads every source as the person who asked and posts the message with its payload ([answer.md](./answer.md)). The description the model reads is generated from the same Zod schema the plugin validates with |
| `surface.render` | write | draws a screen (OpenUI Lang, checked by the shared checker) in the thread the run answers in and posts a message that points at it; takes no channel, thread or run, the platform reads them from the run (the `surfaces` plugin, PLAN P9-04, [surfaces.md](./surfaces.md)). The description lists the registered parts, generated from the registry |
| `surface.update` | write | patches a screen the bot drew by part name, additive and versioned; refused when `baseVersion` is stale or the screen is another bot's |
| `surface.event` | write | reads the answers people sent back from the bot's own screens in this thread (a press, a form); data only, never a tool call |
| `tasks.read` | read | the team's cards the run can see, or one card, newest change first (the `tasks` plugin, PLAN P6-02) |
| `tasks.create` | write | creates a card as the bot, in the bot's own team (a tool never names a team); the card and its `created` history go through the same door as `POST /tasks`, and assignment stays a handover, not a create |
| `tasks.claim` | write | claims a card: one live claim per card, a second claim answers `already_owned`; the claim expires after `ttlSeconds` |
| `tasks.complete` | write | completes a card the run owns; a `code` card needs `testedSha`, and a branch head beyond `base_sha` is refused `stale_base` |
| `tasks.release` | write | gives back a card the run owns, so the next claimer can take it (the release route's door) |
| `tasks.describe` | write | replaces the description of a card the run owns; where a bot keeps a card's working state, such as a running count |
| `tasks.handoff` | write | moves a card to another bot or person in one transaction; a bot reaches only the targets its `tasks.handoff` grant's `mayTag` names (the same allowlist the board enforces), and a `dispatch: strict` handover can wait in Approvals |
| `tasks.deploy` | write | asks for a release to one of the team's environments; the environment decides (a protected one waits for a person who is not the requester, a change window or the daily cap can refuse), and the answer carries the outcome rather than a promise |
| `knowledge.search` | read | the `knowledge` plugin's passages from the bases the bot lists (all of its team's when it lists none), ranked, each with document, version, section and place; runs as the asker; logs a `knowledge` and a `page` source per hit ([knowledge.md](./knowledge.md)) |

`knowledge.search` is owned by the [knowledge](./knowledge.md) plugin, which registers the capability; this plugin only declares the tool (its description, input schema and the `sourcesFrom` that fills the run's source log).

Three shapes of refusal, all answers a model can read and act on rather than transport errors: no grant, or a mutation
naming a path the bot may never write → `{ ok: false, code: 'forbidden' }` with the broker's reason; a grant with
`needsApproval` → the handler **is not run**: the call becomes a pending approval in the Approvals inbox through
[approvals](./approvals.md)'s one handler (source `grant`; the arguments are stored for the re-run, the approver sees a clipped preview) and the model gets
`{ ok: false, code: 'approval_pending', approvalId, message }` — *tell the person it is waiting, do not call it again*; asking again for the same call
is the same approval (per asker). A *read* flagged `needsApproval` is not parked — it answers `{ ok: false, code: 'forbidden' }` (a re-run after approval would run it as the bot, not as the person it was asked for). Without the approvals plugin the answer stays `{ ok: false, code: 'approval_required' }` (fail closed);
a granted name nothing implements → `{ ok: false, code: 'unknown_tool' }`.

A handler that **throws** is also an answer (`isError`), never a transport error: the platform's own errors keep their code and sentence
(`validation_failed` for a bad or unknown argument, `forbidden`, `not_found`, `conflict`); any other error (a database refusal, which names
columns and constraints) becomes `{ ok: false, code: 'failed', message: 'the call failed' }` and its real text goes to the server log only.
A run that ended under the call is not an answer of this kind: it is rethrown and becomes `run_ended` (a call) or a 401.

## Tools that come from a source

Not every tool is a capability handler. A plugin that extends `tool.source` registers a **source** (`ctx.toolSources`, [security.md](./security.md)): a list of tools it can serve and two functions, `offered` (which of them this bot may see, asked in the bot's own transaction) and `call`. [connections](./connections.md) is the first one.

* **`tools/list`** offers a source's tool only when the capability broker allows the bot **and** the source says yes. A source that throws offers nothing (fail closed, and the fault goes to the server log).
* **`tools/call`** runs the same path as any tool: the grant and the destructive tag are checked by the broker first, a `needsApproval` call waits for a person (and, once approved, is run again through the same source), and only then does the run service hand the call to the source. It does so in the transaction of the run's bot (a write) or of the person who asked (a read), and only while the run is open: the source gets the run from the run's own row, never from the request.
* **What the run read.** A successful read of a source's tool always writes a `connection` line to the run's source log (the tool name, scope `person`, the narrowest, because the gateway cannot tell how widely the source's data is visible), in addition to any lines the tool's own `sourcesFrom` returns. The retention rule (a run keeps no wider than the narrowest source it read) therefore sees every read of outside data.
* A source's tool and a capability handler can never share a name (the kernel refuses the second one to register, in either order), so there is exactly one place a call can land.
* The source's answer, including a refusal such as `not_available`, is the tool's answer. A source that throws is answered like a handler that throws (see above).

## What the run read

Every hit a read answers with becomes a line in `app.run_source_log` (`sourceType` `message` or `file`, the hit's id,
`scope` `channel` when the hit has a channel and `team` when it does not). The line is appended through the bots
plugin's door (`app.run_source_log_append`, migration 0004, serialised per run by an advisory lock in 0007): the position is computed there, as the system role,
because a bot actor cannot see its own run's lines under the table's SELECT policy — parallel tool calls take consecutive positions, and the append policy's
`run_id = app.run_id()` is what keeps one run out of another's log. That is what the Answer surface's "Sources
reached" and the retention rule — a run retains memory no wider than the narrowest source it read (SPEC §12.1) — read
later. What the gateway does **not** log is the query itself or anything a stub touched, because neither is a source.

## What the run decided (P7-07)

Next to the source log, every tool call and every guard check on a tool's answer leaves one **content-blind** line in `app.run_decisions` (the bots plugin's table, [bots.md](./bots.md); written through `ctx.runs.logDecision`): `kind` `tool` with the capability name and the broker's outcome (`allowed`, `needs_approval`, `denied`), or `kind` `guard` with the preset and the names of the rules that fired. The line never holds the arguments, the answer or a matched snippet. The one thing it keeps of where a call aimed is a path of the team's files, and only for a change made by a `files.*` or `pages.*` tool, and only if the string is shaped like one (a known first folder, plain characters, no long opaque string); any other string the model wrote there, a secret included, is dropped and the line is marked `truncated: true`, which is also set when a call named more than five places or a place longer than 200 characters. A `target` is such a path, or an id or slug of the platform's own shape (a UUID, a short slug). A line that cannot be written is logged and counted (`lostDecisionCount()`), and a detail over 1500 bytes becomes `{ "truncated": true }` before it reaches the table; the replay never judges either as same. The Workshop's replay reads these lines and asks the broker the same question again through `ctx.capabilities.preview` (the same decision as `call`, no audit row, no effect). `test/decisions.test.ts` checks the lines for an allowed call, a call that waits for a person, a refusal and a guarded answer, that no argument text reaches the table, and that a secret-looking path or id is not stored.

## Not yet

- A person's own connections (`person:*`) are P8-02; the team connections that exist today are in [connections.md](./connections.md).
- The spend a runtime's calls cost is not written to `llm_spend` (no price source in this deployment); the tokens the model
  reported are logged by the runtime instead.

## Who calls it

`runtime-hermes` (P5-10) is the caller: it mints a run per invocation (`ctx.runs.open`, the same service this plugin's routes
use), writes the URL and (as a bearer header) the token into the Hermes profile it generates, and posts the run's reply through `messages.post` in the
run's bot transaction. The loader compiles a `BOT.md`'s `capabilities.native` into `app.capability_grants` (bots migration
0005), so the tools a bot is offered come from its own file.

The `model` bot runtime (P19-10, [bot-runners](./bot-runners.md#the-model-runtime-a-bot-on-an-llm-gateway-runner-p19-10)) is a second caller that makes no HTTP request: the run job reaches the same code through the provider `mcp.tools` (`McpToolsProvider` in `@manythreads/sdk`). `offered(run)` answers the tools the run may be offered (the list `tools/list` returns, grants and approval notes included) and `call(run, name, args)` runs one tool through `callTool`, so the grant check, the data-loss check, the rehearsal hold, approvals and the source log are the ones a Hermes bot meets; the answer is the tool's text and whether it was an error.

## The one address, `/mcp`

Every URL the platform hands out is `<publicUrl>/mcp` (inside the cluster, `http://manythreads-server:3000/mcp`). The bearer token alone says who is
calling: it is looked up first as a run token (that run's call, with the asker's authority) and otherwise as a bot's pairing token (the call is
attributed to the bot's open run, as below). Anything else is one 401, and failed attempts are counted per client address. `/api/mcp/runs/:runId`
and `/api/mcp/bots/:botId` keep working for profiles written before. `POST` answers each request with one JSON document. A bot's token also opens
the tools stream with `GET` (below); a run's own address serves `POST` only and says `listChanged: false`.

## The bot's stable endpoint

`POST /api/mcp/bots/<botId>` is for a Hermes gateway profile, which holds one address and one token and cannot be given a new pair per run. The
credential is the bot's token (its pairing token: minted, rotated at `POST /api/teams/:slug/bots/:botSlug/pairing-tokens/rotate`, and revoked by a
lead). A call is attributed to the bot's currently open run — `ctx.runs.openRunOf(botId)`, the newest running run not opened through the public
mint — and then goes through the same `handleRpc` as the per-run endpoint. With no run open, `initialize`, `ping` and `tools/list` answer normally
(the list is judged as for a conversation) and `tools/call` is a tool error with code `no_open_run`. An unknown, revoked or other bot's token is a
401 identical to every other 401 of the endpoint.

## The tools stream (P14-22)

A Hermes reads a bot's tool list once, when its profile is served; a change of tools reaches it only by push. So the bot's endpoint (`/mcp` and
`/api/mcp/bots/<botId>`, never a run's address) says more:

* **`initialize`** answers `tools: { listChanged: true }` and a header `Mcp-Session-Id`. The id is a signed value that names the bot
  (`v1.<bot id>.<HMAC>`; the key is derived from `MANYTHREADS_KMS_KEY`, the same on every replica, random per process without one). No server memory
  holds it: any valid id is accepted after a restart or on another replica. A client that sends an id the signature does not verify, or another bot's, gets
  404 `Unknown session; send initialize again`; a client that sends none is served as before. An `initialize` itself is never refused for its session header: a
  client that re-sends an old id with a fresh `initialize` is given a new session.
* **`GET`** with `Accept: text/event-stream` and the bot's token opens a stream (the same authentication as `POST`: a missing, wrong, revoked or another
  bot's token is the same 401, and a run's token never opens one). Any other `GET` stays 405. The stream sends one `list_changed`
  (`event: message`, `data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`) the moment it opens, so a Hermes that reconnects after a deploy lists
  again; a `: keepalive` comment every 25 s; it ends after 30 minutes (the client reconnects). A revoked token (`DELETE …/pairing-tokens`) ends its streams at the next
  token check, within about ten seconds; a rotation (`bots.pairing.rotated`) makes that check at once. At most 4 streams per bot and 2,000 in all, **each counted per
  process (per replica)**, so a bot can hold 4 on every replica: an excess one is 429 with `Retry-After`. A reader that cannot keep up is dropped, never buffered
  further: over 16 KB waiting, or with anything it was sent still unread at two keepalive times in a row (a frame is tiny, so a stalled client would otherwise take
  hours to reach the byte limit). A frame carries no token, id or counter. A `MANYTHREADS_KMS_KEY` that is set but is not 32 bytes of base64 is logged at start-up: the
  session key then differs per process.
* **The tools digest** is a SHA-256 of exactly what `tools/list` answers the bot as a conversation: every tool's name, description, input schema, destructive
  flag and `needsApproval`, sorted by name with sorted keys (a reordered grant list is the same digest). It is recomputed when the bot is loaded (a `BOT.md`
  commit: definition and grants) and when a workspace policy changes (approval rules), and kept in `app.mcp_bot_tools` (migration 0002; system role only;
  `version` goes up only when the digest differs from the last one pushed). Another plugin reads it through the provider `mcp.tools` (`toolsDigest(botId)`),
  which is how the pod's `config.yaml` line carries the same value.
* **Across replicas.** Plugin events are taken by one replica, so the event handler only writes the new digest and bumps `version`. Each replica that holds
  streams reads the versions of its bots' rows every two seconds (and at once for a change it wrote itself) and sends `list_changed` to its own streams when
  one moved. Nothing is shared in process memory.
* **What the bot's page shows.** `tools/list` at a bot's address records the digest it answered (`listed_digest`, `listed_at`; one row per bot, cleared when the token is rotated).
  `GET /api/teams/:slug/bots/:botSlug/mcp-tools` (team members) answers `{ state: 'current' | 'older' | 'never', digest, listedDigest, listedAt }`: `older` means the
  profile last listed a different set than the bot has now, which a Hermes that holds the stream never shows for more than a moment.
* **The ingress** must pass the stream unbuffered: the response carries `X-Accel-Buffering: no`, and the read timeout in front must be over 30 minutes (Helm
  `web.mcpStreamTimeout`; see `docs/deploy.md`).

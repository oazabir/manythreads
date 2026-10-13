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
   → 201 { runId, botId, url, token, expiresAt }          url = <publicUrl>/api/mcp/runs/<runId>
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
| `knowledge.search` | stub | answers `{ hits: [], reason: "no bases configured" }` — never invented content |
| `tasks.read`, `tasks.claim`, `tasks.complete`, `tasks.handoff` | stub | answer that the board is not part of this deployment yet |

The last five are declared by this plugin because the plugin that will own them does not exist yet (knowledge bases come
with connections, the board with tasks). When one lands it declares the capability and this declaration goes — a
duplicate name is a load-time error in the capability registry, so the handover cannot be forgotten silently.

Three shapes of refusal, all answers a model can read and act on rather than transport errors: no grant, or a mutation
naming a path the bot may never write → `{ ok: false, code: 'forbidden' }` with the broker's reason; a grant with
`needsApproval` → the handler **is not run**: the call becomes a pending approval in the Approvals inbox through
[approvals](./approvals.md)'s one handler (source `grant`; the arguments are stored for the re-run, the approver sees a clipped preview) and the model gets
`{ ok: false, code: 'approval_pending', approvalId, message }` — *tell the person it is waiting, do not call it again*; asking again for the same call
is the same approval (per asker). A *read* flagged `needsApproval` is not parked — it answers `{ ok: false, code: 'forbidden' }` (a re-run after approval would run it as the bot, not as the person it was asked for). Without the approvals plugin the answer stays `{ ok: false, code: 'approval_required' }` (fail closed);
a granted name nothing implements → `{ ok: false, code: 'unknown_tool' }`.

## What the run read

Every hit a read answers with becomes a line in `app.run_source_log` (`sourceType` `message` or `file`, the hit's id,
`scope` `channel` when the hit has a channel and `team` when it does not). The line is appended through the bots
plugin's door (`app.run_source_log_append`, migration 0004, serialised per run by an advisory lock in 0007): the position is computed there, as the system role,
because a bot actor cannot see its own run's lines under the table's SELECT policy — parallel tool calls take consecutive positions, and the append policy's
`run_id = app.run_id()` is what keeps one run out of another's log. That is what the Answer surface's "Sources
reached" and the retention rule — a run retains memory no wider than the narrowest source it read (SPEC §12.1) — read
later. What the gateway does **not** log is the query itself or anything a stub touched, because neither is a source.

## Not yet

- Connections (`person:*` tools, `needsApproval` per connection) are P8.
- The spend a runtime's calls cost is not written to `llm_spend` (no price source in this deployment); the tokens the model
  reported are logged by the runtime instead.

## Who calls it

`runtime-hermes` (P5-10) is the caller: it mints a run per invocation (`ctx.runs.open`, the same service this plugin's routes
use), writes the URL and (as a bearer header) the token into the Hermes profile it generates, and posts the run's reply through `messages.post` in the
run's bot transaction. The loader compiles a `BOT.md`'s `capabilities.native` into `app.capability_grants` (bots migration
0005), so the tools a bot is offered come from its own file.

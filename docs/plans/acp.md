# Phase 25 · Agents driven through ACP, with their work shown live in the thread

Owner request, 2026-11-14: "Plan for implementing ACP so that hermes, claude, codex, opencode etc can be driven by manythreads, supporting live streaming of output,
interactive responses, tool & subagent calls, mid-run interruption, concurrent sessions, resuming & history replay. Support auth/login and auth/logout to configure
authentication of the tools. Build useful, visually attractive presentation of live streaming output, interactive responses, subagent activities on the manythreads
thread view without cluttering the view too much and showing too much verbose output. It needs to be just the right amount of visibility of the work going on by main
session and the subagents. A todolist card should be shown by the engineer or similar orchestrator bot that gets updated live as tasks are done."

**Stop criteria (owner):** the feature is built and tested; Hermes, Claude Code and Codex all run in ACP mode; and the Engineer has delivered a feature or fix end to
end on three separate threads, one with the chain on Hermes, one on Claude Code, one on Codex.

Status: draft (2026-11-14), reviewed once (independent review, same day: facts checked against `@agentclientprotocol/sdk` 2.7.0's schema, `claude-agent-acp`
0.107.0, `codex-acp` 2.6.0 and the Hermes 0.21.5 `acp_adapter` source on the devbox; design checked against the code). Goes into PLAN.md after the owner answers §8.

---

## 1. What ACP is, and what is already known

The Agent Client Protocol (ACP, agentclientprotocol.com, made by Zed) is JSON-RPC 2.0 (numbered requests and answers, one JSON object per line) over the agent
process's stdin and stdout. The **client** (here: the manythreads agent bridge, `tools/agent-bridge`) starts the **agent** process (an "adapter" that wraps
Claude Code, Codex or Hermes) and talks to it. Stable protocol v1 has these methods (a v2 draft exists; we speak v1):

| Direction | Method | Used for |
|---|---|---|
| client → agent | `initialize` | protocol version; the client's capabilities (`fs`, `terminal`, `auth.terminal`, `elicitation`); the agent's capabilities (`loadSession`, `sessionCapabilities.{resume,list,close}`, `mcpCapabilities.{http,sse}`, `auth.logout`) and `authMethods` |
| client → agent | `authenticate {methodId}` | sign in with a method of type `agent` (the agent does it). A method of type `terminal` is never passed here: the client runs the agent's own command with the method's `args` in a terminal |
| client → agent | `logout` | sign out; only when the agent advertised `auth.logout` |
| client → agent | `session/new {cwd, mcpServers}` | a new conversation; the run's manythreads MCP endpoint goes in `mcpServers` (`{type:"http", name, url, headers:[{name,value}]}`) |
| client → agent | `session/resume {sessionId, cwd, mcpServers}` | continue an earlier conversation **without** replaying it (when `sessionCapabilities.resume` is advertised) |
| client → agent | `session/load {sessionId, cwd, mcpServers}` | continue an earlier conversation; the agent first replays all of it as `session/update` notifications |
| client → agent | `session/prompt {sessionId, prompt[]}` | one turn; resolves with a `stopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) |
| client → agent | `session/cancel` (notification) | stop the turn; the client MUST answer every pending permission request with `cancelled`; the prompt ends with `cancelled` |
| client → agent | `session/set_config_option`, `session/set_mode` | model, effort and mode (plan mode). There is no `session/set_model` in stable v1: the model is a config option |
| agent → client | `session/update` (notification) | `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk` (replay), `tool_call`, `tool_call_update`, `plan`, `usage_update` (context used and cost), `session_info_update` (title), `current_mode_update`, `config_option_update`, `available_commands_update`, `notice` |
| agent → client | `session/request_permission {toolCall, options[]}` | the agent asks before a tool runs. Each option has its own `optionId`, a `name` and a `kind` (`allow_once`, `allow_always`, `reject_once`, `reject_always`). The answer is `{outcome:"selected", optionId}` or `{outcome:"cancelled"}` |
| agent → client | `elicitation/create` | the agent asks the person for input: `mode:"form"` (a small form) or `mode:"url"` (open a page; used for device-code sign-in). Only when the client advertised `elicitation` |
| agent → client | `fs/*`, `terminal/*` | only when the client advertised them (we will not, §4.4) |

A `tool_call` carries `toolCallId`, `title` (the adapter's one line, e.g. the command), `kind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`,
`fetch`, `switch_mode`, `other`), `status` (`pending`, `in_progress`, `completed`, `failed`), `locations` (files) and `content` (text, a `diff`, or a terminal).
Subagents are **not** in stable v1: an unstable `subagent_update` exists behind a client capability, and adapters fall back to marking a child's tool calls in `_meta`.

What the adapters' code said, as corrected by the P25-01 measurements (`docs/spikes/acp-measured.md`, raw lines in `tools/agent-bridge/test/fixtures/acp/`):

| | Hermes (`hermes acp`, 0.21.5) | Claude (`@agentclientprotocol/claude-agent-acp` 0.107.0) | Codex (`@agentclientprotocol/codex-acp` 2.6.0) |
|---|---|---|---|
| resume / load | both, plus `fork`, `list`. Measured: `resume` **replays** the history (2.0 s), and an unknown id is **not an error** (resume answers as if new, load answers an empty result) | both, plus `close`, `list`, `fork`. `resume` 0.47 s, no replay; unknown id: error -32002 | both. `resume` 0.38 s, no replay; unknown id: error -32603 "no rollout found" |
| HTTP MCP with headers | works although `mcpCapabilities` is not advertised (6 of 6 requests carried the header); the token is in no log | yes (`http`, `sse`) | yes (`http` only) |
| sign-in methods | `agent`: the provider already configured (our LiteLLM key); `terminal`: `hermes acp --setup` | only `terminal` methods (`--cli auth login --claudeai` / `--console`; on a server `claude /login` with a pasted code), offered only when the client advertises `auth.terminal`; a `gateway` method when the client advertises `auth._meta.gateway` | `api-key` (from `CODEX_API_KEY`/`OPENAI_API_KEY`), `chat-gpt` (local browser; offered without `NO_BROWSER` too), `chat-gpt-device-code` (the URL in `elicitation/create` url mode and the code **inside its message text**; `accept` keeps `authenticate` waiting, `cancel` fails it with -32000; only when the client advertises URL elicitation), `gateway` |
| logout | not advertised | yes (runs the CLI's logout, clears the gateway); also an `auth/status` request and push (it carries the e-mail: never forward) | yes; `_auth/status_update` push only |
| plan updates | **none on 0.21.5**: its tool is `todo_list`, the adapter converts only `todo`; the list is in the step's `rawInput.todos` (the bridge builds the plan) | yes, the whole list each time, from `TaskCreate`/`TaskUpdate`/`TaskList` (**no `TodoWrite`** in an SDK session) | none seen in any run (plan mode gives a `switch_mode` request instead) |
| subagents | `delegate_task` is one step that returns at once (background); no child steps arrive | the `Agent` tool (titled "Task"); each child step carries `_meta.claudeCode.parentToolUseId`; the child ends with a `SubagentHandback` step | stable fallback: steps "Start subagent X", "wait", "Complete subagent X"; no child steps, no marker |
| permission options | `allow_once`, `allow_session` (kind `allow_always`), `allow_always`, `deny` (kind `reject_once`), `deny_always`; the request's `toolCallId` is `perm-check-N`, **not** the step's id; an unanswered one is denied after 300 s (source; not seen, no request occurred) | `allow-once` ("Yes") and `reject` ("No", kind `reject_once`); an unanswered one waits for ever; `AskUserQuestion` is disabled when the client has no form elicitation | follows its approval mode (`read-only`, `workspace-write`, `agent` = "Auto review", `agent-full-access`); MCP calls ask every time (`allow_once`, `allow_session`, `allow_always`, `cancel` = No); the step id is the request's id |
| model gateway | its own provider config (LiteLLM, as today) | `gateway` auth method (Anthropic protocol), or `providers/set` (unstable) | `gateway` auth method (OpenAI protocol), `MODEL_PROVIDER`, `CODEX_CONFIG` |
| cancel | prompt ends `cancelled` in 4.0 s; the command is stopped | 28 ms; the command is killed; the session stays usable | 15 to 18 ms; **the command keeps running** until the process exits |
| step statuses | no status at start, then `completed` (never `failed`) | `pending`, then no status, then `completed`/`failed` (**never `in_progress`**) | `in_progress`, then `completed` |
| binary | the installed `hermes` | bundles the Claude Agent SDK; `CLAUDE_CODE_EXECUTABLE` points it at the host's `claude` | bundles `@openai/codex` ^0.166; `CODEX_PATH` points it at the host's `codex` |
| mid-turn notes | - | `_session/steering` extension (advertised in `_meta`) | `_session/steering` extension |

Two things follow from this table and change the design:
- **Option ids are the adapter's, not the kinds.** The bridge answers with the `optionId` of the option whose `kind` is `allow_once` (Yes) or `reject_once` (No),
  never with the kind's word.
- **Claude's sign-in is a terminal program, not an ACP call.** "auth/login through ACP" means, per agent: Codex `authenticate chat-gpt-device-code` (a URL and a
  code, shown on the Runners page); Claude: run the adapter's terminal method under a pseudo-terminal on the bridge and relay its URL and the pasted code, or keep the
  P19-06 sign-in file upload; Hermes: nothing to sign in (it uses the workspace's model gateway key).

**P25-01 is a measuring spike, and nothing after it is built on an unmeasured assumption.** It records, for each adapter on the devbox's real tools, in
`docs/spikes/acp-measured.md`, with the raw JSON lines kept as fixtures under `tools/agent-bridge/test/fixtures/acp/`, and with a cost line per step (Claude on the
shared subscription, Hermes on LiteLLM with the cheapest alias and one-line prompts, Codex only once it is signed in):
- the `initialize` answer with our client capabilities (`auth.terminal: true`, `elicitation.url`, `auth._meta.gateway`), and without them.
- whether `session/new` takes the HTTP MCP server with an `Authorization` header (Hermes without the advertised capability), whether the token shows up in the
  adapter's own logs (`APP_SERVER_LOGS`, Claude's debug log, Hermes' log), and what our tools look like in `tool_call` (title, `name`).
- how each adapter is held to the bot's tool grants (today: Claude `--restricted --tools --allowedTools`, Codex `sandbox_mode` + `approval_policy="never"`): for Claude,
  `_meta.claudeCode.options` with `settingSources: []`, `tools`, `allowedTools`, `extraArgs: {restricted: null, "strict-mcp-config": null}` (measured: without `strict-mcp-config` the signed-in account's claude.ai connectors leak into the session), `allowDangerouslySkipPermissions: false`; for
  Codex, `INITIAL_AGENT_MODE` and `CODEX_CONFIG`; for Hermes, the profile's toolsets. The proof is the tools the agent lists and refuses, not the config we wrote
  (MISTAKES P6-06).
- a subagent (Claude `Agent`, Codex's child, Hermes `delegate_task`): the parent marker, whether the child's steps arrive, how they end.
- which permission requests each adapter sends under the policy above (the aim is: few), the options offered, and what happens when no answer comes.
- `session/cancel` during a tool call: time until `cancelled`, and whether the process can take the next prompt.
- `session/resume` and `session/load` in a new process: does the thread's memory survive, how long a load's replay takes, and whether `cwd` must be the same folder.
- start-up time of each adapter (from spawn to the `session/new` answer), and two sessions at once in one process.
- sign-in with no TTY: Codex device code through URL elicitation; Claude's terminal method under a pseudo-terminal with a pasted code; where each writes its files;
  `logout` and what it removes.
- the model: Claude through the host's `claude` (`CLAUDE_CODE_EXECUTABLE`) on the subscription, and through the `gateway` method to LiteLLM (for pods); Codex the same.

---

## 2. Where ACP sits

```
 thread ─ @coder ─▶ runtime-hermes run job ──HTTP+SSE (the Hermes run API it already speaks)──▶ agent bridge (host, or a pod)
                         ▲  ▲                                                                       │  driver "acp": an ACP client
                         │  └── run events (§3.1) ◀────────────────── SSE ─────────────────────────┤  JSON-RPC over stdio
                         │                                                                          ▼
   P24 approval card ◀───┘ approval.request ◀── session/request_permission ── hermes acp │ claude-agent-acp │ codex-acp │ (opencode acp, §8)
```

- **The bridge is the ACP client.** It already serves the Hermes run API (`POST /v1/runs`, events resumable with `last_seq`, stop, sessions, sign-in gates) for
  Claude Code and Codex (P19-14). A new driver `acp` sits beside `claude-code.ts` and `codex.ts`. The server keeps one door to every agent and needs almost no new
  wire: the bridge sends the frames `gateway.ts` already reads (`message.delta`, `tool.started`, `tool.completed`, `approval.request`) plus a few new ones (§3.1),
  and implements the two calls the server already makes and the bridge does not answer yet: `POST /v1/runs/:id/approval {choice, request_id}` and
  `POST /v1/runs/:id/steer` (a person's note, §4.2).
- **Use the SDK, not a hand-made JSON-RPC.** The client side uses `@agentclientprotocol/sdk` (Apache-2.0), stable v1 entry point, pinned. The adapters are pinned
  dependencies of the bridge package (never `npx` at run time), started with `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` pointing at the host's own CLIs, so there is
  one version and one sign-in store per tool.
- **The protocol is the bridge's business, not a database word.** `bot_runners.agent` keeps naming the tool. `claude-code` and `codex` stay as they are; the bridge
  profile gains `driver: "acp" | "cli"` (default `cli` until P25-17 flips it). Only two words are added, because they are new doors: `hermes-acp` (Hermes started by
  the bridge, which needs the run's token and MCP address like any bridge agent, unlike a Hermes gateway) and, if the owner allows it (§8), `opencode`. The
  migration widens the CHECK on `bot_runners.agent` **and** on `app.hermes_connections.agent` (they share the list, migration 0005). Bots already on a bridge runner
  need no change: their runner switches when its bridge profile does.
- **One process per run, as today.** Each run starts its adapter, opens or resumes the thread's session, prompts once, and ends the process. Concurrent runs are
  concurrent processes (`maxConcurrentRuns`, `TooManyRuns`), and runs of one thread still queue (`KeyedQueue`). Why not one long-lived process per profile: the
  run's token is per run and would have to live in a shared process; a crash would end every run of the profile; and a shared runner serves several teams. A pool
  is reconsidered only if the spike measures a start-up over 5 s, and then never across teams.
- **Resume.** The bridge keeps the thread's ACP session id in `sessions.json` (as it does for Codex). A run in a thread that has one calls `session/resume` when
  advertised (no replay to throw away), else `session/load` (the replay is dropped until the call resolves), else `session/new` with the server's thread context
  as the memory (as today). The `cwd` is the profile's `workdir` (or the pod's repo clone), never the per-run temp folder, so a resumed session finds its folder.
  An unknown session id (state lost) falls back once to `session/new`, as the Claude driver does today. Measured: Claude answers -32002 and Codex -32603 ("no rollout found"); **Hermes answers success** for an unknown id (a fresh state), so for Hermes the bridge must check the answer (`_meta.hermes.sessionProvenance`) or its own session list, and its `resume` replays the history, so updates before the call resolves are dropped like a load's.
- **Stop.** The bridge's stop becomes `session/cancel`, answers any pending permission with `cancelled`, and kills the process group if the prompt has not ended
  10 s later (as today). Measured: Codex's `session/cancel` ends the prompt in 15 ms but leaves its running command alive, so for Codex the process group is always ended after `cancelled`. §4.6 says who may press it.
- **A bridge restart ends its runs.** Runs live in the bridge's memory. When the bridge restarts, the server's event stream gets a 404 and the run fails with one
  plain line ("The runner restarted while Coder was working. Ask again to continue."). The agent's own session is on disk, so the next run in the thread resumes it.

## 3. Events, kept and shown

### 3.1 The run's activity, one vocabulary for every runtime

`BotRuntimeEvent` (sdk `runtime.ts`) already has `text`, `tool`, `tool_result`, `approval` and `result`, used by 36 callers. It is **extended, not doubled**:

| Kind | From ACP (bridge frame) | Fields |
|---|---|---|
| `text` (exists) | `agent_message_chunk` (`message.delta`) | the piece of the answer |
| `tool` (exists, fields added) | `tool_call` (`tool.started` with `step_id`) | + `stepId`, `parentStepId` (a subagent's step), `kind` (the ACP kind), `title`, `paths` |
| `tool_result` (exists, fields added) | `tool_call_update` to `completed`/`failed` (`tool.completed`) | + `stepId`, `diff` (`{added, removed}` counts only), `seconds` |
| `step` (new) | `tool_call_update` that only changes title, paths or status to `in_progress` (`step.update`) | `stepId`, the changed fields |
| `agent` (new) | a step the spike shows is a subagent (Claude `Agent`, Codex's "Start subagent" step, Hermes `delegate_task`; only Claude has child steps) (`agent.update`) | `agentId` (= its `stepId`), `name` (its description), `status` |
| `plan` (new) | `plan` (`plan.update`) | the whole list each time: `{content, status}[]` (priority dropped: nobody needs it on screen) |
| `thinking` (new) | `agent_thought_chunk` (`thinking`, one frame per burst, no text) | `seconds`; **the reasoning text never leaves the bridge** |
| `approval` (exists) | `session/request_permission` (`approval.request`) | as P24; `choices` from the options' kinds |
| `result` (exists) | the prompt's answer (`run.completed`) | + `stopReason`, + `cost` from `usage_update` when the adapter gives one |

Measured differences that change the table (`docs/spikes/acp-measured.md`): Claude never sends `in_progress` (a step is `pending`, then refined by updates with no
status, then `completed` or `failed`, usually 3 to 5 updates for title and paths); Hermes' first `tool_call` has no status and it never sends `failed`; Codex sends
`in_progress` then `completed`. A `plan` frame is built by the bridge for Hermes from the `todo_list` step's `rawInput.todos` (the adapter sends none), and Codex has none.
Steps the bridge hides: Hermes `tool_search` and `tool_describe`, Claude `SubagentHandback`, Codex `Guardian Review`. Every adapter also puts the step's input and output in
`rawInput`, `_meta.claudeCode.toolResponse`, `_meta.terminal_output_delta`, `_meta.terminal_exit` and `content`: the frame builder copies only the whitelisted fields, so
none of these can leave. Claude's `auth/status` and `_auth/status_update` carry the account's e-mail and organization: the bridge keeps the state only.

`mode`, `session_info_update`, `available_commands_update` and `notice` are not shown (nothing on screen needs them). The Hermes gateway runtime sends only
`tool.started`/`tool.completed` with a tool name; the server maps the name to a kind (`lookingLabel` already does this) so its card looks the same with less detail.

**What leaves the bridge.** No tool input, no tool output, no file content, no reasoning. The title is the one exception, because it is what makes a step
readable ("pnpm test --filter web"): it is clipped to 160 characters on the bridge with the run's secrets removed (`redact`), and on the server it goes through
`previewText` (the workspace's redaction, what every text bound for a person goes through) before it is stored or pushed. Paths are made relative to the run's
folder; a path outside it is shown as "a file outside the project". At most 5 paths per step. MCP calls to manythreads tools are titled from the capability
catalogue in plain words ("Handed the card to Code reviewer"), never `mcp__manythreads__tasks_handoff`.

### 3.2 Kept: the run's activity log

A new table `app.run_activity` (runtime-hermes migration): `run_id`, `seq`, `at`, `kind`, `payload jsonb` (the fields above, already redacted), plus
`channel_id` and `thread_root_id` copied from the run. And `app.run_view`, one row per run with the folded state (status, current step, counts per kind,
subagents and their state, the latest plan, `plan_version`, started, ended, stop reason, who stopped it).

- **RLS (row-level security: the database itself filters rows per reader).** Readable by whoever can read the **channel**:
  `channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])`. Not the `bot_runs` door: `bot_runs` is readable by every reader of the team, and a run in a
  private channel would leak its titles and paths to team members who cannot read that channel. A conversation run is readable by its asker only (as `bot_runs`).
  Written by the run job only (system). RLS tests cover: a private channel, a conversation, another team, a bot reading its own run.
- **Volume.** Writes are batched (at most one write per run per second). `thinking` keeps only its seconds. A cap of 2000 rows per run (after it, steps are
  counted in `run_view`, not stored). `at` gets a BRIN index (conventions D3). Rows go with the run under the workspace's run retention.
- **History replay for people.** A run's card can be opened after the fact, on reload, on another device, by someone who joined later. This is what "history
  replay" means on screen; the agent's own replay (`session/load`) is never shown.

### 3.3 Live: pushes to the people looking at the thread

Today's live frames (P20-16: `run.delta`, `run.looking`, `run.ended`) go only to the asker of a conversation. Thread runs need the people who have the thread open.
Sockets are kept per person and delivered through `pg_notify` on every replica, and a socket cannot say what it is looking at today (the hub has only `ping`), so:

- **A watch lease, not socket state.** `PUT /api/threads/:rootId/watch/:leaseId` (the open thread panel calls it every 20 s; it expires after 60 s; closing the panel calls
  `DELETE` on the same path). The lease id is a UUID each browser tab makes up, so one tab closing never ends another tab's lease. It writes an UNLOGGED table
  `app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at)`, like `app.typing`, guarded by a trigger (the channel is the root's channel; at most 50 open leases a
  person, then 429). It works on any number of replicas, needs no kernel change, and the run job reads the watchers when it pushes, joined with the channel's audience at that moment
  (cached for 3 s), so a person who lost the channel stops receiving at once.
- `run.activity` pushes the card's head only: `{runId, seq, state, now, counts, plan: {done, total, current}, planVersion, helpers}` (well under the 7 KB push cap).
  The card fetches `GET /api/runs/:runId/activity?after=seq` only for what is open on screen (the step list) and the plan only when `planVersion` changes.
- `run.delta` (answer text) to the same watchers, with today's limits (80 ms, 4500 bytes).
- The channel's other readers get one small push when a run starts and when it ends (the root's "Coder is working" chip, §5.6), not per step.
- A late joiner reads `GET /api/threads/:rootId/runs` (the thread's runs with their heads), then follows the pushes.

## 4. The pieces

### 4.1 Sign-in and sign-out

The Runners admin page already shows a runner's sign-in state (P19-06, P19-13). For an ACP runner the bridge adds `GET …/v1/auth` (the methods, from
`initialize`, with their own names and descriptions, and whether it is signed in), `POST …/v1/auth/login {methodId}` and `POST …/v1/auth/logout`:

- **Codex:** `authenticate chat-gpt-device-code`. The adapter answers with a URL elicitation (a page and a one-time code); the bridge hands both to the page, which
  shows "Open this page and enter the code ABCD-1234"; the call resolves when the person has done it. `api-key` is offered too.
- **Claude:** the adapter offers only terminal methods. The bridge runs the method's command (`claude-agent-acp --cli auth login --claudeai`, or `claude /login` on a
  server) under a pseudo-terminal, shows the sign-in URL on the page and takes the code the person pastes back. If the spike shows this does not work headless, the
  P19-06 sign-in file upload stays the way (and a `claude setup-token` token pasted on the page is the second way; `CLAUDE_CODE_OAUTH_TOKEN` is already allowed).
- **Hermes:** nothing to sign in; the page says "Uses the workspace's model gateway".
- **Sign out:** ACP `logout` where advertised (Claude, Codex); the page then shows "Signed out".
- A pasted key or code goes straight to the bridge over the runner's authenticated connection, is never stored by the server, never logged, and never shown again.
  The login and logout routes are credential routes: they get an explicit low limit in `ABUSE_ROUTES` and `docs/deploy/rate-limits.md` (conventions D5).
- Only a workspace admin sees these buttons (as today). `signin.ts` `FAILURE_PATTERNS` still pauses a runner whose sign-in was refused: the adapter's error text
  goes through the same table (the spike adds the adapter's own words).

### 4.2 Permission requests become the P24 card

`session/request_permission` becomes the existing `approval.request` frame, so the run job's `settleAgentApproval` (P24-02) files it and waits, with no new
server code. The card says what the agent wants in plain words: the step's kind and title ("Run a command: pnpm test", "Edit ThreadPanel.tsx"), the paths, and
for an edit the +/− counts. Yes answers the option of kind `allow_once`, No the option of kind `reject_once`. "Always" is never offered: silence is not consent,
and a standing rule belongs in the BOT.md. The person's note goes to the agent through `/steer` where the adapter advertises steering; where it does not, the card
hides the note box for that run, so nobody writes words that go nowhere.

**Policy: few questions.** The bridge pre-approves what the bot's grants allow (the same lists the CLI drivers build today), so a permission request is the exception
(a command Hermes thinks is risky, a tool outside the pre-approved list). An agent that asked for every edit would bury the thread in cards; the spike counts them.

**Questions with choices.** Claude's `AskUserQuestion` and Codex's questions arrive as form elicitations only if the client advertises `elicitation.form`. We do
not, in this phase: a bot that needs a person uses `approvals.ask` (P24-03), the one way to ask. URL elicitation is advertised for sign-in only. (§8 asks the owner.)

### 4.3 The run's MCP tools

`session/new`/`resume`/`load` pass the run's endpoint as an HTTP MCP server (`url`, header `Authorization: Bearer <run token>`), so every ACP agent has exactly the
bot's tools (and `approvals.ask`). The token travels only on the adapter's stdin, never in an argument or a file. If the spike finds the token in an adapter's log,
that log is turned off or pointed at the run's temp folder (removed when the run ends). If an adapter cannot take the header, the bridge writes that adapter's own
MCP config into the run folder with the token read from the environment (what the Claude driver does today).

### 4.4 What the bridge does not give the agent

No `fs` and no `terminal` client capability: the agent works with its own tools inside the run's folder, as today. Claude is started without the operator's
settings, memory or hooks (`settingSources: []`, the restricted mode), Codex in the sandbox mode its grants give, Hermes with its profile's toolsets; P25-01 proves
each. The path guard, publisher and push rules of a pod are unchanged.

### 4.5 The to-do list

Two lists exist, and they are kept apart on purpose (§5.5 shows how they read together):
- **The agent's plan** (one run): every `plan` update replaces `run_view.plan`. It is the agent's own steps for its piece of work.
- **The thread's to-do list** (the whole request): kept by the orchestrator. Today the Engineer already keeps "ONE checklist message" with `messages.post` and
  rewrites it with `messages.update` (its BOT.md, step 5 and 7). That stays the fallback; this phase makes it a real card:
  - A tool `tasks.todo` in the tasks plugin (a default capability, like `approvals.ask`): `set {title, items: [{id, text, status, taskId?}]}` makes or replaces the
    thread's list; `update {id, status}` changes one item. Statuses: `waiting`, `working`, `done`, `blocked`. At most 30 items, 200 characters each, through
    `previewText`.
  - Kept in `app.thread_todos` (one row per thread; RLS by the channel's readers; the changes as lines in the card's history). The first `set` posts **one**
    message with `meta.todoRef` (the way a surface's message carries `meta.surfaceRef`), with `skipRefs` so it wakes nobody; later changes update the row and push
    `todo.changed` to the channel's readers. Nothing else is ever posted for it.
  - An item with a `taskId` follows its card by itself: the tasks plugin's own events (`tasks.task.handed_off`, `tasks.task.completed`) set it to `working` (with
    the card's current owner) or `done`, so the list stays live without waking the Engineer.
  - Only the bot that made the list changes it (and the platform, for linked cards). A person cannot tick it: the board is where a person moves work.
- Why not a surface (`surface.render`): a surface is changed only by its own bot inside one of its runs, so it cannot follow a card on its own; and a fixed card
  draws the same everywhere. Why not the board: the board is the team's, and the list is one request's view of it.

### 4.6 Stop, for every run a person can see

- **Who:** the person who asked; the person who started the thread; the team's leads; a workspace admin. Anyone else does not see Stop. (§8 asks the owner.)
- **How:** `POST /api/runs/:runId/stop` records `stop_requested_at` and `stopped_by` on the run (in `run_view`), and the run job, which is already reading the
  run's events, checks the flag every 2 s and stops the handle. This works on any replica (today's in-memory `stopTracked` answers `{ stopped: false }` from the
  wrong replica, and MISTAKES P14-22 says never keep the only copy of a change in memory).
- **After:** what the run had written is posted as its answer (as P20-16 does), and the card says "Stopped by Omar after 2 min".

## 5. How it looks (the part that matters most)

The rule: **a person sees what is happening in one glance and opens more only if they want; nothing scrolls the thread while a bot works; one list of work per
level.** It follows the `#bots` section of `docs/spec/mockups-all.html` (a folded "work log" line under each bot's message, the orchestrator's steps as a card,
a summary/progress/trace switch in the thread header), the tokens of `tokens.css`, dark mode, and ProIcons (no text glyphs; the sketches below use them only
as placeholders).

### 5.1 The run card while the bot works

A run is one card at the bottom of the thread, in the place its answer will take:

```
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ (avatar) Coder   Working · 2 min                              [Stop]      │
 │ (pulse)  Editing ThreadPanel.tsx                                          │  ← now line: one, live
 │ Plan 3 of 5 · Write the e2e test                         ▸                │  ← the agent's plan, folded to its current item
 │ 14 steps · 2 files changed (+48 −6) · 1 helper            ▸               │  ← the work log, folded
 │ The words of the answer as they come, last 2 lines, faded …                │  ← only once the agent writes words
 └───────────────────────────────────────────────────────────────────────────┘
```

- **Header:** avatar, name, a state word and the time. States and their words: Starting ("Starting…" until the first step), Working, Waiting for you (the viewer
  can answer) or Waiting for Omar (someone else must), Stopping…, and then the card folds (§5.3). Stop is a small quiet button, shown only to those who may stop.
- **Now line:** the current step in plain words from its kind and file: "Reading ThreadPanel.tsx", "Editing 2 files", "Running a command", "Searching the code",
  "Reading the web", "Asking Code reviewer" (an MCP call), "Thinking". A subagent's step reads "Helper: reading the tests". Never a raw tool name, JSON or an
  absolute path. It changes at most once a second (a burst of reads reads "Reading 6 files").
- **Plan line:** only when the agent has a plan: "Plan 3 of 5 · <the current item>". Opens the list in place.
- **Work log line:** counts that a non-engineer can read: steps, files changed (with +/−), commands, helpers. Files read and searches are in the step count, not
  their own number (they say little to most people). Opens the step list.
- **Answer preview:** two faded lines, only once the agent writes words; never the reasoning.
- What is never shown by default: the reasoning, tool output, a diff, the list of files read.

### 5.2 Opened: the step list (for engineers, and anyone curious)

- One line per step: an icon by kind, the title (mono for a command or path), its file chips, the time it took, and a done or failed icon. A failed step is in the
  danger colour and stays visible when the list is folded ("1 step failed" in the work log line).
- Steps in a row of the same kind fold into one ("Read 6 files" opens to the six).
- A subagent is one line ("Helper · Reviewing the e2e test · 6 steps · done"); its steps are under it, folded. At most 3 helpers shown, then "+2 more".
- Long lists show the last 8 with "Show all 43"; the list is virtual beyond 200 (the thread's `VirtualList`).
- "Thought for 12 s" lines stand where the agent thought, greyed, with no text to open.
- A viewer picks how much every card shows: **Summary** (the header and the now line only), **Progress** (the card of §5.1) and **Trace** (step lists open). Kept per person
  in the browser. The choice sits behind a quiet "more" button on the card (shown when the card is pointed at or focused, always on a touch screen), not in the thread
  header: a panel header has no room for it, and it is set once and rarely touched.
- **Decided (P25-11 polish): Progress is the default for everyone**, not Summary. Progress is still calm (one live now line, then two folded lines of counts that never
  grow), and the counts are what tells a person who does not read code that work is moving ("7 steps · 1 file changed · 1 helper"); Summary hides that, so a long run looks
  stuck. Engineers who want every step pick Trace; anyone who wants less picks Summary.

### 5.3 When the run ends

The answer is posted as the bot's message, as today, and the card becomes one quiet line under it, as in the mockup: "Work log · 4 min · 14 steps · 2 files
changed · 1 helper ▸". It opens the same step list, read from `run_activity`. A run with no steps shows no line.
- **Stopped:** the line says "Stopped by Omar after 2 min" and the answer is what it had written.
- **Failed:** one plain line, saying who can fix it: "The runner is not signed in. An admin can sign it in on the Runners page." / "The runner restarted while
  Coder was working. Ask again to continue." / "The plan's limit was reached; it resets at 14:00."

### 5.4 Waiting for a person

A permission request draws the P24 card inside the run card (the run card's header says "Waiting for you"), with the plain question, Yes and No, and the note box
when the agent can read a note. The thread's approvals strip (`ThreadApprovals`) and the Approvals list show it too; answering in any place clears the others.

### 5.5 The thread's to-do card, and how it relates to run cards

- The to-do card is the request's list, drawn where its message was posted and **pinned as one line at the top of the thread panel while any item is open** (and only
  while the card's own head is scrolled out of sight, so the list is never on screen twice; a list of 9 or more folds its finished items into one "12 done" line):
  "To do · 3 of 5 · Coder is working on Add the button ▸". Opened: the title, one row per item with a status icon, the owner's avatar (the bot holding the card),
  and a link to the card's thread. When every item is done it says "All done" and unpins itself.
- In an engineering chain, each card is worked on in **its own thread** (the handover announcement's thread, router-tasks). So the request thread shows the to-do
  card and the Engineer's short messages; the item of a card that is being worked on shows the live run's head on a second line ("Coder · working · plan 3 of 5")
  and opens that card's thread, where the run card is. One list per level: the request's list in the request thread, the agent's plan inside its run card.
  Built (P25-11 polish): the second line says who holds the item's card while it is worked on ("Coder is on it"), and the item's words link to the card. The live run of
  that card runs in another thread, which this thread's reader does not follow live, so its plan count is not repeated here.
- The orchestrator's own run card never shows its plan when the same bot keeps a to-do card in that thread: the to-do card is its plan.

### 5.6 Elsewhere

- **Channel view:** the thread's root shows a small chip in its reply line, "Coder is working" (with a pulse) or "To do 3 of 5"; not the card.
- **Conversations:** the same run card replaces today's "looked at" line and Stop in the conversation view (`screens/chat`), so there is one component.
- **Phone (390 px):** the card is full width; the work log line wraps; the step list opens as a sheet; Stop stays reachable in the header.
- **Accessibility:** `aria-live="polite"` on the now line only, at most once per step (never per word); state changes ("Done", "Waiting for you") announced once;
  every fold is a real button with `aria-expanded`; status is never colour alone (icon and word); motion only under `prefers-reduced-motion: no-preference`
  (`motion.css`); focus does not move when the card changes.
- **Words:** every string follows the plain-language rules: "helper", not "subagent"; "step", not "tool call"; "plan", not "todos"; no model or protocol names on
  screen.

---

## 6. Tasks

| ID | Task | Where | Needs | Proof |
|---|---|---|---|---|
| P25-01 | Spike: measure the adapters (§1), keep fixtures, a cost line per step | `docs/spikes/acp-measured.md`, `tools/agent-bridge/test/fixtures/acp/` | - | the page and the fixtures; every later row cites it |
| P25-02 | A fake ACP agent built on the SDK that replays a fixture script (steps, a helper, a plan, a permission request, a slow step to cancel, a sign-in by URL, a failure) | `tools/fake-acp-agent` | 01 | its own tests; used by 03 and the e2e |
| P25-03 | Driver `acp` in the bridge: start, `initialize`, resume / load / new, prompt, cancel then kill, permission ↔ `approval.request` and the `/approval` and `/steer` routes, the frames of §3.1 with redaction, the grant policy per adapter, profile `driver` | `tools/agent-bridge/src/acp/*`, `drivers/acp.ts`, `server.ts` | 02 | unit tests over the fixtures and the fake agent |
| P25-04 | Event vocabulary: `tool`/`tool_result` fields, `step`, `agent`, `plan`, `thinking`, `stopReason`, `cost`; `gateway.ts` maps the new frames; the Hermes gateway's names mapped to kinds | sdk `runtime.ts`, runtime-hermes `gateway.ts` | 03 | tests |
| P25-05 | Runner words `hermes-acp` (and `opencode` if allowed): migration widening both CHECKs, shared types, runner form, routing | bot-runners migration 0006, shared, runtime-hermes | 03 | tests |
| P25-06 | Activity kept: `run_activity`, `run_view` (migration, RLS tests incl. a private channel), the batched writer in the run job, `GET /api/runs/:id/activity`, `GET /api/threads/:rootId/runs` | runtime-hermes, shared api | 04 | RLS and route tests |
| P25-07 | Live: `thread_watchers` lease and its route, `run.activity` and thread `run.delta` pushes, the root's start/end push, the web hook that watches and applies | runtime-hermes, shared, clients/web | 06 | route tests; a two-replica test of a push |
| P25-08 | Stop for thread runs: who may stop, the flag on the run, the job's check, "Stopped by" | runtime-hermes `live.ts`, `run-job.ts` | 06 | tests, incl. a stop from another replica |
| P25-09 | Sign-in and sign-out (§4.1): bridge routes, the pseudo-terminal for Claude (or the fallback), Codex device code, `logout`; Runners page; abuse limits | bridge `server.ts`, `signin.ts`; bot-runners routes; web Runners | 03 | tests with the fake agent's URL sign-in; seen on the Runners page |
| P25-10 | `tasks.todo` (default capability, MCP catalogue entry), `thread_todos` (migration, RLS), the `meta.todoRef` message, items that follow cards, `todo.changed` | tasks plugin, gateway-mcp, shared | 06 | tests |
| P25-11 | The run card (§5.1–5.4) and the to-do card (§5.5), the root chip, the view switch, the conversation view on the same component | clients/web `channels/run-card/*`, `channels/todo-card/*`, styles (`rc*`/`td*` prefixes) | 07, 08, 10 | unit tests; screenshots light, dark, 390 px |
| P25-12 | Seed and e2e: a seeded team with a bot on a bridge runner whose profile runs the fake agent; Playwright: working → helper → waiting → Yes → done and folded; Stop; failed; the to-do card ticking as a card is done; reload shows the record; 390 px | `e2e/`, seed script, `tools/fake-acp-agent` | 11 | the e2e green; its screenshots |
| P25-13 | The Engineer and the template's other orchestrators use `tasks.todo` (the checklist message stays the fallback when the tool is refused); team copies updated by repo commit (template fixes do not reach existing teams) | `templates/engineering`, the live team's `bots/` | 10 | seen in a live thread |
| P25-14 | Pods: the bridge with the ACP driver in the Claude/Codex pod image (model through the `gateway` method to LiteLLM), and `hermes acp` under the bridge in the Hermes pod image (optional for the stop criteria) | deploy/images, hermes-pods, claude-pods | 03, 05 | a pod run live |
| P25-15 | Docs: the bridge and runtime pages, the Runners admin guide (sign in, sign out), the user guide to the run card and to-do card, `conventions.md` (the agent runtimes allowed) | docs | all | - |
| P25-16 | Live proof (§7) on the host: one ACP runner per agent, signed in from the Runners page; the chain placed on each in turn; three threads, one per agent, each delivering a small fix end to end (code, review, test, deploy to the test site, browser check, pull request, merge, live deploy) | live site, `tools/self-build/run.mjs` | all but 14 | the three threads, screenshots, the merged pull requests |
| P25-17 | Switch every bridge runner's profile to `driver: "acp"`, watch a week of runs, then remove the stream-json drivers and their tests | bridge config, `drivers/claude-code.ts`, `codex.ts` | 16 | the runners on ACP; the old drivers gone |

## 7. How the work is done (owner, 2026-11-14)

- This plan is reviewed by an independent Opus agent before it goes into PLAN.md (done once, 2026-11-14).
- Build: Sonnet agents, one work package at a time, in the order 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 15 → 16 → 17, with 14 when
  the host proof is done. 09 (sign-in) can move earlier if a person is ready to sign Codex in, since 16 waits for it.
- The devbox runs one heavy job at a time (CLAUDE.md): inside a package, run `npx vitest run` of that package only; one Playwright run at a time; no lint,
  typecheck, test or Docker build at the same time as a deploy; `df -h /` before a deploy.
- Each package: an independent Sonnet code review, tests written and run, the test code reviewed by a Sonnet agent.
- Visual: an Opus agent checks the run card and the to-do card on the deployed site (light, dark, 390 px; a run with a helper, a waiting run, a stopped run, a
  failed run, a long run of 40+ steps, a non-engineer's view in Summary) and fixes what is wrong; this is where most of the work goes.
- Deploy after each package that changes what runs (`bash tools/devbox/deploy.sh`), check, commit and push.

## 8. Risks, and what the owner must give or decide

**Decisions (taken 2026-11-14 on the owner's behalf, with the defaults the review proposed; the owner may overrule any):**
1. **OpenCode** is allowed: the owner named it in the request. It is a bridge profile `opencode` on the same `acp` driver, measured like the others, after P25-16;
   it is not in the stop criteria. `conventions.md` is updated in P25-15 to list it.
2. **Who may stop a run:** the asker, the thread's starter, the team's leads and admins.
3. **Questions with choices:** `approvals.ask` (yes/no and a note) stays the one way a bot asks; ACP form elicitation is answered "cancelled" for now.
4. **Permission policy:** what the bot's grants allow is pre-approved, so cards are rare (as today).
5. **Subagent detail:** the stable fallback markers only.

**Inputs:**
- **Sign-ins.** Claude Code needs the shared subscription signed in on the host (it is), Codex is signed in on the host with ChatGPT (checked 2026-11-14: `codex login status`).
  P25-09 lets an admin renew either from the Runners page; a person must open the page and enter the code.
- **Spend.** The Hermes chain runs on the platform's LiteLLM key, capped at $10; one delivery by the whole chain may cost several dollars, and the spike costs some
  cents. Claude and Codex run on their subscriptions. If the cap is near, the Hermes proof waits for the owner.

**Risks:**
- **Adapters move fast.** `claude-agent-acp` is at 0.107 and the protocol has unstable parts. Versions are pinned, the fixtures are the contract, and a bump is a
  task with the fixtures re-recorded.
- **Adapter facts.** Hermes advertises no HTTP MCP support and no logout; subagent markers differ per adapter. Where an adapter lacks something, its card shows
  less (no helper lines) and the spike page says so; the card must degrade without breaking.
- **Claude's headless sign-in** may not work under a pseudo-terminal; the sign-in file upload stays as the fallback.
- **The chain itself.** The self-build proof (P22-04) never completed; its open blockers (a card that cannot be reworked after a first publish, exit 5) may stop a
  delivery for reasons that are not ACP. Those are fixed as they are met, under their own task ids.

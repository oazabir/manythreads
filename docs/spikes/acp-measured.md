# P25-01: the three ACP adapters measured on the devbox (2026-11-14)

ACP (Agent Client Protocol) is JSON-RPC, one JSON object per line, over an agent process's stdin and stdout. This page holds what was seen on the wire
from the three adapters the bridge will drive, so nothing later in Phase 25 is built on a guess. The plan's own reading of the adapters' code is in
`docs/plans/acp.md` §1; where a measurement disagreed, the plan was corrected (see "What the plan had wrong").

Rules this page follows: texts, field names, versions, numbers and yes/no answers only. No token, no key, no sign-in file content. E-mail addresses and
account names that the adapters report are removed from the fixtures. **(source)** marks a fact read from the adapter's code and not seen on the wire.

## What was run

| Adapter | Version | How it was started | Model |
|---|---|---|---|
| Hermes | `hermes acp`, Hermes 0.21.5 | `HERMES_HOME` = a scratch folder holding a copy of the model settings and the platform's LiteLLM key (alias `default`) | LiteLLM alias `default` |
| Claude | `@agentclientprotocol/claude-agent-acp` 0.107.0 | `node dist/index.js`, `CLAUDE_CODE_EXECUTABLE` = the host's `claude` 2.1.323 (signed in with claude.ai) | `haiku` (Haiku 5.5) |
| Codex | `@agentclientprotocol/codex-acp` 2.6.0 | `node dist/index.js`, `CODEX_PATH` = the host's `codex` 0.166.0 (signed in with ChatGPT) | `gpt-6-luna`, reasoning effort `low` |

- The client is `tools/agent-bridge/spike/acp-probe.mjs`: no dependencies, raw JSON-RPC, every line recorded with its time. The scenarios are in
  `tools/agent-bridge/spike/scenarios/`; they need the adapters installed in a scratch folder (`npm i --save-exact @agentclientprotocol/claude-agent-acp@0.107.0
  @agentclientprotocol/codex-acp@2.6.0 @agentclientprotocol/sdk@2.7.0`, folder from `ACP_SPIKE_DIR`, default `/tmp/claude-0/acp-spike`). The probe speaks protocol
  version 1 only (the Claude adapter serves a draft v2 to a client that asks for it; we do not).
- The raw lines, with paths, e-mail addresses, tokens and one-time codes removed, are in `tools/agent-bridge/test/fixtures/acp/<agent>-<scenario>.jsonl`
  (one JSON object per line: `t` milliseconds since the process started, `dir` `c2a` client to agent or `a2c` agent to client, `msg`). They are the contract
  for the bridge's unit tests (P25-03). A bump of an adapter's version means recording them again.
- Every prompt ran in a throwaway folder (`work/`, a `package.json` and a `notes.txt`), never the repo. The platform's MCP address was replaced by a tiny local
  HTTP MCP server with one harmless tool, `mt_note`, that checks an `Authorization: Bearer` header (a made-up token).
- **Not touched:** the host's Claude and Codex sign-ins. `logout` was never called against them, and `authenticate` was only called against empty scratch
  config folders (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) or with the in-memory `gateway` method.
- **Spend:** Hermes 3 prompts, 26.2 k tokens in all (16 841, 7 392, 1 989). Claude about 25 short prompts on Haiku, a few cents of notional cost. Codex about 18
  short prompts on the cheapest model at low effort. Cost per step is in "Usage and cost".

## Summary

| | Hermes | Claude | Codex |
|---|---|---|---|
| Start (spawn to `initialize` answer) | 1.2 s warm; **59.7 s the first time in a new `HERMES_HOME`** (it installs its Python dependencies; the home is then 1.6 GB) | 0.4 s | 0.2 to 0.4 s |
| `session/new` answer | 1.1 s (1.5 s with an MCP server) | 0.9 to 1.3 s | 0.3 to 1.4 s |
| Sign-in methods offered | `custom` (agent, uses the configured provider key), `hermes-setup` (terminal) | none unless the client advertises `auth.terminal`; then two terminal methods (`claude-ai-login`, `console-login`) and `gateway`, `gateway-bedrock` | `api-key`, `chat-gpt`; with our client capabilities also `chat-gpt-device-code` and `gateway` |
| `logout` | not advertised | advertised | advertised |
| Signed-in state | none | `auth/status` request and `_auth/status_update` push (carries the account's e-mail: never forward) | `_auth/status_update` push only |
| HTTP MCP with an `Authorization` header | works, although `mcpCapabilities` is not advertised | works (`http`, `sse`) | works (`http` only) |
| Does the token reach a log? | no (stderr and home searched) | no (stderr, adapter log, session files) | no (`~/.codex` searched) |
| `plan` updates | **never sent** (see below) | yes, from `TaskCreate`/`TaskUpdate`, the whole list each time | **not seen** |
| Helper (subagent) | `delegate_task` is one step; it returns at once, the child runs in the background and its steps never arrive | `Agent` tool; the child's steps arrive with `_meta.claudeCode.parentToolUseId` | steps "Start subagent X", "wait", "Complete subagent X"; no child steps, no marker |
| Step statuses seen | none at start, then `completed` | `pending`, no status on updates, then `completed` or `failed` (never `in_progress`) | `in_progress`, then `completed` |
| Permission options | `allow_once`, `allow_session`, `allow_always`, `deny`, `deny_always` **(source)** | `allow-once` (allow_once), `reject` (reject_once) | `allow_once`, `allow_session`, `allow_always`, `cancel` (reject_once) |
| `session/cancel` | prompt ends `cancelled` after 4.0 s; the command is stopped | prompt ends `cancelled` after 28 ms; the command is killed | prompt ends `cancelled` after 15 to 18 ms; **the command keeps running** until the adapter exits |
| `session/resume` | 2.0 s, **replays** the history | 0.47 s, no replay | 0.38 s, no replay |
| `session/load` | 1.5 s, replays 24 updates | 0.46 s, replays 4 message chunks | 0.29 s, replays 6 message chunks |
| Unknown session id | no error (resume answers as if new; load answers an empty result) | error -32002 "Resource not found" | error -32603 "Internal error", `data.details` "no rollout found for thread id" |
| `cwd` must match on resume | no | no | no |
| Two sessions in one process | yes | yes | yes |
| Cost in `usage_update` | no | yes, `cost.amount` (USD, notional on a subscription), cumulative per session | no (tokens only) |

## Initialize and capabilities

Hermes answers the same with and without our client capabilities.

- Agent capabilities: `loadSession: true`, `promptCapabilities.image`, `sessionCapabilities` `fork`, `list`, `resume`. No `mcpCapabilities`, no `auth`.
- `session/new` returns `models` (24 of them, including every Anthropic model, which is the adapter's list, not what is usable), `modes` (`default`, `accept_edits`,
  `dont_ask`; current `default`) and then sends `available_commands_update` and one `usage_update` (context 9.5 k of 262 k).

Claude (`initialize` with our capabilities: `auth.terminal: true`, `auth._meta.gateway: true`, `elicitation.url`):
- `mcpCapabilities` `http` and `sse` true; `auth` `logout` and `status`; `sessionCapabilities` `resume`, `list`, `close`, `delete`, `fork`, `title`, `options`,
  `status`, `additionalDirectories`; `_meta.steering.supported`.
- `session/new`: the mode starts as `auto` ("Claude handles permission decisions"), model `sonnet`. The bridge has to set the mode it wants.
- Without `auth.terminal` the answer's `authMethods` is an empty list.

Codex (with and without our capabilities):
- `mcpCapabilities` `http: true`, `sse: false`; `auth.logout`; `sessionCapabilities` `resume`, `list`, `close`, `delete`, `fork`, `title`, `additionalDirectories`,
  `subagents`, `systemPrompt`; `_meta.steering.supported`.
- `session/new` returns the modes `read-only`, `workspace-write`, `agent` ("Auto review", the start mode), `agent-full-access`; config options `mode`,
  `collaboration_mode` (`default`, `plan`), `model`, `reasoning_effort`, `fast-mode`.
- The env var `INITIAL_AGENT_MODE` sets the start mode (`workspace-write` worked). `CODEX_CONFIG` did not pre-approve MCP calls (below).

## Sign-in and sign-out

- **Hermes:** `authenticate custom` answers `{}` at once (checks the configured key; nothing to sign in). The other method, `hermes-setup`, is a terminal method
  (`hermes acp --setup`). No `logout`, no `auth/status` (error -32601).
- **Claude, terminal method under a pseudo-terminal.** Run as the adapter's own command (`node dist/index.js --cli auth login --claudeai`, with an empty
  `CLAUDE_CONFIG_DIR`, inside `script -qfc`). It prints "Opening browser to sign in…", "If the browser didn't open, visit: <a claude.com/cai/oauth/authorize URL>"
  and "Paste code here if prompted >", then waits. So a page can show the URL and pass back a pasted code. It writes only `.claude.json` into the config folder
  before the code is pasted. Not completed (it would sign in a real account). **Not tested:** whether it also works with no pseudo-terminal at all, and the paste.
- Claude's host sign-in is `~/.claude/.credentials.json`; Codex's is `~/.codex/auth.json` (file names only; the contents were never read).
- **Claude `auth/status`** answers `{state, accounts[{label, active, email, organization, _meta.claudeCode{kind, plan}}]}`; the same arrives as `_auth/status_update`
  and `auth/status_update` pushes after `initialize`, after `session/new` and at the start of a prompt. The e-mail and organization are in it: the bridge must
  keep only the state (`authenticated` / `unauthenticated` / `unknown`) and the kind.
- **Claude `gateway`:** `authenticate {methodId: "gateway", _meta: {gateway: {baseUrl, headers}}}` answers `{}` with no signed-in account; the adapter then logs
  `apiType=anthropic baseUrl=<url>` for the session and calls `HEAD <baseUrl>/api/hello`. It is kept in memory; `logout` clears it. `gateway-bedrock` is also offered.
  A full prompt through a gateway was not run (it needs a real endpoint: P25-14).
- **Codex device code:** `authenticate chat-gpt-device-code` makes the agent send a request `elicitation/create` with
  `{mode: "url", url: "https://auth.openai.com/codex/device", message: "Sign in to ChatGPT and enter this code: XXXX-XXXXX", elicitationId, requestId}`.
  The code is only inside the message text. If the client answers `{action: "accept"}`, `authenticate` stays open (it was still open after 12 s, waiting for the
  person). If the client answers `{action: "cancel"}`, `authenticate` fails at once with -32000 "Authentication required: Sign-in did not complete". Run
  against an empty `CODEX_HOME`; the code was never used. `chat-gpt-device-code` and `gateway` appear only when the client sends our capabilities.
- **Codex `logout`** against the empty scratch home answered `{}`. After `initialize` it pushes `_auth/status_update` (`kind` `account` with the plan name, or `none`).
  No `auth/status` request (-32601).
- **Codex `gateway`:** accepted, in memory, `kind: "gateway"`, no call made at `session/new`.
- What `logout` removes on the real hosts was not run. **(source)** Claude's runs the CLI's `auth logout` and clears the in-memory gateway; Codex's asks its app
  server to log out (it removes `auth.json`).

## HTTP MCP server with a bearer header

All three took `mcpServers: [{type: "http", name: "manythreads", url, headers: [{name: "Authorization", value: "Bearer …"}]}]` in `session/new` and the model
called `mt_note`. The test server saw the right header on every request and no wrong or missing one.

| | First requests the MCP server saw |
|---|---|
| Hermes | `HEAD`, `GET`, then `POST initialize`, `notifications/initialized`, `tools/list` (client `python-httpx`) |
| Claude | `POST server/discover` (an unknown method: our server answered an error and it carried on), `initialize`, `notifications/initialized`, a `GET` for an event stream (answered 405: fine) |
| Codex | `POST initialize`, `notifications/initialized`, `tools/list` (client `codex-mcp-client`) |

The platform's MCP route therefore has to tolerate `HEAD`, `GET` and an unknown first method and answer the rest normally.

The made-up token appeared in no file: not in any adapter's stderr, Claude's adapter log (`CLAUDE_AGENT_LOGS`) or session files under `~/.claude`, `~/.codex`, or the
Hermes home. Hermes logs the MCP URL (`POST http://127.0.0.1:<port>/mcp`) at INFO level, so a token in the URL would have leaked; the header does not.

## What a step looks like on the wire

Common to all three: `tool_call` then `tool_call_update`s, with `toolCallId`, `title`, `kind`, `status`, `locations[{path}]`, `content[]`. **Every adapter also sends the
step's input and output**, which the bridge must drop:

| | Input | Output |
|---|---|---|
| Hermes | `rawInput` (all arguments), the title carries arguments too (`mcp__manythreads__mt_note: hi`) | `content[]` text of the result |
| Claude | `rawInput` (grows over several updates), `content` | `_meta.claudeCode.toolResponse` (file content, command output), `content[]` |
| Codex | `rawInput` for commands (`command`, `cwd`) | `_meta.terminal_output_delta.data`, `_meta.terminal_exit`, `content: terminal` |

Titles: Hermes `read_file: package.json`, `search_files: *`, `terminal: <command>`, `todo_list: planning 2 task(s)`, `tool_search: …`, `delegate_task: 1 tasks: Read /abs/path…`.
Claude starts generic (`Terminal`, `Read File`, `Find`, `Task`) and the title is refined by later updates (`touch spike-a.txt`, `Read package.json`, ``Find `/abs/path` `*` ``).
Codex: `List files`, `Read file '/abs/path'`, the command itself, `mcp.manythreads.mt_note` (`_meta.is_mcp_tool_call`), `Editing files`, `Guardian Review`. Absolute paths and
command text appear, so the plan's clipping, `redact` and relative paths in §3.1 are needed for all three.

Kinds seen: `read`, `search`, `execute`, `edit`, `think`, `other`. Hermes marks MCP and todo calls `other`; Claude marks the helper call `think`; Codex marks an MCP call `execute`.

- **Statuses.** Claude never sends `in_progress`: `pending`, then updates with no status field, then `completed` or `failed`. Codex starts `in_progress` and ends
  `completed` (a short tool call has both in the same millisecond). Hermes' `tool_call` has no status; the update says `completed`. Hermes never sent `failed` (a cancelled
  command is `completed` with the text "[Tool execution cancelled — terminal was abandoned: explicit stop requested]"). So P25-04's `step` frame (status to `in_progress`) will be
  rare: title and path refinements are the useful updates, and for Claude there are 3 to 5 per step.
- **Edits.** Claude (`Write`, `Edit`, kind `edit`) and Codex (`Editing files`, kind `edit`) both carry `content: [{type: "diff", path, oldText, newText}]`, so `{added, removed}` can be counted
  on the bridge. Claude sends the diff in an update, Codex in the `tool_call`. Codex's `_meta.kind` says `add` or `update`. Hermes was not run on an edit (prompt budget).
- **Thinking.** Hermes sends `agent_thought_chunk` with the reasoning text, one chunk per few words: 480 for one prompt. Codex sends a few. Claude sent none on Haiku.
  Text must be dropped; only a count and the time are kept.
- **Other updates** the bridge ignores: `available_commands_update` (twice per session, carries the operator's own slash commands and skills; removed from the fixtures),
  `session_info_update` (title; Codex also `threadStatus` with `waitingOnApproval`), `config_option_update`, `user_message_chunk` (replay), and for Claude `_auth/status_update`.

## Plan updates

- **Claude:** `plan` with the whole list each time (`entries[{content, status, priority}]`, statuses `pending`, `in_progress`, `completed`). The list comes from
  `TaskCreate`, `TaskUpdate` and `TaskList`, which are what Claude Code offers an SDK session. **`TodoWrite` is not available** (the model said so when `tools` named it). The
  Task tool calls themselves are not sent as steps. 6 `plan` updates for a 2-item list (the same list is sent more than once).
- **Codex:** no `plan` update in any run, including a prompt that asked for a plan with the plan tool and a run in `collaboration_mode: plan` (that mode answers with a step
  titled "plan" and a permission request "Implement this plan?", `kind: switch_mode`, options `implement_plan` and `revise_plan`). The model said "no plan tool is available".
- **Hermes:** no `plan` update. Its list tool in 0.21.5 is called `todo_list`, and the adapter (`acp_adapter/events.py`) builds a `plan` only for a tool named `todo`. The list
  arrives as a step (`todo_list: planning 2 task(s)`, then `todo_list: updating 2 task(s)`) whose `rawInput.todos[{id, content, status}]` has the items (`merge: true` on updates). The
  bridge can build the plan from that.
- Hermes first runs `tool_search` and `tool_describe` steps (kind `other`) to load a deferred tool; with the LiteLLM alias that took 22 s of the first prompt's 77 s. They should not be shown.

## Helpers (subagents)

- **Claude:** the model calls `Agent` (the adapter titles it "Task", kind `think`, `_meta.claudeCode.toolName: "Agent"`); its title becomes the description ("Read package.json name field").
  Each of the helper's steps arrives as an ordinary `tool_call` with `_meta.claudeCode.parentToolUseId` = the parent step's `toolCallId` (the full `toolu_…` id). The helper's own
  last step is a `SubagentHandback` tool (the helper handing its report back; hide it). The parent step ends `completed` with the helper's result in `_meta.claudeCode.toolResponse`
  (`agentId`, `agentType`, `toolsUsed`, `handbackReport`). 8 s end to end on Haiku.
- **Codex:** three steps of kind `other`: `Start subagent read_package_name`, `wait`, `Complete subagent read_package_name`. The child's own steps do not arrive and nothing marks a
  parent. The adapter advertises `sessionCapabilities.subagents` (needs an unstable client capability, which §8 decision 5 leaves off).
- **Hermes:** one step `delegate_task: 1 tasks: Read …` (kind `execute`) whose result says `{"status": "dispatched", "mode": "background", …}` and that the child's result "re-enters the
  conversation as a new message when it finishes". The step ends at once, no child steps arrive, and the result is delivered into the parent conversation later. The first prompt ended
  with "subagent dispatched". Whether the report arrives inside the same prompt or only in a later turn was not measured (budget). It is a risk for the run job: a run that ends at
  `end_turn` may end before the child's report.

## Permission requests

Policy used for the measurements: the tool is not pre-approved, or the mode asks.

- **Claude** (restricted options, mode set to `default`): `Bash touch spike-a.txt` sent `session/request_permission` with
  `toolCall {toolCallId (the same id as the step), name, status: "pending", rawInput, title, kind: "execute", content, locations}` and `options [{optionId: "allow-once", name: "Yes", kind: "allow_once"},
  {optionId: "reject", name: "No", kind: "reject_once"}]`. A read-only command such as `echo hi` was not asked. Answering the `reject` option made the step `failed` with
  `_meta.claudeCode.nonExecutionKind: "permission-rule"` and the model replied "Declined". **No answer: the prompt waited, still open after 25 s; there is no timeout on the adapter's side.**
  `session/cancel` plus answering the pending request `{outcome: "cancelled"}` ended the prompt with `cancelled` in 40 ms.
- **Codex:** every MCP tool call raised a request even in `workspace-write`: `toolCall {toolCallId: "exec-<uuid>" (same as the step), kind: "execute", status: "pending"}`, `_meta.is_mcp_tool_approval: true`, no title and no
  server name (join to the step by id), options `allow_once` ("Allow"), `allow_session` ("Allow for this session", kind `allow_always`), `allow_always` (kind `allow_always`), `cancel` (kind `reject_once`).
  `CODEX_CONFIG` with `mcp_servers.manythreads.default_tools_approval_mode: "approve"` did not stop it. In the start mode `agent` ("Auto review") it asked nothing but added a `Guardian Review` step of about 5 s, so
  the bridge should set `workspace-write` (or `read-only`) itself. In `read-only`, a write is refused by the sandbox with no request and no step. In `workspace-write`, writing to `/tmp` was allowed and writing to `/root`
  failed with "read-only" (no request). A command that needed approval was seen only inside plan mode: options `allow_once` ("Yes, proceed") and `cancel` (kind `reject_once`, "No, and tell Codex what to do differently"),
  with the command in `toolCall.title` and `rawInput`. An unanswered request was not measured.
- **Hermes:** no request was raised in 3 prompts (`node -e`, file reads and an MCP call are not "dangerous"), so none was seen. **(source)** options `allow_once`, `allow_session` (kind `allow_always`),
  `allow_always` (kind `allow_always`), `deny` (kind `reject_once`), `deny_always` (kind `reject_always`); fewer when the gate re-asks every time; the request's `toolCallId` is a separate `perm-check-N`
  with `rawInput {command, description}` and `title "<description>: <command>"`, **not** the id of the step; an unanswered request is denied after `approvals.timeout` (default 300 s).

## Cancel, and a process that goes on

- **Claude:** `session/cancel` while a 90-second command ran: the prompt ended `cancelled` 28 ms later, the step ended `failed` with `nonExecutionKind: "user-rejected"`, the command was gone, and the same session
  took the next prompt. The process stayed up.
- **Codex:** `session/cancel`: the prompt ended `cancelled` after 15 to 18 ms, **the command was still running 12 s later**, and the step never got a final update (it stays `in_progress`). The command
  (inside the sandbox helper `codex-linux-sandbox`/`bwrap`) ended only when the adapter process exited. The next prompt in the session worked. The plan's "ends the run" therefore has to end the adapter
  process (the process group), not just wait for `cancelled`.
- **Hermes:** the prompt ended `cancelled` 4.0 s after `session/cancel`; the step ended `completed` with the "abandoned" text above; the command was gone; the second session in the same process kept working and finished.

## Resume, load and history

Memory test: "remember pineapple-17", new process, resume, "what was the word?" All three answered correctly after `session/resume`.

- **Claude:** `resume` 0.47 s, no replay (the answer has `modes`, `configOptions`; four notifications, none of them history). `load` 0.46 s, replay of 2 `user_message_chunk` and 2
  `agent_message_chunk` before the answer. Resume from another `cwd` worked. Unknown id: error `-32002`, `message: "Resource not found"`, `data.sessionId`. `session/list {cwd}` lists sessions with `title` and `updatedAt`.
- **Codex:** `resume` 0.38 s, no replay (its answer has no `sessionId`); `load` 0.29 s, replay of 2 user and 4 agent chunks plus `session_info_update` and `usage_update`. Another `cwd` worked. Unknown id: `-32603` "Internal error",
  `data.details` "no rollout found for thread id <id>" (for both methods).
- **Hermes:** `resume` takes 2.0 s and **replays** the whole earlier conversation (7 steps and their updates, thoughts, messages) before it answers. `load` 1.5 s replayed 24 updates. Another `cwd` worked.
  **An unknown id is not an error:** `resume` answers `{models, modes}` as if it were new, `load` answers an empty result. The bridge must tell "found" from "not found" (the answer for a found session carries
  `_meta.hermes.sessionProvenance`), or it will think a lost session was resumed.
- The bridge's plan (§2) is right for Claude and Codex: resume when advertised, no replay to discard. For Hermes it must drop the updates that arrive before the `resume` call resolves.

## Two sessions at once

One process, two `session/new`, two prompts at once: all three ran both. Claude's second session finished in 1.3 s while the first ran a command; Codex's in 2.1 s; Hermes' first session finished in 23.7 s while the second was cancelled
after 4 s. The updates are told apart by `sessionId`.

## How each adapter is held to the bot's grants

The proof is what the agent lists and refuses, not the config written.

- **Claude:** `_meta.claudeCode.options` `{settingSources: [], tools: [...], allowedTools: [...], extraArgs: {restricted: null, "strict-mcp-config": null}, allowDangerouslySkipPermissions: false}`.
  **Without `"strict-mcp-config"` the session still carried the signed-in account's claude.ai connectors** (Gmail, Calendar, Drive, Docs, Stripe and others, found by asking the model for its tool names) next to the
  manythreads server, even with `settingSources: []` and `restricted`. That also made the first prompt cost 370 k tokens against 66 k with it. With it, the model listed `Agent, Glob, Grep, Read, TaskCreate, TaskList,
  TaskUpdate` and `mcp__manythreads__mt_note` and nothing else, and asked to use `Bash` and `Write` it said it has neither. `tools` has to name `TaskCreate`, `TaskUpdate`, `TaskList` (for the plan) and `Agent` (for helpers).
  `AskUserQuestion` is disabled by the adapter when the client has no form elicitation **(source)**.
- **Codex:** the mode (`INITIAL_AGENT_MODE` or `session/set_config_option mode`) is the grant: `read-only` refused a write silently; `workspace-write` allowed the work folder and `/tmp` and refused `/root`.
  Models and effort are config options (`model`, `reasoning_effort`). The sandbox leaves empty `.git`, `.codex`, `.agents` and `.aws` folders in the work folder after a run (they appeared in `work/` during Codex runs;
  an empty `.git` in a folder that is not a repository can confuse git commands).
- **Hermes:** `platform_toolsets: {acp: [file, todo]}` in the Hermes home's `config.yaml`. The slash command `/tools` (answered by the adapter itself, no model call, so no cost) listed 23 tools by default
  (browser, `delegate_task`, `execute_code`, `memory`, skills and more) and 7 with it (`patch`, `read_file`, `search_files`, `write_file`, `tool_search`, `tool_describe`, `tool_call`; the `todo` tool sits behind
  `tool_search`). No refusal prompt was run (budget). A Hermes home cannot be copied to another path (the dependency environment inside it has absolute paths: `hermes acp` failed with "dependency environment is
  missing or outside this install"), so a per-run home must be created in place or the profile's home shared.

## Usage and cost

- **Claude:** every step is followed by `usage_update {used, size: 1000000}`. The last one of a prompt also carries `cost: {amount, currency: "USD"}`, **cumulative for the session** and notional on a subscription, and
  `_meta["_claude/rateLimit"]` (status, window, `resetsAt`, utilization of the seven-day window), `_meta["_claude/model"]`. The prompt answer has `usage {inputTokens, outputTokens, cachedReadTokens,
  cachedWriteTokens, totalTokens}`. Measured (Haiku 5.5, restricted, strict MCP): the three-prompt scenario (plan, glob, read, MCP call, helper, refused Bash) $0.0038 (102 k tokens); a one-prompt edit $0.0008; a
  four-prompt permission run $0.0009. The same first prompt without strict MCP: $0.020 and 370 k tokens.
- **Codex:** `usage_update {used, size: 258400}` and the prompt answer's `usage` (including `thoughtTokens`) and `_meta.quota.model_usage`. No money amount. One two-prompt scenario: 125 k tokens (most of it cached reads).
- **Hermes:** one `usage_update {used, size: 262144}` at the end of a prompt, and `usage` on the answer. 16 841 tokens for the 6-model-call first prompt (77.5 s, about 11 s per call on the `default` alias);
  7 392 and 1 989 for the other two. No money amount: spend is read from LiteLLM, not from the adapter.

## What the plan had wrong or missing (plan text corrected)

1. Claude has no `TodoWrite` in an SDK session; the plan comes from `TaskCreate`/`TaskUpdate`/`TaskList` (the tools list must name them).
2. Hermes 0.21.5 sends no `plan`: its tool is `todo_list`, the adapter looks for `todo`. Build the plan from the step's `rawInput.todos`.
3. Codex sent no `plan` in any run.
4. `settingSources: []` and `--restricted` do not keep the account's claude.ai connectors out. Add `strict-mcp-config` (it was already in today's CLI driver).
5. Claude's permission option ids are `allow-once` and `reject`; Codex's `cancel` is the "No" (kind `reject_once`); Hermes' permission request id is not its step's id.
6. Claude never sends `in_progress`; Hermes' first `tool_call` has no status.
7. Claude's `Task` call is named `Agent` in the SDK (the adapter titles it "Task"); the child's last step is `SubagentHandback`.
8. Hermes: `resume` replays; an unknown id is not an error. Claude and Codex have different errors for it (-32002, -32603).
9. Hermes accepts an HTTP MCP server with a header although it does not advertise `mcpCapabilities`.
10. Claude's sign-in under a pseudo-terminal does print a URL and a paste prompt; the Codex device-code URL and code arrive as one `elicitation/create` message text.
11. Hermes' `delegate_task` runs in the background and returns at once; its child's report is delivered later into the parent conversation.
12. Codex's `session/cancel` does not stop the running command. The adapter process must be ended.

## What this means for the next tasks

- **P25-03 (driver):** a field whitelist for steps (`toolCallId`, `title`, `kind`, `status`, `locations[].path`, diff counts, Claude's `parentToolUseId` and `toolName`); the grant policy per adapter above; set the mode
  (Claude `default`, Codex `workspace-write`); answer Codex's MCP approvals for the platform's own server with `allow_session` (matched to the step by id); on stop, `session/cancel`, answer pending
  requests `cancelled`, then end the process group (Codex needs it); resume handling per adapter (found or not found, Hermes replay); tolerate `HEAD`/`GET`/`server/discover` on the MCP route; hide `tool_search`,
  `tool_describe`, `SubagentHandback`, `Guardian Review`.
- **P25-04 (events):** a Hermes plan from `rawInput.todos`; a helper's steps for Claude only; Hermes and Codex helpers are one line with no children.
- **P25-09 (sign-in):** Codex device code is a URL plus a code in one message, and `accept` keeps `authenticate` waiting; Claude's terminal method works under a pseudo-terminal; Claude's `auth/status` gives the state.
- **P25-14 (pods):** a Hermes home takes about 60 s and 1.6 GB the first time; bake it into the image. Gateway runs were not measured end to end.
- **Not measured** (budget or safety): Hermes permission request on the wire, Hermes edit step, Hermes refusal of a tool outside its toolset, an unanswered Codex request, Claude's paste step and no-pseudo-terminal login,
  `logout` against a real sign-in, a prompt through a gateway, whether a Hermes helper's report arrives inside the same prompt.

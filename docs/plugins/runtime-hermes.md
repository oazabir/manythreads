# runtime-hermes

The agent runtime (SPEC §7.1, §10.2; PLAN P5-10). One `bot_runtime` provider — `hermes` — that renders a Hermes profile from a
`BOT.md`, starts and stops one Hermes process per run in it, plus the router that decides which posted message wakes which bot
and the job that runs one. `runtime-rules` registers the other provider, so the plugin pair is the whole runtime surface.

```
channel.message.posted ─▶ router (system tx) ─▶ job runtime-hermes.run (system tx)
                                                   ├─ read bots/<slug>/BOT.md at main, check the sha
                                                   ├─ ctx.runs.open         → one run, one MCP URL + token
                                                   ├─ render the profile    → SOUL.md + config.yaml
                                                   ├─ start Hermes          → --format stream-json, prompt on stdin
                                                   ├─ stream                → text · tool · tool_result · result
                                                   ├─ post the reply        → messages.post as the run's bot
                                                   └─ ctx.runs.close        → done | failed | stopped
```

## Triggers

One subscription on `channel.message.posted`, one decision per active bot of the message's team. The three triggers this phase
routes, and what each honestly means today:

| Trigger | Fires when | Notes |
|---|---|---|
| `conversation` | the message landed in the bot's own channel (`channels.bot_id = bot.id`) | the unlisted per-bot channel P5-16 creates; the shape a person talking to a bot takes |
| `mention` | the body names the bot (`@<slug>`), in the channels the trigger's `source` lists (all of them when it lists none) | read with the composer's parser, so a handle in a code span, a fence, a URL or an email wakes nobody |
| `channel_message` | a message in a channel the trigger lists, or anywhere on the bot's team when it lists none | the trigger for a bot that answers everything |

Never fires: a message a **bot** wrote (no bot answers a bot here — that is delegation, P6), a private channel, a DM, an
archived channel. One message starts at most one run per bot (the job's dedupe key `runtime-hermes:<botId>:<messageId>`) and the
highest-priority trigger wins: conversation, then mention, then channel_message. A `routine`, `task_assigned`, `inbox` or
`webhook` trigger is in `BOT.md` but not routed by this plugin yet.

The run's prompt is one line of context and the message: `Nadia in #dev:\n\n@coder what changed?`. Behaviour is `SOUL.md`'s
job, never a prompt template's.

## The profile

`render` is pure, so a definition's profile can be asserted in a test instead of inspected in a container. A profile is a
`HERMES_HOME` directory under `MANYTHREADS_RUNTIME_DIR` (one per run, mode 0700 with 0600 files, removed when the run ends — also when the spawn itself fails — and swept at startup when a dead server left it behind for more than two hours) holding two files:

* **`SOUL.md`** — the `BOT.md` body, verbatim. The behaviour of a bot is its file's prose, versioned in the team repo.
* **`config.yaml`** — the model and the tools, and nothing else:
  * `model.provider: manythreads` + `model.default: <aliases[0]>`, with a named custom provider pointing at the workspace's
    LiteLLM gateway (`MANYTHREADS_LITELLM_URL`) using the bot's **own virtual key** (`provider.llm`'s `botKey`). Aliases,
    fallbacks, budgets, rate limits and the pre-call DLP hook all live behind that one URL (SPEC §10.1–10.2).
  * `mcp_servers.manythreads.url` — the **run's own MCP endpoint**, `.../api/mcp/runs/<runId>` (`ctx.runs.open`) — the URL names the
    run and holds no credential — with the run token in an `Authorization: Bearer` header.
  * `agent.reasoning_effort` when the definition sets `model.effort`.

Nothing else is ever written into a profile: **no provider credential, no repo credential, no memory address**. The run token is
the bot's whole authority for the run and it is revoked when the run closes — that invariant is the phase's exit gate, and
`test/profile.test.ts` asserts the file contains no other secret-shaped line.

## Start and stop

"Start and stop in the Hermes container" means, honestly, **a process**: the CLI named by `MANYTHREADS_HERMES_BIN` (default
`hermes`), with `MANYTHREADS_HERMES_PREFIX` for a container entry point (`docker exec -i manythreads-hermes hermes`), launched
with `HERMES_HOME` pointed at the generated profile and `chat --query-file - --oneshot --format stream-json`. The prompt goes on
**stdin** through `--query-file -`, so a message body is never shell-interpreted and never lands in an argv a process list
shows. `--run-budget` comes from the definition's `limits.timeoutSeconds`; the platform adds a hard ceiling (`budget + kill
grace`, default 15 s) and stops the process with SIGTERM, then SIGKILL. There is no daemon to manage and no state shared
between runs.

**The child's environment is an allowlist**, not the server's: `PATH`, `HOME`, `LANG`/`LC_*`, `TZ`, the temp-dir variables and
`HERMES_*`, plus `HERMES_HOME`. The KMS key, database URLs and passwords, the LiteLLM master key and the test auth token never
reach an agent that can run `env` (`childEnv`, tested by looking for secret-looking parent variables in the child's
environment). The child leads its own process group and a timeout signals the group, so what a shell tool started dies too.

The stream is Hermes' own JSONL: `text` deltas, `tool_use` / `tool_result`, and a terminal `result` whose `exit_code` is the
outcome. A process that dies without a `result` record is reported as a failed run carrying the tail of its stderr — a run is
never silent about how it ended. The reply is the terminal record's text (or the deltas when the stream was cut short). The
child's exit is listened for **at spawn**, not when the stream is first read: a binary that fails immediately is gone before
the job takes its first event, and a listener attached afterwards would wait forever for a `close` that already happened.
`test/hermes.test.ts` asserts the whole start/stop sentence against an injectable `spawn`: the profile on disk (and gone
afterwards), the argv and `HERMES_HOME`, the prompt on stdin rather than in an argv, the events the JSONL becomes, the
synthesised failure of a process that died with no `result`, and the ceiling — SIGTERM at the budget, SIGKILL after the grace.

## The reply

When the stream ends with text, the router posts **one** message into the thread the run was asked in — through the channels
plugin's own `messages.post` capability, in the run's bot transaction, so the reply is an ordinary message by an ordinary
member: `channel.message.posted` fires, the audience is pushed, unread counters move, mentions resolve. The reply is not
streamed into the thread delta by delta: a turn produces one message, and posting `text` deltas would be a message per token.

## What a run is allowed to do

* The tools the model sees are the ones the broker grants (`gateway-mcp`'s `tools/list`), against the **run's** bot actor, and
  every call is resolved back to the run through the endpoint's token. The profile's URL is per run, so two conversations of
  two people never share a tool scope.
* The **scope a provider is handed is authorized too** (`BotRuntimeScope.invoke`): every call a runtime makes goes through the
  broker as the run's bot before it runs, with the same rules as the MCP door — the allowlist the loader compiled from
  `capabilities.native`, the `files.*`/`pages.write` path guard on the path the call's own arguments name, and a
  `needsApproval` grant failing closed (the Approvals inbox is P5-20). The reply itself is posted through that door, so a
  definition that never asked for `messages.post` cannot post one. `test/run.test.ts` asserts exactly that refusal.
* Reads run as the **asking person**, writes as the **bot** (`ctx.runs.asReader` / `asBot`), which is how a bot never sees more
  than the person talking to it.
* Before anything is sent, the router asks the gateway's `preflight` (preset, DLP hook, budgets, rate limits) — for a runtime
  that talks to a model (`provider.usesGateway`; `rules` does not, and is never refused for lacking one). A refusal is logged and
  the run closes as `stopped` without a model call; a redaction is honoured: **the prompt the process receives is the
  gateway's `decision.text`**, not the raw message. A failed run posts no reply (half an answer is not an answer), and the
  run's token outlives its budget (`timeoutSeconds` + 120 s) so its tools do not vanish mid-turn.
* A run whose `BOT.md` in the repo is newer than the loaded definition is **refused**: a run never executes a definition the
  roster never showed.

## Failure, and what is not here yet

A run that throws is closed as `failed` and its reason is logged; the job does **not** retry, because a model call is not
something to replay blindly (a retry would re-ask the model and could post a second answer). The asker sees nothing in the
thread in that case — run state and an approvals/conversation surface arrive with P5-16/P5-20.

Not yet done, deliberately:

* **Spend**: the runtime reports the tokens the model reported (`job.log`); it does **not** write `llm_spend`, because
  `recordSpend` wants a USD cost and nothing in this deployment knows a price per model. Budgets therefore see the calls the
  gateway plugin makes itself, and LiteLLM's per-key ledger is the usage record for runtime calls. Wiring a price source and
  the runtime's token counts into `llm_spend` is a follow-up.
* **`memory.*`, `files.search`, `knowledge.search` and `tasks.*`** are the capability set of the plugins that own them
  (`knowledge.search` and `tasks.*` answer as stubs today — see [gateway-mcp.md](./gateway-mcp.md)).
* **`routine`, `task_assigned`, `inbox` and `webhook` triggers** are not routed; they arrive with the board, the mail
  connections and P6.
* **The per-bot channel** and the conversation view are P5-16; this plugin only reacts to it.

## Configuration

| Variable | Default | What it is |
|---|---|---|
| `MANYTHREADS_HERMES_BIN` | `hermes` | the Hermes entry point (the container's binary in a deployment) |
| `MANYTHREADS_HERMES_PREFIX` | *(empty)* | arguments before `chat`, space-separated (`docker exec -i <container> hermes`) |
| `MANYTHREADS_RUNTIME_DIR` | `$TMPDIR/manythreads-runtime` | where a run's profile home is written |
| `MANYTHREADS_HERMES_KILL_GRACE` | `15` | seconds between SIGTERM and SIGKILL |
| `MANYTHREADS_LITELLM_URL` | *(unset)* | the workspace's model gateway; without it a hermes run is refused before starting |

## Tests

`test/profile.test.ts` — the rendered profile: the body as `SOUL.md`, the parsed `config.yaml` (gateway, alias, effort, the
run URL and bearer token), no other credential, the home name, and the three ways rendering refuses (no alias, no gateway, no
endpoint). `test/stream.test.ts` — the stream-json records (text, tool use, tool result, result, failure, interrupt) and
everything that must be ignored. `test/router.test.ts` — trigger matching (priority, `source` filtering, case, no-trigger),
handle reading (URLs, code spans) and the prompt. Those three run without a database.

`test/hermes.test.ts` (no database) is the provider's own start and stop, with a stand-in child. `test/run.test.ts`
(`pnpm test`) is the **end-to-end** one: a real database, a real server, the real outbox, and a stand-in
for the Hermes CLI (`MANYTHREADS_HERMES_BIN`/`_PREFIX` point at a script that behaves like `hermes chat --oneshot --format
stream-json`). A person's `@mention` in `#dev` loads a definition, the router enqueues, the job opens a run, one process
starts in the rendered profile, and the answer arrives in the thread as the bot — the spool file the stand-in writes is what
pins the argv, the `SOUL.md` it read, the run's MCP URL and the prompt it got on stdin. Three cases: the answer lands (`done`),
a definition that never asked for `messages.post` has its reply **refused** (`failed`, nothing posted, though the process ran),
and a definition with no model alias fails without starting a process at all.

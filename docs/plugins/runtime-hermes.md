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
| `conversation` | the message landed in the bot's own conversation channel (`channels.kind = 'bot_conversation'`, `channels.bot_id = bot.id`) | the unlisted, private channel the `conversations` plugin makes, one per bot and person ([conversations.md](./conversations.md)); the only trigger that fires there |
| `mention` | the body names the bot (`@<slug>`), in the channels the trigger's `source` lists (all of them when it lists none) | read with the composer's parser, so a handle in a code span, a fence, a URL or an email wakes nobody |
| `channel_message` | a message in a channel the trigger lists, or anywhere on the bot's team when it lists none | the trigger for a bot that answers everything |

Never fires: a message a **bot** wrote (no bot answers a bot here — that is delegation, P6), a private channel (a bot
conversation is the one exception, and only for the bot it is with: no other bot of the team is considered there, and a
`mention` or `channel_message` rule never wakes a bot inside somebody's conversation with it), a DM, an archived channel. One message starts at most one run per bot (the job's dedupe key `runtime-hermes:<botId>:<messageId>`) and the
highest-priority trigger wins: conversation, then mention, then channel_message. A `routine`, `task_assigned`, `inbox` or
`webhook` trigger is in `BOT.md` but not routed by this plugin yet.

The run's prompt is one line of context and the message: `Nadia in #dev:\n\n@coder what changed?` (in a conversation channel,
which has no name, `Nadia:\n\nWhat is blocking the release?`). Behaviour is `SOUL.md`'s
job, never a prompt template's.

## The profile

`render` is pure, so a definition's profile can be asserted in a test instead of inspected in a container. A profile is a
`HERMES_HOME` directory under `MANYTHREADS_RUNTIME_DIR` (one per run, mode 0700 with 0600 files, removed when the run ends — also when the spawn itself fails — and swept at startup when a dead server left it behind for more than two hours: only a directory named `<bot slug>-<run id>` that carries the `.manythreads-profile` marker this code writes first is ever swept, so a `MANYTHREADS_RUNTIME_DIR` that shares a directory with anything else loses nothing) holding two files:

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

**The child's environment is an allowlist**, not the server's: `PATH`, `HOME`, `LANG`/`LC_*`, `TZ`, the temp-dir variables,
`HERMES_*` and the CA-bundle variables (`SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
`NODE_EXTRA_CA_CERTS` — a deployment behind a private CA cannot reach the model gateway without them), plus `HERMES_HOME`. The
KMS key, database URLs and passwords, the LiteLLM master key and the test auth token never reach an agent that can run `env`
(`childEnv`, tested by looking for secret-looking parent variables in the child's environment). A deployment that needs more
(`HTTPS_PROXY`, `NO_PROXY`) opts in by name: `MANYTHREADS_HERMES_ENV_PASSTHROUGH=HTTPS_PROXY,NO_PROXY`. A name that starts with
`MANYTHREADS_`, `DATABASE` or `PG` is refused even when listed — those are the platform's and the database's, not the agent's.

**The child leads its own process group and a stop signals the group**, not just the leader. A leader that exits (normally or by
SIGTERM) can leave what a shell tool started still running in the group, so whether there is anything left to signal is asked of
the group (`kill(-pid, 0)`; ESRCH means empty), never of the leader's exit code: after a normal end the group still gets SIGTERM,
and SIGKILL after the grace if it ignores it. The profile directory (it holds the run token and the bot's key) is removed only
once the group is gone, or after the grace plus two seconds. On Windows there are no groups and the child is not `detached`; only
the child itself is signalled.

With `MANYTHREADS_HERMES_PREFIX='docker exec -i <container> hermes'` the group is the **docker client's**: signals reach `docker
exec`, which does not forward them to the process inside the container, so a timeout stops the client and not the agent. Run the
container with `--init` (so orphans are reaped) and make the container's entry point enforce its own budget (`timeout`, or
Hermes' `--run-budget`, which the platform always passes), or run Hermes on the server's host/pod where the group kill applies.

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

A run that finished with an **Answer** (it called the `answer.post` tool, [answer.md](./answer.md)) has already posted its reply — the text,
its sources and whom it was for — as a message of the thread carrying `meta.runId` = the run and `meta.answer`. The router checks for that
message (one indexed read of the thread) and does **not** post the text the model printed after the tool call: it is the same reply, and a
second message would repeat it. Only a live message the answer plugin wrote counts (an Answer the person deleted does not: the run is then not "answered", in the tool as well); a plain `messages.post` of the model does not.

## What a run is allowed to do

* The tools the model sees are the ones the broker grants (`gateway-mcp`'s `tools/list`), against the **run's** bot actor, and
  every call is resolved back to the run through the endpoint's token. The profile's URL is per run, so two conversations of
  two people never share a tool scope.
* The **scope a provider is handed is authorized too** (`BotRuntimeScope.invoke`): every call a runtime makes goes through the
  broker as the run's bot before it runs, with the same rules as the MCP door — the allowlist the loader compiled from
  `capabilities.native`, the `files.*`/`pages.write` path guard on the path the call's own arguments name, and a
  `needsApproval` grant becoming a pending approval ([approvals](./approvals.md): the run ends `stopped` at that call, and approving it
  later makes that call once, as the bot; without the approvals plugin it fails closed). The reply itself is posted through that door, so a
  definition that never asked for `messages.post` cannot post one. `test/run.test.ts` asserts exactly that refusal.
* Reads run as the **asking person**, writes as the **bot** (`ctx.runs.asReader` / `asBot`), which is how a bot never sees more
  than the person talking to it.
* Before the pre-call check, a bot with a `guard.gate` list passes the **gate** (below).
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
| `MANYTHREADS_HERMES_ENV_PASSTHROUGH` | *(empty)* | comma-separated extra variable names the child inherits (`HTTPS_PROXY,NO_PROXY`); `MANYTHREADS_*`, `DATABASE*` and `PG*` are never passed |
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

## A run that waits for a person (P5-20)

* **A grant flagged `needsApproval`** — over the MCP endpoint (the gateway answers `approval_pending`) or through the provider's own scope
  (`runtime-rules`): the call becomes an approval of source `grant`, the run is closed `stopped` (the router asks `pendingForRun` after the
  stream ends), and the Approvals inbox and the thread carry the card.
* **A DLP finding the bot asked to have held** — `guard.rules: ["dlp:require_approval"]` (`GUARD_RULE_DLP_APPROVAL`). The pre-call check runs in
  `hold` mode: a finding stops the call (outcome `require_approval`) and the router files a `dlp` approval for the tool `llm.call` whose preview is
  the rule names and the **redacted** message. The original prompt rides in the row's `resume` as a hand-back. When a person approves,
  `registerApprovalResume` (a consumer of `approvals.approval.decided`) claims the payload and re-queues the run with `approvalId`, and the next
  pre-call check runs in `approved` mode: that one finding goes to the model as written (a preset that refuses outright still refuses). Without
  the approvals plugin the hold is a refusal.
* Runs record where they answer (`bot_runs.channel_id`, `reply_root_id`, bots 0009) so the card lands in that thread.

## The gate (P5-11)

SPEC §7.3: before any model call, on a gate-list topic, in two stages. `runtime-hermes/src/gate.ts` is the code; the run job calls it after the run opens and before the pre-call check
and the provider, for a runtime that talks to a model (`provider.usesGateway`) and a bot whose BOT.md has a non-empty `guard.gate`. Which runtimes are gated is the provider's `gated` flag (`BotRuntimeProvider.gated`, **required**: `hermes` says `true`, `rules` says `false`, so a new model runtime cannot be left ungated by forgetting a field), **not** `usesGateway`: a
subscription runtime (Claude Code, Codex; SPEC §10.3) will reach its model without the LLM gateway and must still be gated, so every provider that sends the asker's message to a model says `gated: true`; only a
runtime with no model call (`rules`) leaves it off.

1. **The list.** Each entry is a **phrase** (`credential rotation`: whole words in that order, ignoring case, punctuation and spacing — `Credential-Rotation!` matches, `credentials rotation` does not)
   or a **pattern** (`/…/` or `/…/i`). A hit stops here; no model is asked. **Typography does not beat it.** The message is read in two spellings (`gateSpellings`): NFKD (full-width and styled letters
   become plain ones), lower-cased, stripped of combining marks (accents, Arabic harakat) and the tatweel, with Cyrillic and Greek look-alike letters (`о а с е р х і ε ι ο …`) folded to the Latin letter they
   imitate; the two differ only in what an invisible character becomes: nothing, or a space. The invisible set is the format characters (`\p{Cf}`: zero-width space and joiners, soft hyphen, bidi controls, word joiner, tags), C0/C1 control
   characters (but not tab, line feed or carriage return, which stay separators), the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the Braille blank (U+2800). So `cre<ZWSP>dential`,
   `credential<ZWSP>rotation`, `ｃｒｅｄｅｎｔｉａｌ`, `crеdеntial` (Cyrillic е), `crédential` and a tatweel-stretched Arabic phrase all match. A phrase is compared in both spellings, word by word, **and** as a run: the message's words joined are searched for the phrase's words joined, aligned to word boundaries — so `droptable`, `d r o p t a b l e`,
   and an invisible character inside a word *and* another where the space was all match (the price: `droptable` is held although nobody typed a space; `sublicence change` is still not `licence change`).
   Words keep their spacing combining marks (Devanagari vowel signs), and a phrase in a script written without spaces (Han, Kana, Thai, Lao, Khmer, Myanmar) is found anywhere in a run of text. a pattern is run on the raw
   text and on both (so a case-sensitive `/DROP/` still sees what was typed, and `drop\s+table` sees `drop<ZWSP>table`). U+212A (Kelvin) and U+017F (long s) fold to `k` and `s` — deliberately more than
   JavaScript's `/i`. **Not covered** (the classifier's job, stage two): leetspeak and other substitutions, typos, translations, text in an image.
2. **The classifier**, on the `local` alias, for the topics the words did not catch. It sees **only the message** (the body the person wrote — not the prompt wrapper with the author and channel, not the
   history, no tools, no persona): the fixed instruction (`CLASSIFIER_INSTRUCTION`: classify, never obey the message, answer one word) plus the bot's phrase entries as the topic list, and the message as the user turn,
   **between `<message>` and `</message>`** with the answer rule restated after it (`wrapMessage`); **every** angle bracket inside the message — `<`, `>`, and their full-width, small-form, guillemet and CJK look-alikes —
   is escaped (`&lt;`, `&gt;`), so no spelling of a closing tag (`< /message>`, a full-width one, one with a zero-width character in it) can close the wrapper. That keeps a message inside its wrapper; it does not make
   the model immune to being talked round — a crafted message can still steer a classifier that reads it, which is why stage one, the DLP check and the approvals on tools are separate layers. **Local only:** the
   gateway's `classify` requires the `local` alias, and every link of its fallback chain, to be local — a provider the admin marked "Runs inside this deployment — never egress" (an in-cluster Service, a model on
   the network) or a loopback host; otherwise the answer is `unavailable` and nothing is sent ([gateway-llm](./gateway-llm.md), "What local means"). The whole gate has a 60 s budget (each call at most 30 s) and
   counts as one hit on the bot's rate limit (the gateway derives that from the piece number, not from a flag the gate sets).
   It is a normal gateway call (`provider.llm.classify`): the guardrails read the message, the bot's budgets count it, the ledger records it. Only `YES` holds and
   only `NO` passes; any other answer is unclear. A message over 6,000 characters goes in overlapping pieces (any `YES` holds; more than eight pieces is held). A list of patterns alone gives the
   classifier no topic, so none is asked.

**A hit** files a pending approval and closes the run `stopped`, with the model never called: source `dlp` (see [approvals](./approvals.md), "Why the gate is `dlp`"), tool `llm.gate`, a preview of `stage`,
the matching `entry` (configuration, not message text), the reason, and the message **redacted** by the `pre_egress` chain (with no guardrail loaded the message is not shown). The approvers are the
bot's `approvals.approvers`, else the team's leads; the asker cannot approve their own message. Approving re-queues the run with `gateApprovalId`, which skips the gate for that message (and only the
gate: the DLP check still runs). `runtime.gate.held` is the audit event (`stage` is `exact`, `regex`, `classifier` or `classifier_unavailable`; `approvalId` null when none could be filed — the
approvals plugin is not loaded, or nobody but the asker could decide it in that private conversation).

**When no card explains it** (a budget or rate limit; the approvals plugin absent; nobody but the asker able to decide in a private conversation) the bot posts a short notice in the thread — "Held: …" or
"Couldn't check this message: …" — instead of staying silent. It names no gate entry, no figure and none of the message, and it is posted through the same broker door as a reply, so a bot without `messages.post`
stays silent (the log says so).

**Connection.** The run job holds its database transaction while the classifier answers (at most 60 s in all), exactly as it already does for the whole model run: a job handler gets the kernel's transaction and a
plugin cannot give it back. Freeing it would be a kernel change (jobs that run without one); recorded as open.

**Fails closed.** When the classifier cannot answer — no gateway, the `local` alias unbound, the proxy down or slow (30 s), the preset refusing the call, an answer that is not a plain YES/NO — the message is
held exactly as if it had matched (`stage: classifier_unavailable`, the reason in the preview). A gate that waves messages through when its classifier is down has an off switch anyone can reach by waiting. The one
exception is a **budget or rate limit**: the run's own call would hit the same wall, so the run stops (`stopped`, logged) without asking a person.

**Honest limits.** A classifier is a model: a message written to talk it into `NO` can succeed. The list (stage one), the DLP check, the bot's capabilities and the approvals on its tools are the other layers.
Only phrase entries reach the classifier, so a topic that matters must be on the list in words. A bot with a model-less runtime (`rules`) has nothing to gate.

**Regular expressions.** `guard.gate` patterns are parsed and run by `packages/shared/src/bot-md/gate.ts`, not by `RegExp`: a Thompson-style simulation whose cost is (message length) ×
(pattern size) whatever the pattern says — a class is precompiled to sorted ranges and searched by bisection, so a class of a hundred items costs what one item does. The size of a pattern is computed
**before** it is expanded (`{n,m}` multiplies; an empty group still counts one), so `((((){100}){100}){100}){100}` is refused in microseconds instead of being expanded; `{n,m}` on something that can only
match nothing is refused; and, like JavaScript, `a{2}{3}` / `a+{2}` are refused. The subset: literals, `.`, classes (`[a-z]`, `\d \w \s` and their negations), groups, `|`, `* + ? {n} {n,} {n,m}` (counts up to 100) and the anchors `^ $ \b \B`;
flag `i` only. BOT.md **load** refuses (the definition becomes `invalid` with `guard.gate.<n>` and the reason): backreferences, lookaround, named groups, other flags, a repetition inside an unbounded
repetition (`(a+)+`, the shape that hangs every other engine the pattern is pasted into), a pattern over 200 instructions, a list over 1,000 instructions of patterns together, an entry over 200
characters, a list over 50 entries.

# Agent bridge

The agent bridge is a small program you run on your own machine (a laptop, a build server, a workstation). It lets a manythreads bot do its
work with the **Claude Code** command-line tool (`claude`) or the **Codex** command-line tool (`codex`) instead of Hermes, the agent runtime
the platform ships. The bridge speaks the same run protocol as a Hermes gateway (start a run, follow its events, stop it), so the manythreads
server needs no extra protocol: a workspace admin adds the bridge under Runners (as a Hermes gateway runner that says what runs the bot) and a bot is placed on it.

You need: Node 22, the command-line tool you want to use installed and already signed in on that machine, and the code of this repository
(`tools/agent-bridge`). The bridge starts one process of the tool for each run, in a working folder you choose, and nothing else.

## Install and run

```
pnpm install
export AGENT_BRIDGE_API_KEY="$(openssl rand -hex 24)"      # or put the key in ~/.manythreads-bridge/api-key and chmod 600 it
pnpm exec tsx tools/agent-bridge/src/main.ts --config ~/bridge.json --listen 127.0.0.1:8650
```

Options: `--config <file>` (required), `--listen <host:port>` (default `127.0.0.1:8650`), `--state-dir <dir>` (default `~/.manythreads-bridge`,
holds `sessions.json` and the optional `api-key` file), `--key-file <file>`.

The key comes from `AGENT_BRIDGE_API_KEY` or from a file that only you can read (mode 0600; the bridge refuses a file others can read). Without a
key it does not start. Every request, including `GET /health`, must carry `Authorization: Bearer <key>`; keys are compared in constant time.

## The config file

```json
{
  "profiles": {
    "default": { "agent": "claude-code", "workdir": "/home/me/work/manythreads", "model": "sonnet" },
    "reviewer": {
      "agent": "claude-code",
      "workdir": "/home/me/work/review",
      "modelAliases": { "smart": "opus" },
      "extraAllowedTools": ["Bash(git status)", "Bash(git diff *)"]
    },
    "scripts": { "agent": "codex", "workdir": "/home/me/work/scripts", "model": "gpt-5" }
  },
  "maxConcurrentRuns": 4,
  "killGraceSeconds": 5,
  "budgetGraceSeconds": 10,
  "defaultBudgetSeconds": 600,
  "keepFinishedSeconds": 3600,
  "bin": { "claude": "claude", "codex": "codex" },
  "mcpTokenInFile": false
}
```

A **profile** is the name that appears in the bridge's URL (`/p/<profile>/v1`). A bot placed on a connection without a profile name, or with a name
that is not listed, uses `default`. Per profile: `agent` (`claude-code` or `codex`), `workdir` (created when missing; the tool runs there),
`model` (passed to the tool), `modelAliases` (the alias a bot's definition names, mapped to the tool's own model name; aliases not listed are ignored),
`extraAllowedTools` (Claude Code only: extra tools pre-approved for every run of the profile). `instructions` (a note about this machine, appended after the bot's BOT.md under "Where you run" in every run: where the
repositories are, what is installed, what the bot must leave alone — the bot's definition says who it is, this says where it runs).

Two more per-profile keys control the tool's environment (see Security): `env` (`{"NAME": "value"}`, set in the tool's environment for every run of the
profile, for example `KUBECONFIG` for a bot that deploys) and `passEnv` (a list of names of the bridge's own variables to hand on as they are). The names
`AGENT_BRIDGE_API_KEY` and `MANYTHREADS_RUN_TOKEN` are refused in both.

Other keys: `maxConcurrentRuns` (over it, a start gets 429 with `Retry-After`; the server waits and tries again), `killGraceSeconds` (between
SIGTERM and SIGKILL), `budgetGraceSeconds` and `defaultBudgetSeconds` (a run is killed at its budget plus the grace and ends as failed with "budget
exceeded"), `keepFinishedSeconds` (how long a finished run stays readable, default one hour), `bin` (where the tools are), `mcpTokenInFile` (see
Security).

## Add it in manythreads

1. A workspace admin adds it, not a team lead: Settings > Workspace > Runners > Add a runner > **Hermes gateway** (the runner catalog, `docs/plugins/bot-runners.md`). The Claude Code and Codex cards on that page are for pods inside the cluster; a bridge on your own machine is a Hermes gateway runner with a different answer to **What runs the bot**:
   - **Address**: where the bridge answers, for example `http://10.42.0.1:8650` for a bridge on the machine that runs the cluster (see [Run it on the machine that runs the cluster](runbooks/runners-live.md#host-bridge)), or `https://bridge.example.com:8650`. The address passes the same outbound guard as any gateway: loopback and link-local addresses are refused.
   - **Key**: the bridge's API key. It is stored encrypted and never shown again.
   - **What runs the bot**: **Claude Code on the bridge** or **Codex on the bridge** (stored as `agent` `claude-code` or `codex`; the default **Hermes** is a Hermes gateway). This is what makes the server send each run the run's own token and the address of its tools; with **Hermes** chosen the bridge would answer as plain chat with no platform tools. It changes nothing about what a token can do.
   - **Profile name rule**: how a bot's profile is named on the bridge, `{bot}` for the bot's short name. Each name the rule makes must be a profile of the config file, or the bridge's `default` profile is used.
   - Then choose the teams that may use it, and press **Test**. For a bridge, Test asks `GET /health` with the key (it needs no `default` profile); the answer is one of three fixed sentences.
2. In the bot's `BOT.md`, set `placement.runs_on` to the runner's short name (for example `host-claude`). The old way, a team lead's connection with `placement.gateway.connection`, still runs for a connection made before runners existed; nobody can make a new one.

The server then sends each run to the bridge. Several bots can share one bridge; use profiles to give them separate working folders.

## What the bot can do

The tools come from `capabilities.runtime` in `BOT.md`.

| Grant | Claude Code tools made available and pre-approved | Codex sandbox |
| --- | --- | --- |
| none | none (`--tools ""`) | `read-only` |
| `files` | Read, Edit, Write, Glob, Grep, NotebookEdit | `workspace-write` |
| `shell` | Bash | `workspace-write` |
| `web` (or `web-search`) | WebFetch, WebSearch | no change (web search is not switched on) |
| `browser`, `vision` | nothing extra | no change |

Whatever the grants, the bot can call the platform's own tools (post a message, read a thread, write to memory) through MCP: the run's address
and a token that opens only that run travel in the request, and the bridge hands them to the tool as an MCP server named `manythreads`. Claude
Code gets it through a per-run config file (`--mcp-config`, with `--strict-mcp-config` so no other MCP server is loaded); Codex through `-c
mcp_servers.manythreads.*` settings. The platform checks every call against the bot's permissions, as for any bot.

`BOT.md` (its body) arrives as `instructions` and is **appended** to the tool's system prompt (Claude Code: `--append-system-prompt-file`; Codex:
`developer_instructions`). Claude Code records the system prompt when a conversation starts and reuses the record when it resumes, so a changed
`BOT.md` applies to new threads, not to threads already running.

Sessions: the server's `session_id` (one per bot and thread) maps to one conversation of the tool, so the bot remembers the thread. For Claude Code the
bridge derives a stable UUID from the profile and session id, starts with `--session-id` and later runs use `--resume` (if the tool has lost the
session, the bridge starts it again once). For Codex the bridge keeps the thread id the tool reports and uses `codex exec resume <id>`. Runs of the
same session wait for each other. The record is `sessions.json` in the state dir.

`maxTurns` from the definition: Claude Code 2.1.310 has no `--max-turns` flag, so the bridge counts the model's turns itself and stops the run
("turn limit exceeded"). Codex: not enforced.

## Security notes

- **No permission bypass.** The bridge never passes `--dangerously-skip-permissions` or a bypass permission mode. A tool that is not pre-approved is
  refused, because nobody is there to answer a question. The tool's own settings files in the working folder still apply.
- **Run tokens stay out of argv and logs.** The prompt goes to the tool's standard input. The run token is given only in the tool's environment
  (`MANYTHREADS_RUN_TOKEN`). Claude Code's MCP file (mode 0600, in a private per-run folder deleted afterwards) holds `Bearer ${MANYTHREADS_RUN_TOKEN}`
  and Claude Code fills it in from the environment. If your Claude Code version does not expand that, set `"mcpTokenInFile": true`: the token is then
  written into the 0600 file instead (still never in argv). The bridge's own API key is removed from the tool's environment. The bridge logs one
  line per run (id, profile, status, seconds, event count), with no prompt, output or token.
- **The tool gets a short list of variables, not the bridge's whole environment.** Passed on: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`,
  `TMPDIR`, `TZ`, `XDG_*`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and the tool's own sign-in settings (Claude Code: `CLAUDE_CONFIG_DIR`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` when set; Codex: `CODEX_HOME`, `OPENAI_API_KEY`). Anything else (a `GITHUB_TOKEN`, cloud keys) stays behind
  unless the profile lists it in `passEnv` or sets it in `env`. Give a profile only what its bots need.
- **The final answer is scrubbed.** The run token, and anything shaped like a bearer token, is replaced by `[hidden]` in the final output as well as in the
  streamed text.
- **Nothing outlives a run.** When a run ends, normally or not, the bridge sends SIGKILL to the run's whole process group. A bot cannot leave a server or a
  watcher running on the bridge machine; to keep something running it must deploy it (to the platform), not start it on the bridge host.
- **Codex's `read-only` sandbox does not confine reads, and Claude's `shell` grant is a full shell.** A Codex run can read any file the bridge's user can read;
  a Claude Code run with the `shell` grant runs commands as the bridge's user with no further limit. So run the bridge as a dedicated, unprivileged user whose
  home holds only the tool's sign-in (and the working folders), and never as root in production.
- **Requests are bounded.** Request headers must arrive within 10 seconds and an ordinary request body within 30 (408 otherwise); event streams stay open. More
  than 30 failed sign-ins a minute from one address are answered 429 until the minute passes. Codex gets BOT.md instructions longer than 4 KB on standard
  input, in front of the prompt, instead of in an argument.
- **Bind to a private address.** The default is `127.0.0.1`. To reach it from the platform, put it behind a private network or a reverse proxy
  with TLS; do not expose a plain-HTTP port to the internet. Anyone with the key can make the machine run the tool in your working folders.
- **Process groups.** Each run is its own process group; a stop (or the budget) sends SIGTERM to the group, then SIGKILL after the grace, so the
  tool's child processes go too.
- **Limits.** Request bodies over 1 MB are refused; event buffers are bounded per run; finished runs are dropped after an hour.
- **Subscription terms.** If the Claude Code or Codex tool on that machine is signed in with a personal subscription, check that subscription's
  terms before letting a team's bots use it; many personal plans do not allow shared or automated use. An API key or a business plan is the safer base.

## Run it as a service (example, not installed by anything here)

```
# /etc/systemd/system/manythreads-bridge.service
[Unit]
Description=manythreads agent bridge
After=network-online.target

[Service]
User=bridge
WorkingDirectory=/opt/manythreads
EnvironmentFile=/etc/manythreads-bridge.env     # AGENT_BRIDGE_API_KEY=..., mode 0600, owned by root
ExecStart=/usr/bin/pnpm exec tsx tools/agent-bridge/src/main.ts --config /etc/manythreads-bridge.json --listen 127.0.0.1:8650 --state-dir /var/lib/manythreads-bridge
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/manythreads-bridge /home/bridge/work

[Install]
WantedBy=multi-user.target
```

The service user must have the tool signed in (its own home folder holds the sign-in) and write access to every profile's working folder.

## The protocol

All paths are under `/p/<profile>/v1`, plus `GET /health`.

- `POST /runs` with `{ input, session_id?, instructions?, manythreads?: { bot, runId, mcp: {url, token}, tools, model?: {alias?, effort?}, budgetSeconds?, maxTurns? } }`
  and an `Idempotency-Key` header: the same key and body answer the same `run_id`; the same key with another body is 409. Answers 202 `{ run_id, status }`.
- `GET /runs/<id>/events`: server-sent events; each frame is `id: <seq>` and `data: {"event", "run_id", "seq", ...}`. Resume with `?last_seq=` or
  `Last-Event-ID`. Events: `message.delta {delta}`, `tool.started {tool, preview}`, `tool.completed {tool, duration, error}`, and one of
  `run.completed {output, usage}`, `run.failed {error}`, `run.cancelled`.
- `GET /runs/<id>`: `{ run_id, status, output, usage, error }` with status `running`, `completed`, `failed` or `cancelled`.
- `POST /runs/<id>/stop`.

## What was checked, and what was not

Checked against Claude Code 2.1.310's `--help`: `-p`, `--output-format stream-json`, `--verbose`, `--strict-mcp-config`, `--mcp-config`, `--tools`,
`--allowedTools`, `--model`, `--effort`, `--session-id`, `--resume`, `--no-session-persistence`. Taken from the help text but not listed as their own
flag: `--append-system-prompt-file`. Not verified by running the real tool (an automated check blocks launching it with tools): the `${VAR}`
expansion in the MCP config headers, the exact stream-json record shapes (written from the documented format), the `mcp__manythreads__*` pattern.

**The Codex driver has not been tested against a real Codex install.** Its flags and config keys (`exec --json --skip-git-repo-check -C`,
`exec resume`, `sandbox_mode`, `approval_policy`, `developer_instructions`, `mcp_servers.<id>.url`, `bearer_token_env_var`) and its JSON line shapes
come from OpenAI's published documentation, and the tests use a fake `codex`. Expect to adjust it on first real use.

## The sign-in gate (Claude Code in a pod, P19-06)
Used when the bridge runs in a Claude pod (`CLAUDE_CONFIG_DIR` is set). `SigninGate` (`src/signin.ts`) wraps the Claude driver.
- Within 20 minutes before the access token's expiry (read from the file), one run goes at a time, so one process asks for a renewal and the others do not
  race it with the same refresh token.
- A run that ends with a refused sign-in or the plan's limit is classified by the table `FAILURE_PATTERNS` (the one place where error texts are matched). The
  failed frame carries `reason` (`needs_sign_in` or `plan_limit`) and, for a limit, `resets_at`. While the failure stands, later runs fail at once without a
  process: a refused sign-in until the file changes, a limit until `resets_at`.
- `GET /health` includes the sign-in state; `POST /v1/signin/check` answers `ok|rejected|expired|no_scope|limit` from the file's shape and the remembered failure.
The patterns hold the stand-in's words and a guess at the real ones; the real texts are not measured yet.

### The pod, in short
In a runner's pod the bridge is the only thing the server talks to (port 8650, the bridge key on every call except the probes). Differences from a bridge on a person's own machine:
- `CLAUDE_CONFIG_DIR` (Claude) or `CODEX_HOME` (Codex) points into the pod's `state` volume, which holds the sign-in file. The bridge reads that file only for its expiry and
  never prints it; the final-answer scrub (`redact`) removes anything shaped like a token.
- `MANYTHREADS_BRIDGE_IN_POD=1` makes the Codex child's environment drop `OPENAI_API_KEY`: an API key would go around the platform's model gateway.
- Runs ask for the platform's tools through the run's MCP address with a per-run token (`MANYTHREADS_RUN_TOKEN`), never through a stored key.
- A Codex run is never retried after an account failure (a refused sign-in or the plan's limit): a retry would only spend another renewal.
- The renewed sign-in file is copied back into its Kubernetes Secret by the keeper container, not by the bridge. The permissions that pod holds are listed in
  [claude-pods](plugins/claude-pods.md#every-permission-the-runners-add).

### A fresh process per run
Every run starts a new `claude` or `codex` process; the bridge keeps the session id, not the process. So a change to a bot's `BOT.md` (its instructions or its tool list)
is seen by the **next** run of the same conversation: the bridge builds the command line again from the definition it is given, and passes `--resume` so the
conversation goes on. Nothing is cached between runs. `tools/agent-bridge/test/fake-cli.test.ts` ("a changed BOT.md and tool list") runs the same session twice with
different instructions and tools and checks that the second command line carries the new ones and `--resume`.

### Stand-in commands
`deploy/images/claude-pod-fake` holds a stand-in `claude` and a stand-in `codex` that print the real tools' JSON lines, call the run's MCP address, and fail on the words
`FAKE401` and `FAKELIMIT` (see [claude-pods](plugins/claude-pods.md#stand-in-commands-and-the-seed)). `tools/agent-bridge/test/fake-cli.test.ts` runs them under the real
bridge with a local MCP stand-in and a made-up home folder, so the sign-in gate is tested against what a process really prints. The failure texts they print are guesses until the
real tools are measured, and `FAILURE_PATTERNS` (`src/signin.ts`) matches them case-sensitively, so a real text that differs only in case is not classified.


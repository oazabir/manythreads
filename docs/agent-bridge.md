# Agent bridge

The agent bridge is a small program you run on your own machine (a laptop, a build server, a workstation). It lets a manythreads bot do its
work with the **Claude Code** command-line tool (`claude`), the **Codex** command-line tool (`codex`) or **Hermes over ACP** (`hermes acp`) instead of a
Hermes gateway, the agent runtime the platform ships. The bridge can drive each through its own command line or through the Agent Client Protocol (ACP, below);
ACP is what lets a person watch the run as a card in the thread. The bridge speaks the same run protocol as a Hermes gateway (start a run, follow its events, stop it), so the manythreads
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
that is not listed, uses `default`. Per profile: `agent` (`claude-code`, `codex`, `hermes-acp` or `opencode`), `workdir` (created when missing; the tool runs there),
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

### Agents driven through ACP (Phase 25)

A profile can run its agent through the Agent Client Protocol instead of the tool's own command line: `"driver": "acp"` (the default is `cli` for `claude-code`
and `codex`; `hermes-acp` and `opencode` are only driven this way). One adapter process runs per run, in the profile's folder, and ends with the run. The
adapter is the operator's to install and pin; the bridge does not fetch it. `acp` names it: `{"command": "claude-agent-acp", "args": []}`. The defaults are
`claude-agent-acp`, `codex-acp`, `hermes acp` and `opencode acp`. With `bin.claude` or `bin.codex` set to a path, the adapter runs that same tool (one version, one
sign-in). Two more keys: `cancelGraceSeconds` (default 10: how long an adapter has to end after a stop before its process group is ended) and
`approvalWaitSeconds` (default 2100: how long a run waits for a person to answer a permission request before it is refused; the run's time budget is held
meanwhile).

What the adapter does is shown live: the stream carries `tool.started`/`step.update`/`tool.completed` (each with a `step_id`, a kind, a short title and the paths
inside the project; a diff is counts of lines only), `agent.update` for helpers, `plan.update`, `thinking`, and `run.completed` with `stop_reason` and `cost`.
What an adapter leaks (the command, the arguments, the output, the text of a file) is never read. A permission request is an `approval.request` frame
(`request_id`, `command` (the step's title), `choices`: `once` and `deny`); `POST /runs/<id>/approval {choice, request_id?}` answers it (`session` is one Yes, never
a standing rule; 404 when nothing waits), and `POST /runs/<id>/steer {input}` puts a note to the agent while it works (409 when the adapter cannot take one).

### Signing the agent in and out (P25-09)

An agent driven through ACP can be signed in from the Runners page, so nobody has to log in on the machine by hand. The bridge asks the adapter which ways it
offers and says, in plain fields, what the person must do. These routes need the bridge key like every other; they are also under `/p/<profile>/`.

- `GET /v1/auth/status` answers `{ profile, home, state, kind, can_logout, methods: [{id, name, description, how}], attempt, note }`. `profile` is the profile the answer is about and `home` is
  `dedicated` (the profile has its own sign-in folder: `authHome`, or its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in `env`) or `shared` (the tool's folder of this user on the machine, which every
  profile and every terminal session of that user also uses); it is null for an agent with no sign-in of its own. `state` is `signed_in`, `signed_out`, `unknown`
  or `not_needed`. While a sign-in is under way and the answer is not known yet (for example after the bridge restarted), the state is `unknown` with a note that says so. It carries no account e-mail and no organization: the adapter reports them and the bridge drops them. The answer is kept for 15 seconds.
- `POST /v1/auth/login {methodId}` starts a sign-in and answers the attempt `{id, methodId, how, state, action, message}` (`how` is `device_code`, `paste_code` or `api_key`). `action` is `enter_code {url, code}` (Codex device
  code: open the page and type the code), `paste_code {url}` (Claude: open the page, sign in, paste the code it shows), `open_url {url}` or `give_key` (an API key). A
  second login while one is under way is `409`. An unknown method is `400`.
- `POST /v1/auth/login/answer {attemptId, code | apiKey}` gives the code or the key. It goes to the agent and nowhere else: not to a log, not to a frame, and the
  answer does not echo it. At most five answers per attempt: a wrong Codex key goes back to asking for another one (with a sentence), and the fifth ends the attempt. A wrong Claude
  code ends the attempt at once (the program takes one try). A code or key that is not accepted within 60 seconds ends it as failed (`checking` timeout).
- `POST /v1/auth/login/cancel {attemptId?}` ends the attempt.
- `POST /v1/auth/logout` signs the agent out. An adapter with no logout answers `409` with a plain sentence (Hermes has none; a Claude adapter that does not offer it falls
  back to the login program's own `auth logout`).

**Claude** has only a terminal login: the bridge runs the adapter's `--cli auth login --claudeai` under a pseudo-terminal made by `script` (util-linux or BSD, on every common
server image; no native module is added), reads the page address from what it prints and types the pasted code into it. **Codex** starts `authenticate` with the device
code method: the adapter asks to open a page, the code is in its message, and the sign-in ends when the person has finished there. An API key is offered on the host
only; in a pod (`MANYTHREADS_BRIDGE_IN_POD=1`) it is hidden, because the pod's own sign-in file is the way. The sign-in always uses the profile's own configuration
folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), so a test never touches the machine's real one.

**One sign-in folder per profile (recommended).** Without `authHome`, a profile uses the tool's folder of the service user (`~/.claude`, `~/.codex`). Signing in or out from the Runners
page then changes that one account for every profile that uses the same folder, and for anyone who uses the tool in a terminal on that machine. Give each profile its own folder:

```json
"office": { "agent": "claude-code", "workdir": "/srv/work/office", "authHome": "/var/lib/manythreads-bridge/auth/office" }
```

`authHome` is an absolute path (claude-code and codex only; the bridge creates it with mode 0700). It sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` for the agent's runs and for the sign-in, and
an `env` entry of the same name still wins. Sign-in state, attempts and the 15-second cache are kept per tool and per folder, so two profiles with their own folders sign in and out
independently, and two profiles that share a folder share one sign-in (a second login while one runs is `409`). The Runners page says which of the two a runner has, and names the
machine in the confirm for a sign-out ("signs out every user of that tool on that machine") and for a new sign-in over an account that is in place ("replaces the account").

**Failure texts never reach the page.** What the program or adapter prints or throws when a sign-in fails can hold the code, an e-mail or a token. The bridge reads it only to choose one of a
fixed list of sentences (refused, expired, network, the program did not start, the address was unusable, the check timed out, and so on). The page address must be `https://` and at most
2000 characters; it is taken from the program's output only after something ends it (a space, a quote or a line end), so a half-printed address is never shown, and an address that is too
long or too short is a failed attempt with its own sentence.

**Time limits.** The adapter steps (start, key check, sign-out) wait 20 seconds each, so one request answers within 60 seconds at the most (a sign-out may start the adapter, ask it, then
fall back to the program); a Codex device code lives 15 minutes, a Claude paste 10 minutes. The server's waits for the bridge are longer than that (70 seconds for a status or a start).

**The pseudo-terminal.** `script -q -e -f -c` on Linux (`-e` so the program's own exit code comes back: without it a wrong code or a failed sign-out looks like success), `script -q /dev/null` on
macOS. The program runs in the same session as its own shell, so a cancel ends the whole process group, not only `script`. The pasted line is the text, a 100 ms pause and a carriage return
(measured against the real login, docs/spikes/acp-measured.md).

### Set up an ACP runner on the host, step by step (P25-15)

This is the order that was used on the devbox. Do one agent at a time and look at the Runners page after each. Everything runs as the unprivileged service user that
owns the agent's sign-in (see "Security notes"); none of it needs root except the unit file.

**Versions this was measured with** (`docs/spikes/acp-measured.md`; a change of any version means recording the fixtures again):

| Part | Version | Where it comes from |
| --- | --- | --- |
| Node | 22 or later | the adapters need it (`engines.node >= 22`) |
| `@agentclientprotocol/claude-agent-acp` | **0.107.0** | npm, installed by you, exact version |
| `@agentclientprotocol/codex-acp` | **2.6.0** | npm, installed by you, exact version |
| `@agentclientprotocol/sdk` | 2.7.0 | already a dependency of the bridge (`tools/agent-bridge/package.json`) |
| `claude` (Claude Code) | 2.1.323 | already on the host, signed in |
| `codex` (Codex) | 0.166.0 | already on the host, signed in with ChatGPT |
| `hermes` | 0.21.5 | already on the host |
| `opencode` | not measured | see step 7: refused at run time |

**1. Install the two adapters, once, in a folder of their own** (not in the repository, and never with a range such as `^0.107`):

```bash
sudo install -d -o bridge -g bridge /opt/manythreads-acp
cd /opt/manythreads-acp
npm init -y >/dev/null
npm install --save-exact @agentclientprotocol/claude-agent-acp@0.107.0 @agentclientprotocol/codex-acp@2.6.0
ls node_modules/.bin/claude-agent-acp node_modules/.bin/codex-acp     # both must exist
```

The bridge never fetches an adapter. To change a version, install the new one here, run the bridge's tests, and record the fixtures again
(`tools/agent-bridge/spike`, `docs/spikes/acp-measured.md`).

**2. Check the programs the adapters sit on.** The bridge points an adapter at the host's own tool when `bin.claude` or `bin.codex` is a path, so there is one version
and one sign-in per tool:

```bash
command -v claude codex hermes       # note the three paths
claude --version; codex --version; hermes --version
```

**3. Write the config.** One profile per bot name (the runner's rule `{bot}`), or one profile per agent. Each profile has its own folder, its own `authHome`
(Claude and Codex) and `"driver": "acp"`:

```json
{
  "profiles": {
    "claude": {
      "agent": "claude-code", "driver": "acp",
      "workdir": "/srv/work/claude",
      "authHome": "/var/lib/manythreads-bridge/auth/claude",
      "acp": { "command": "/opt/manythreads-acp/node_modules/.bin/claude-agent-acp" }
    },
    "codex": {
      "agent": "codex", "driver": "acp",
      "workdir": "/srv/work/codex",
      "authHome": "/var/lib/manythreads-bridge/auth/codex",
      "acp": { "command": "/opt/manythreads-acp/node_modules/.bin/codex-acp" }
    },
    "hermes": {
      "agent": "hermes-acp",
      "workdir": "/srv/work/hermes",
      "env": { "HERMES_HOME": "/home/bridge/.hermes" },
      "acp": { "command": "/home/bridge/.local/bin/hermes", "args": ["acp"], "gives": ["files", "shell", "web"] }
    }
  },
  "bin": { "claude": "/home/bridge/.local/bin/claude", "codex": "/home/bridge/.local/bin/codex" },
  "maxConcurrentRuns": 4
}
```

- `hermes-acp` has no `driver` line: it is only driven through ACP. `acp.gives` lists what that Hermes can do (`files`, `shell`, `web`, `browser`, `vision`; the default is all five).
  Hermes cannot be held to less per run, so a run is **refused in plain words** unless the bot is allowed everything its profile gives: narrow `gives` to what the Hermes home
  really offers, or give the bot those tools.
- A new `HERMES_HOME` takes about a minute to start the first time (Hermes installs its Python parts, 1.6 GB), and a Hermes home cannot be copied to another path. Use the
  one the host's Hermes already works in, and make sure its model setting is the one you want (Hermes has no per-run model).
- Leave out `model` and `modelAliases` to use each agent's own default, or set them (`"model": "sonnet"`; a model the adapter does not know fails the run with a plain sentence).

**4. Make the key and the unit.** The key is at least 24 random bytes in hex, in a file only the service user can read (`chmod 600`), and the same key goes into the Runners form.
Use the unit under "Run it as a service" below, with `--listen 10.42.0.1:8650` for a cluster on the same machine, and make sure the unit's `PATH` holds the folders of `claude`,
`codex` and `hermes`. `ReadWritePaths` must list every `workdir`, every `authHome` and the Hermes home.

**5. Start it and look.**

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now manythreads-bridge
journalctl -u manythreads-bridge -n 20 --no-pager
curl -s -H "Authorization: Bearer $(sudo cat /etc/manythreads-bridge/api-key)" http://10.42.0.1:8650/health
```

`/health` must answer `{"status":"ok"}`. A config error is printed once and the unit stops.

**6. Add one runner per agent, then sign in.** As a workspace admin: Settings > Workspace > Runners > Add a runner > Hermes gateway, with the address, the key, the profile rule
(the profile's name, for example `claude`, or `{bot}`), and **What runs the bot**:

| Agent | Choose |
| --- | --- |
| Claude Code | Claude Code on the bridge |
| Codex | Codex on the bridge |
| Hermes | Hermes over ACP on the bridge |

Press **Test** (it asks `/health`). Then open the runner's **Sign-in** button:

- **Claude Code**: press the Claude method; open the page it shows, sign in with the account meant for the bridge, copy the code the page gives, paste it into the dialog. It takes one
  try: a wrong code ends the attempt and you start again. Use a login made for the bridge, not the one you work in (two copies of one login can sign each other out).
- **Codex**: press the device-code method; open the page, type the code shown, and wait: the dialog says when it is done. Sign in with ChatGPT; an API key is offered on the host only.
- **Hermes**: nothing to sign in; the model key is in its home. The dialog says so.

With an `authHome` per profile, signing in or out changes only that profile. Without it the tool's folder of the service user is shared by every profile and every terminal session
of that user, and the confirm names the machine.

**7. OpenCode is not enabled.** A profile `{"agent": "opencode"}` is accepted by the config and by the runner form, and a run on it is **refused** with "OpenCode cannot run yet: it
has not been checked that its tools can be limited to what the bot may do." Do not install it for a bot to use before it has been measured like the others
(`docs/plans/acp.md` section 8, `docs/engineering/conventions.md`). Its Sign-in button answers that sign-in has not been checked.

**8. Place a bot and read the card.** In the bot's definition set `placement.runs_on` to the runner's short name, mention the bot in a thread, and watch the run card
([Watching a bot work](guide/watching-a-bot-work.md)). One run with a file edit and one with a question to a person (a command the grants do not cover) prove the live steps and the Yes
or No card.

**9. Stop and sign-out checks.** Press **Stop** on a long run: the card says "Stopping…", then "Stopped by <you> after <time>", and `ps` shows no adapter process of that run afterwards.
Sign-out is on the same dialog and asks before it signs out.

**If it does not work.** A run that fails at once usually means a program is missing: the adapter path in `acp.command`, or `claude`, `codex` or `hermes` not on the unit's `PATH`. Run the same command by hand as the service user.
`journalctl -u manythreads-bridge` shows one line per run (id, profile, status, seconds, event count) and never a prompt or a token.

To go back, set `"driver": "cli"` on a Claude Code or Codex profile (the stream-json drivers stay until P25-17), restart the unit, and press **Test** again.

## Add it in manythreads

1. A workspace admin adds it, not a team lead: Settings > Workspace > Runners > Add a runner > **Hermes gateway** (the runner catalog, `docs/plugins/bot-runners.md`). The Claude Code and Codex cards on that page are for pods inside the cluster; a bridge on your own machine is a Hermes gateway runner with a different answer to **What runs the bot**:
   - **Address**: where the bridge answers, for example `http://10.42.0.1:8650` for a bridge on the machine that runs the cluster (see [Run it on the machine that runs the cluster](runbooks/runners-live.md#host-bridge)), or `https://bridge.example.com:8650`. The address passes the same outbound guard as any gateway: loopback and link-local addresses are refused.
   - **Key**: the bridge's API key. It is stored encrypted and never shown again.
   - **What runs the bot**: **Claude Code on the bridge**, **Codex on the bridge**, **Hermes over ACP on the bridge** or **OpenCode on the bridge** (stored as `agent` `claude-code`, `codex`, `hermes-acp` or `opencode`; the default **Hermes** is a Hermes gateway). Which program drives it, the command line or ACP, is the profile's `driver`, not a choice on the page. OpenCode is refused at run time until it is measured. This is what makes the server send each run the run's own token and the address of its tools; with **Hermes** chosen the bridge would answer as plain chat with no platform tools. It changes nothing about what a token can do.
   - **Profile name rule**: the profile name in the bridge's config file. Include `{bot}` for the bot's short name; for example, `claude-{bot}` makes the bot `coder` use `claude-coder`. Each generated name must match a profile in the config file.
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

## An enrolled server: one command, no open port (Phase 26)

Instead of running the bridge by hand, an admin can put it on any Linux machine (systemd, x64 or arm64, root through `sudo`) with one command, and the machine then
dials **out** to the site. It needs no open port and no address the site can reach. Plan: `docs/plans/agents-anywhere.md` section 5; guide: `docs/guide/add-a-server.md`.

**What the admin does.** Runners page, "Add a server": a display name and a short name (lower case, never changes). The page shows

```
curl -fsSL https://<site>/install/bridge.sh | sudo bash -s -- --enrol <code>
```

The code works once and for 15 minutes; the site keeps only its hash. `--enrol -` makes the script read the code from `/dev/tty`, so it is in neither the shell
history nor `ps`. The careful way (download, read, check the SHA-256 shown on the page, run) is on the page too; the hash comes from the same site, so it guards
against a broken download, not against a site that was taken over.

**What the script does** (`tools/agent-bridge/install/bridge.sh`, one function `main`, shellchecked): checks root, systemd, architecture, 3 GB free; uses the
host's Node 22 or later, otherwise a pinned Node with a pinned checksum under `/opt/manythreads-bridge/node`; downloads the bridge bundle `bridge-<version>.tgz` and
checks it against the SHA-256 in the manifest; runs `npm ci --omit=dev --ignore-scripts` from a lock file for the pinned agent programs (claude-agent-acp, codex-acp,
`codex`, Playwright; `claude` comes from the SDK's platform package); creates the user `manythreads-bridge` with its home under `/var/lib/manythreads-bridge`;
installs Chromium with its libraries; installs Hermes with its pinned official installer only when the machine already has Hermes; writes the config, detects the
agents, calls `POST /api/bridge/enrol` once, keeps the answer's key in `/etc/manythreads-bridge/key` (mode 0600, passed to the service as a systemd credential),
writes `manythreads-bridge.service` (hardened) and waits up to 90 seconds for the site to say it is connected. Also: `--update` (same command, new bundle),
`--uninstall [--purge]`, `--allow-full-access` (the machine's half of the Codex full-access rule), `--no-hermes`, `--no-claude`, `--no-codex`, `--no-browser`,
`--no-publisher`. It also writes the two commands a bot runs, `mt-git` and `mt-publish` (small scripts that name this machine's Node, in `/opt/manythreads-bridge/current/tools`),
and a second hardened service, `manythreads-publisher.service` (below). It warns when `git` or `jq` is missing: the repository sync needs both. The bridge's unit has a `PATH`
that starts with the folder of the Node the installer chose, so a bot's shell finds `node` and `npm`. A container test runs the real script (Debian image, a stand-in site, `systemctl`
replaced by a recorder): `bash tools/agent-bridge/install/container-test/run.sh` (about two minutes; needs docker and a network that reaches nodejs.org and the npm registry).

**The publisher (P26-15).** A bot that may publish (its definition grants `tasks.pull_request`) runs `mt-publish check|publish <project> ...`, exactly as in a pod. On a server the command
talks to `manythreads-publisher.service`, which runs as its own user `manythreads-publisher` on the Unix socket `/run/manythreads-publisher/publisher.sock` (folder 0750, socket 0660, group
`manythreads-bridge`: only the bots' user can open it). The publisher is the pod's own `publisher.mjs` and `mt-publish.sh`, unchanged, in a mode where the push document is **asked of the
site per publish**: `GET /api/runs/self/push-credential?project=<name>` with the run's own token (`MANYTHREADS_RUN_TOKEN`). It checks who the run is (`GET /api/runs/self`: team, bot, whether
it may publish), finds the bot's clone at `<root>/work/<team>/<bot>/<project>`, writes the push document to a private temporary folder for that one call, runs the script and scrubs the
token from the answer. The push token is therefore never on the machine's disk and never in a bot's environment; the publisher's user cannot read the bridge's key, state, sign-ins or
Hermes homes (those folders are 0700 for the bridge's user). Without `--no-publisher` it is always installed; with it, no bot on the machine is told it may publish.

**What a run gets on a server (P26-15).** Before every run the bridge asks the site, with the run's own token, the same questions a pod's containers ask, and builds a copy of the bot's profile
for that run (`tools/agent-bridge/src/server-run.ts`):
- the "Where you run" text from the same function the pod renderer uses (`whereYouRun` in `@manythreads/shared`, place `server`): the working folder, the repository of record, `mt-git record-push`
  and `record-fetch` after each commit, whether the bot may publish, the deployer's login, the browser. It goes before the bot's own instructions; the config's `server.instructions` key is gone
  (a config that still has it keeps working: it is appended after this text).
- the folder of `mt-git` and `mt-publish` first on `PATH` (`server.toolsDir`), and for Claude Code the git and record commands pre-approved (and `mt-publish` for a bot that may publish).
- `MT_PUBLISH_SOCKET` and `MANYTHREADS_RUN_TOKEN` in the run's environment for a bot that may publish and for Hermes only (the ACP adapters are started without the token; the platform's tools
  get it in the session's MCP header).
- **The deployer's kubeconfig:** `GET /api/runs/self/kubeconfig` answers the team's deployer login only to the team's deployer bot (404 for any other bot). The bridge writes it to
  `<root>/kube/<team>--<bot>/config` (folder 0700, file 0600, replaced on every run, removed when the answer turns into 404) and sets `KUBECONFIG` in that bot's run only.
- **Hermes:** its own home per bot, `<root>/hermes/<team>--<bot>` (never `~/.hermes`), with one static `config.yaml` written when it differs. The file names the model's address, key and name as
  `${MANYTHREADS_LLM_URL}`, `${MANYTHREADS_RUN_TOKEN}` and `${MANYTHREADS_LLM_MODEL}`; each run sets them to the site's run proxy (`/api/llm/runs/<runId>/v1`), the run's token and the model from
  `/v1/models` (the bot's alias when its key may call it, else the first listed). The spend is on the workspace ledger and the server holds no model key.
- **The repository sync (P26-15):** `GET /api/bridge/repos` (bridge key) lists the projects of the teams placed on this server's runners, each with an https address. The bridge's
  poller (`server-repos.ts`) writes them as list lines and keeps the pod's `repo-sync.sh` running as its child; it clones the repository of record to
  `<root>/work/<team>/repos/<project>.git` and each bot's clone beside it, and `mt-git record-push` / `record-fetch` move work between a bot's clone and the record. Addresses other than https are refused.
- **Full access:** the site sends `manythreads.fullAccess` for a Codex run on a server only when the runner's switch is on; the bridge applies it only when the installer was run with
  `--allow-full-access` (`conventions.md`, "Full access for Codex").

**What the site then shows.** One runner per agent found, named `<server>-claude`, `<server>-codex`, `<server>-hermes`, kind `server_agent`, shared with teams like any
runner. Each agent with its own sign-in has a Sign-in button; the sign-in goes through the tunnel and lands in `/var/lib/manythreads-bridge/auth/<agent>`, never in a
person's own home. Rotate key sends a new key down the open connection; Remove server closes the connection, refuses the key from then on and deletes the runners
(refused while a bot is placed on one of them).

**Server mode of the bridge.** The config has a `server` section (`root`, a template per agent, `toolsDir`, `publisherSocket`) and the bridge answers a profile name of the form
`<agent>--<team>--<bot>` by making the profile from the template: workdir `<root>/work/<team>/<bot>`, the team's repositories in `<root>/work/<team>/repos`, a
Hermes home per bot. Each part of the name is a slug (lower case, digits, single `-`; no `..`, `/` or `--`; at most 63 characters); anything else is 404. There is
no `default` profile in server mode. The bridge listens on a Unix socket (`<state>/bridge.sock`, mode 0600) with a random in-process key, not on a port.

**The tunnel.** One WebSocket from the bridge to `GET /api/bridge/connect` (https only; `--insecure-for-tests` allows `ws://` in tests), `Authorization: Bearer <key>`.
Frames are JSON text: `hello`, `welcome`, `beat`, `beat_ack`, `request`, `head`, `data` (base64, at most 64 KiB), `end`, `error`, `cancel`, `rotate`, `rotated`. The site
turns a call to a server runner into a `request` frame; the bridge hands it to its own socket and answers with `head`, `data` and `end`. A beat every 20 seconds, and
three silent beats end the connection. A dropped connection has a 60 second grace before its running streams fail with "disconnected"; the bridge reconnects with
exponential back-off. Limits: 64 open streams, 1 MiB request body, 8 MiB unread per connection. A new connection from the same server replaces the old one. A refused key
closes with code 1008 and the bridge then waits five minutes before trying again. Bodies, keys and codes are never logged; the audit has `bot_server.changed` events
(code_minted, enrolled, connected, disconnected, key_rotated, removed).

**What a bot on the server can reach.** Everything the user `manythreads-bridge` can reach on that machine: its folders, its network, the key it uses to talk to
the site. The Runners page says so. Put only teams you trust together on one server.

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


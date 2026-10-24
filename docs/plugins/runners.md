# runners

A runner is a program on a machine **outside the cluster** that runs a team's agents. A bot whose `BOT.md` says
`placement: { runner: <name> }` has its runs executed there instead of in the server's own pod (SPEC §7.4, PLAN P6-06: "one
binary, one outbound connection, advertising capabilities; one runner, one team"). This page is for someone who wants to start a runner on
a machine, and for someone changing the server's half. It assumes [runtime-hermes](./runtime-hermes.md), the plugin that starts Hermes
(the open-source agent program) for a run, and [tasks](./tasks.md), which owns the `runners` table.

```
 machine outside the cluster                              the server
 ┌──────────────────────────────────────┐                ┌─────────────────────────────────────────────┐
 │ manythreads-runner (packages/runner) │  one outbound  │ runners plugin   GET /api/runners/connect   │
 │   hello ─ heartbeat ─ line ─ exit ─────  WebSocket  ──▶│   token → runner row → online              │
 │   ◀── job ─ stop                     │ (wss, bearer)  │ runtime-hermes   renders the profile, asks  │
 │   writes the profile, runs Hermes    │                │   the runner provider to run it            │
 │   shell commands run in Docker       │  model calls   │ gateway-llm      POST /api/llm/runs/<id>/v1 │
 │   per-team workspace on disk         │ ───(run token)─▶  → LiteLLM with the bot's own key          │
 └──────────────────────────────────────┘                └─────────────────────────────────────────────┘
```

Three words used below: a **profile** is the directory Hermes reads as its home (`config.yaml` with the model and tool settings,
`SOUL.md` with the bot's instructions); the **run token** is the short-lived credential a single run uses to talk to the server (its
tools and now its model calls); a **capability** is a word a runner advertises for something its machine can do (`docker`, `chrome`, …).

## What the server does (the `runners` plugin)

| piece | where | what it does |
|---|---|---|
| token | `POST /api/teams/:slug/runners/:runnerId/token` | a team lead or workspace admin mints a token for a runner row (`mtr_` + 256 random bits). It is **shown once**; only its sha256 is stored (`app.runner_tokens`, no privilege for the app role, reached through the `app.runners_token_mint` / `_revoke` doors). 201 with `{ runnerId, token, createdAt }` |
| revoke | `DELETE` the same path | turns every live token of that runner off and closes its connection on this replica; answers `{ revoked }`. A connection on another replica ends at its next heartbeat, which checks the token |
| connect | `GET /api/runners/connect` (WebSocket) | `Authorization: Bearer <token>`. A missing, unknown, revoked or archived-team token closes the socket with code 1008 `unauthorized`. The runner row's team and name come from the token |
| roster | `GET /api/teams/:slug/runners` (tasks plugin) | `status` and `capabilities` follow the connection; the tasks plugin's minute sweep marks a runner silent for 90 s offline |
| provider | `ctx.providers.get<RunnerDoor>('runner')` (SDK, `provider.runner`) | `dispatch({ teamId, runner, job }) → { lines, exited, stop() }`. `runtime-hermes` uses it so it never imports another plugin |

Register the runner row first (`POST /api/teams/:slug/runners` with `{ name, capabilities: [] }`, a lead or admin), then mint its token.
Registering marks the row `online` even before any process connects (that is the tasks plugin's door); the *connection* is what makes a
runner reachable, and the roster's capabilities fill in at its first hello.

### The protocol

JSON text frames over the one WebSocket, schemas in `packages/shared/src/runner/protocol.ts` (all strict):

| direction | frame | meaning |
|---|---|---|
| runner → server | `hello` | first frame: protocol version, program version, host name, capabilities, `maxJobs` |
| server → runner | `welcome` | accepted: runner id, name, team slug, heartbeat period (20 s) |
| runner → server | `heartbeat` | every period (20 s); the server answers nothing, refreshes `last_seen_at` and checks the token is still live. Silence for 60 s ends the connection. The 20 s also keeps the connection inside the ingress's idle limit: the live nginx ingress has `proxy_read_timeout` 3600 s, so an idle socket would survive an hour regardless, but a period must stay far below whatever idle timeout sits in front of the server |
| server → runner | `job` | `runId`, the profile (`home` and `files`), the **prompt as data**, the run budget, the kill grace |
| runner → server | `line` | one line of the agent's stdout; a long line is cut into pieces of 12 000 characters, all but the last carrying `more`, because the server reads at most 64 KiB per frame |
| runner → server | `exit` | the process ended or never started: code, signal, last 2000 characters of stderr (or the reason it was refused) |
| server → runner | `stop` | stop that job: the runner signals the whole process group, SIGTERM then SIGKILL after the grace |

The prompt is never an argument of any command on either side; the runner passes it to Hermes on standard input.

### Failing fast

`dispatch` refuses at once, with a sentence, when the runner is unknown for the team, not connected to **this server process**, full
(`maxJobs` reached) or already has that run. Under `runtime-hermes` the sentence becomes the run's failure: the run closes `failed` with
that reason in its log, nothing is posted, and the platform writes a `runners.job.refused` event (`runId`, runner name, reason) so the
reason outlives the log. A connection becomes reachable only after its `welcome` is sent (the runner ignores frames before it), so a dispatch in the window before that is refused rather than lost. A connection that drops mid-run ends the job like a killed process (`exited` with no code; the run reports "the
runner … disconnected").

A `stop` is not trusted to be answered: after it (the run's ceiling, or an explicit stop) the server waits the kill grace plus five seconds for the
runner's `exit`; if none comes — the runner still heartbeats but the job never ends — it fails the job itself ("did not report the job's exit")
and frees the slot. If the stop cannot be sent at all the job fails at once. The lines a job leaves unread are capped at 32 MB (the job is
stopped and failed past that), and the rest of a line longer than 8 MiB is thrown away, never delivered as a line of its own. A database error
while authenticating or opening a connection closes that socket with 1011 and nothing else.

### More than one server replica

A runner's connection lives in one replica's memory (the same rule as rate limits). With two replicas, a job for that runner can only be
sent from the replica it is connected to: a run that starts on the other one fails fast with "not connected to this server … it is
connected to another one". The live deployment runs one server replica, so this does not arise there. Lifting it needs a shared place
for the connection table (a Postgres `LISTEN`/`NOTIFY` hand-off from the replica that runs the job to the one that holds the socket) and
is not built.

### Events

`runners.token.minted` and `runners.token.revoked` (who, which runner, how many tokens), `runners.runner.connected` (id, name, capabilities, `maxJobs`), `runners.runner.disconnected` (reason: `closed`, `silent`, `revoked`,
`replaced`, `protocol`) and `runners.job.refused` — ids and words only, never a token. A second connection with the same token replaces
the first (code 4000), so a restarted runner is the same runner.

## The model for a run on a runner

A runner's machine cannot resolve the cluster's LiteLLM address and must not hold a provider key or the bot's key. So for a bot with
`placement.runner` the profile points the model at **this server**:

```
POST /api/llm/runs/<runId>/v1/chat/completions     GET /api/llm/runs/<runId>/v1/models
Authorization: Bearer <the run token>
```

served by `gateway-llm` (`src/run-proxy.ts`). The run token is the one the run's MCP endpoint already takes (resolved through the run
service by its sha256, so a wrong, expired or finished run's token, or another run's id in the URL, all answer the same 401). The
proxy reads the bot's virtual key as the system, puts it on the upstream request, and passes the answer through unchanged, including a
streamed one (server-sent events are not buffered, and a reader that goes away stops the upstream call). The bot's key never leaves the
server; the run token dies with the run. The request body is limited to 16 MiB and must be a JSON object; keys that name a destination or a credential (`api_base`, `base_url`, `api_key`, `api_version`, `custom_llm_provider`, `extra_headers`, `organization`) are dropped before it is forwarded. One upstream call may last ten minutes (`MANYTHREADS_LLM_PROXY_TIMEOUT_MS`), and each run has its own limit of 1200 calls a minute, counted per run id in this process rather than per client address. The router's pre-call check (egress rule, DLP, budgets)
runs before the run exactly as for a local run; LiteLLM's aliases, budgets and rate limits sit behind the proxy as before. `gateway-llm`
declares the narrow `run.resolve` door for this ([security](./security.md)).

The MCP URL in that profile is already the public address (`MANYTHREADS_PUBLIC_URL`), the same URL a local run gets.

## What the runner does (`packages/runner`)

```
pnpm --filter @manythreads/runner start -- --server https://threads.example --token-file /etc/manythreads/runner-engineering.token
```

(or `tsx packages/runner/src/main.ts …`; there is no build step). Flags, each also an environment variable:

| flag | variable | default |
|---|---|---|
| `--server` | `MANYTHREADS_RUNNER_SERVER` | required: the server's public address |
| `--token-file` | `MANYTHREADS_RUNNER_TOKEN_FILE` | required: a file with the runner token, mode 600 (a readable-by-others file is refused; the token is never a flag) |
| `--name` | `MANYTHREADS_RUNNER_NAME` | none; if set, the runner stops when the token belongs to another runner |
| `--hermes-bin` | `MANYTHREADS_HERMES_BIN` | `hermes` |
| `--hermes-home` | `HERMES_HOME` | `~/.hermes`; profiles are written to `<hermes home>/profiles/<bot>-<run>` |
| `--workspace-root` | `MANYTHREADS_RUNNER_WORKSPACE_ROOT` | `~/manythreads-workspaces`; one persistent workspace per team: `<root>/<team slug>/` |
| `--max-jobs` | `MANYTHREADS_RUNNER_MAX_JOBS` | 2 |
| `--terminal` | `MANYTHREADS_RUNNER_TERMINAL` | `docker` (shell commands run in a container); `local` runs them on the machine itself, unsandboxed, only when asked |
| `--sandbox-image` | `MANYTHREADS_RUNNER_SANDBOX_IMAGE` | `manythreads/runner-sandbox:1` |
| `--capabilities` | `MANYTHREADS_RUNNER_CAPABILITIES` | none; words added to the detected ones |

It reconnects with a growing pause (1 s up to 1 min, with jitter), re-detects its capabilities on every connect, stops running jobs when
the connection goes (nobody is left to read them) and on SIGTERM, and on start removes profiles an earlier crash left behind (only
directories it recognises by name and marker, older than two hours).

**Capabilities** are the spec's words — `chrome cdp playwright docker gpu ffmpeg windows ios-simulator claude-code codex` — plus
`hermes`, found by looking for programs on `PATH` (`docker` only when `docker info` answers). A bot's `placement.requires` is matched
against them.

### Per job

1. The received job is **checked**. The profile name must be `<bot slug>-<this run's id>` and must not exist yet (an existing Hermes profile such as `default` is never overwritten or deleted). The `config.yaml` must parse, hold only the sections the server renders (`model`, `providers`, `mcp_servers`, `agent`, `platform_toolsets`) and only the keys the server renders inside them (a provider may not carry `api_key_env` or `base_url`; an MCP entry only `url`, `headers`, `timeout`, `connect_timeout`), and every MCP server must be an address, never a program to start (`command`, `args`, `env`). Anything else is refused and reported as the job's exit. The server does not get to name a program for the host to run.
2. The runner **appends its own policy**: a `terminal:` section. For `docker`:

   ```yaml
   terminal:
     backend: "docker"
     cwd: "."
     timeout: 180
     lifetime_seconds: <budget + 60>
     docker_image: "manythreads/runner-sandbox:1"
     docker_mount_cwd_to_workspace: true
     docker_run_as_host_user: true        # only when the runner is not root
     docker_extra_args: ["--label", "manythreads-runner-run=<runId>"]
   ```

   The server never decides a machine's sandbox; the runner does.
3. The profile is written owner-only (directory 0700, files 0600, the marker file first), Hermes is started as the leader of its own
   process group with `HERMES_HOME` set to the profile, the **team workspace as its working directory**, and an environment limited to an
   allowlist (`PATH`, `HOME`, locale, CA-bundle paths, `HERMES_*`) — the runner's token and settings are not in it.
4. Stdout lines go back as `line` frames. A `stop`, the budget (plus grace) or a lost connection signals the whole group.
5. When nothing of the run is left, the profile is removed (retried: Hermes writes its log directory as it exits), the sandbox containers
   carrying the run's label are removed (Hermes leaves them running), the job's slot is freed, and then the `exit` frame is sent.

The process-group, environment-allowlist and profile handling is the same code the server's own Hermes provider uses
(`@manythreads/sdk/process`), so a runner and a local run cannot drift.

### The sandbox (measured on Hermes 0.21.5)

Run against the real CLI on the devbox (`hermes chat --oneshot --format stream-json`, the host's default model), with the policy above:

- **Shell commands run in the container**: `uname` reported a container host name, the working directory was `/workspace`, `/etc/os-release`
  was Debian from the sandbox image (Node 22, pnpm, git, Python).
- **File tools run in the container too**, with `/workspace` the mounted team directory: a file written to `notes.txt` appeared in
  `<workspace root>/<team>/` on the host and was visible to a later shell command; a write to `/tmp/escape-test.txt` or `../outside.txt` stayed
  inside the container and never reached the host; `read_file /etc/hostname` returned the container's.
- **`cwd` must be `"."`.** With `cwd: "/workspace"` Hermes takes the path for one already inside the container and skips the mount: commands
  then run in an empty directory and what the agent writes never reaches the host. Hermes resolves `"."` to the process directory — the team
  workspace — and mounts it.
- **Hermes leaves its container running** after the process exits (it sleeps forever); hence the label and the runner's cleanup.
- **An empty tool list is not "no tools"**: `platform_toolsets.cli: []` gave the agent terminal, file, web and sub-agent tools. See the next
  section.
- The profile is mounted into the container only as read-only cache and skill directories; `config.yaml` (which holds the run token) is not.

Build the image once on the machine: `docker build -t manythreads/runner-sandbox:1 packages/runner/sandbox`.

### Which tools a bot gets (`capabilities.runtime`)

The definition's `capabilities.runtime` lists what the bot's *process* may do. `runtime-hermes` turns it into the profile's tool list
(`src/toolsets.ts`, a pure function with tests), for local and runner runs alike:

| grant | Hermes toolset |
|---|---|
| `shell` | `terminal` (the `terminal` and `process` tools) |
| `files` | `file` (`read_file`, `write_file`, `patch`, `search_files`) |
| `browser`, `web`, `vision` | `browser`, `web`, `vision` (a runner needs the matching capability for browser use) |
| `git` | nothing of its own — git is a program in the shell, so it needs `shell` |
| anything else | ignored |

`platform_toolsets.cli` lists the toolsets that are on; a bot with no grant gets only `todo` (an in-memory checklist), because an empty
list means "everything" to Hermes. `agent.disabled_toolsets` names every guarded toolset that was not granted (code execution,
sub-agents, scheduled jobs, memory, skills, device and third-party services among them) and wins over everything else. Measured: a bot
with `runtime: [files]` could write files and could not run `echo` — no terminal tool was offered, and a request to use one wrote nothing.
Its platform tools (messages, tasks, pages …) are unaffected: they come from the run's MCP endpoint and the capability broker.

## Install on a host

1. In the team, register the runner and mint a token (a lead or admin; keep the token, it is shown once):

   ```
   POST /api/teams/engineering/runners            { "name": "server-1", "capabilities": [] }   → runner.id
   POST /api/teams/engineering/runners/<id>/token                                              → { "token": "mtr_…" }
   ```
2. On the machine: `install -d -m 0755 /etc/manythreads`, write the token to `/etc/manythreads/runner-engineering.token` with mode 0600, and
   the settings to `/etc/manythreads/runner-engineering.env`:

   ```
   MANYTHREADS_RUNNER_SERVER=https://manythreads.kahf.to
   MANYTHREADS_RUNNER_NAME=server-1
   MANYTHREADS_RUNNER_WORKSPACE_ROOT=/var/lib/manythreads/workspaces
   HERMES_HOME=/root/.hermes
   ```
3. Build the sandbox image (above), copy `packages/runner/deploy/manythreads-runner@.service` to `/etc/systemd/system/`, and
   `systemctl enable --now manythreads-runner@engineering.service`. One unit per team (one runner, one team); the instance name picks the
   `/etc/manythreads/runner-<instance>.*` files.
4. Point a bot at it in `bots/<slug>/BOT.md`: `placement: { runner: server-1 }`.

Hermes on this host (v0.21.5) only boots when `HERMES_HOME` is `<its home>/profiles/<name>`, which is where the runner writes each run's
profile.

## Not built yet

- Several server replicas (above).
- `placement.requires` is advertised but not matched at dispatch: a bot names its runner.
- The node placement (`placement.node`, an in-cluster `nodeSelector`) belongs to the Helm chart's controller, not here.

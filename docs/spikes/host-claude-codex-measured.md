# P19-01 / P19-13: Claude Code and Codex measured on the devbox host (2026-11-10 and 2026-11-11)

Owner decision of 2026-11-10: no second Claude login; the measurement items of P19-01 (Claude) and P19-13 (Codex) are closed against the
command-line tools that are logged in on THIS host (`claude` and `codex` in `/root/.local/bin`), using the host logins in place.

Rules this page follows: it holds texts, field names, versions and yes/no answers only. No token, no credentials file content, no value of
any field of a sign-in file. Texts marked **(binary)** were taken from the program's own strings, not provoked, and must be replaced when a
real one is seen.

## What was run

| What | How |
|---|---|
| Claude Code `2.1.319` | real `claude -p --output-format stream-json --verbose --restricted --strict-mcp-config` runs (new, resume, tool use, tool refused), negative runs with an empty `HOME`, a bad key, a bad token, a bad model, a bad flag, a missing session |
| Codex `0.166.0` | real `codex exec --json` runs (new, resume, file create), a run with an empty `CODEX_HOME`, a bad model, a bad flag, a missing thread |
| The real bridge | `tools/agent-bridge` on `127.0.0.1`, one `claude` and one `codex` profile, driven over HTTP with the run protocol (start, events, resume with the same `session_id`, stop, a file created in the work folder, a refusal to write outside it). Every run ended `completed`; a stand-in MCP server saw the platform tool call with the run token header expanded |
| Not done | no limit text was provoked (taking a limit would cost the owner's plan); no expired-login or reused-refresh-token text was provoked (it would log the host out) |

## Claude Code

- Version `2.1.319`. The driver flags (`-p`, `--output-format stream-json`, `--verbose`, `--restricted`, `--strict-mcp-config`, `--mcp-config`,
  `--append-system-prompt-file`, `--tools`, `--model`, `--effort`, `--session-id`, `--resume`, `--no-session-persistence`) are all accepted.
- Event stream, in order: `system/init` (carries `model`, `claude_code_version`, `session_id`, `tools`, `mcp_servers`, `permissionMode`),
  `assistant` (content `tool_use` or `text`), `rate_limit_event`, `user` (tool result), `system/permission_denied` (when a tool is not allowed),
  `assistant`, `result`. The parser reads exactly these; nothing it needs was missing.
- `result` keys that matter: `is_error`, `subtype` (`success` or `error_during_execution`), `result`, `errors`, `api_error_status`,
  `terminal_reason` (`completed` or `api_error`), `session_id`, `num_turns`, `stop_reason`, `usage`, `total_cost_usd`.
- Model names: the alias `sonnet` runs `claude-sonnet-5-5` (shown in `init` and on every `assistant` event). A name that does not exist
  is not rejected before the call (see the texts below).
- Session resume: `--session-id <uuid>` on the first run, `--resume <uuid>` after; the second run knew the first run's content. The same id
  on a second `--session-id` while the first still exists is refused ("is already in use"), so the driver's "new, else resume" choice matters.
- Tool use: a platform MCP tool under `mcp__manythreads__*` was called; the header `Authorization: Bearer ${MANYTHREADS_RUN_TOKEN}` in the
  MCP config is expanded from the process environment, so the token is not written to the config file. A tool outside `--tools` produced
  `system/permission_denied` and the model answered without it.
- Exit codes: a normal run exits `0`. Every failure measured (not logged in, bad key, bad token, bad model, missing session, session id in
  use) exits `1`; the API failures also say so in the `result` event (`is_error: true`, `terminal_reason: api_error`). A bad flag prints to
  stderr and writes no stdout.
- Shape booleans (in-process, yes/no only): the access token begins with the published prefix `sk-ant-oat01-`: yes. The refresh token
  begins `sk-ant-ort01-`: yes. The credentials file has the field names the bridge reads (`claudeAiOauth.accessToken`, `refreshToken`,
  `expiresAt`): yes. The access token lives about 8 hours and the program renews it in place (the file's modification time changed on
  2026-11-11); the bridge and a person using `claude` on this host therefore share one login and one refresh.

### Real texts (account failures)

| Case | Text printed (the `result` string, also the text of a synthetic `assistant` message with an `error` field) | `api_error_status` |
|---|---|---|
| Not logged in (empty `HOME`) | `Not logged in · Please run /login` (assistant `error: authentication_failed`) | none |
| Bad API key | `Invalid API key · Fix external API key` (`authentication_failed`) | 401 |
| Bad OAuth token | `Failed to authenticate. API Error: 401 OAuth access token is invalid.` (`authentication_failed`) | 401 |
| Bad model | `There's an issue with the selected model (<name>). It may not exist or you may not have access to it. Run --model to pick a different model.` (`model_not_found`); stderr `[claude-code:unrecognized_model] {...}` | 404 |
| Missing session | stdout `result` has `subtype: error_during_execution`, **no `result` text**, and `errors: ["No conversation found with session ID: <id>"]`; stderr `No conversation found with session ID: <id>` | none |
| Session id in use | stderr `Error: Session ID <id> is already in use.`, no stdout | none |
| Bad flag | stderr `error: unknown option '--bogus-flag'`, no stdout | none |
| Expired login **(binary)** | `login has expired`, `Please run /login`, `OAuth session has expired` families | |
| Limit **(binary)** | `Claude usage limit reached`, `You've hit your <name> limit`, `5-hour limit`, `weekly limit`, `Opus limit`, `usage credit limit`, `limit will reset` families | |

The live `rate_limit_event` carries `resetsAt` (epoch seconds); `limitResetsAt` in the bridge does not read it yet (a limit pauses the runner
for the default 30 minutes).

### Mismatches found and fixed

1. `FAILURE_PATTERNS` were case sensitive and matched stand-in words. The real `Not logged in · Please run /login`, `Invalid API key` and
   `API Error: 401 OAuth access token is invalid` were not classified as `needs_sign_in`. All rows are now case-insensitive and cover the texts above.
   The limit row also knows the Opus, Sonnet, Fable and usage-credit limit names.
2. A failed `result` with `errors[]` and no `result` text gave an empty error and hid "No conversation found", so the driver's
   "resume failed, start again" path never ran. The driver now reads `errors[]` when `result` is empty.
3. The synthetic `assistant` message that Claude Code writes for an API failure (it has an `error` field) was posted as if it were the
   bot's words. The driver now skips it; the failure is reported once, from `result`.

## Codex

- Version `0.166.0`. `codex exec --json --skip-git-repo-check -C <dir> -c ... -m <model> -` and `codex exec resume <thread> ...` are accepted.
  `exec resume` has no `-C`, so the work folder is the process directory (as the flags spike already says). A bad flag is refused by the argument parser
  (`error: unexpected argument '--bogus-flag' found`, stderr only).
- Events: `thread.started` (`thread_id`), `turn.started`, `item.started` / `item.completed` (types `agent_message`, `command_execution`,
  `error`, MCP tool call items), `turn.completed` (`usage`), `turn.failed` (`error.message`), and top-level `error` (`message`). Resume
  continued the thread (`thread_id` kept). A missing thread: stderr `Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)`.
- File create in the work folder worked under `sandbox_mode="workspace-write"`; a write outside it was refused by the sandbox.
- Model names listed by the program's own cache: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna` (the alias map in a profile maps a platform alias such as `smart` to one of these). A name not in the list is
  refused with `The '<name>' model is not supported when using Codex with a ChatGPT account.` (event `error`, then `turn.failed`)
  after an `item.completed` of type `error` that says `Model metadata for '<name>' not found...` (a warning, not a failure).
- `~/.codex` before and after one `exec`: the same files; `config.toml` grew by one `[projects."<work folder>"]` `trust_level = "trusted"` entry
  per new work folder (the program writes it itself), the log database and the model cache changed. `auth.json` was not rewritten by `exec` runs.
  A lock file `auth.lock` exists next to `auth.json` (the name the keeper waits for was right).
- Refresh: `last_refresh` was 8.93 days old on 2026-11-10 and 9.59 days on 2026-11-11 and `exec` runs did not renew it, so the 8-day hold
  (`CODEX_RENEW_AFTER_MS`) is conservative. The access token is a 10-day JSON web token; recheck near its expiry (about 2026-11-11 19:14 UTC)
  whether the program renews it by itself.
- Shape booleans (in-process, yes/no only): the access and id tokens are JSON web tokens (`eyJ...`): yes. The refresh token begins
  `rt_`: **no**. It begins `rt.1.` followed by 191 characters of the URL-safe base64 alphabet.

### Real texts (account failures)

| Case | Text |
|---|---|
| Not logged in (empty `CODEX_HOME`) | Five `error` events `Reconnecting... n/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: ...)`, an `item.completed` of type `error` (`Falling back from WebSockets to HTTPS transport...`), more `Reconnecting...` events over HTTPS, then `error` and `turn.failed` (exit 1) with `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: ..., request id: req_...`. stderr is full of `failed to connect to Responses WebSocket` lines. The run takes about 15 seconds. |
| Bad model | see above |
| Refresh token reused **(binary)** | `Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.` family |
| Limit **(binary)** | `You've hit your usage limit` with `Try again at <time>` family |

### Mismatches found and fixed

1. The refresh token shape is `rt.1.<body>`, not `rt_...`. The DLP `signin-token` detectors (`packages/plugins/guardrails-dlp/src/dlp.ts`) and
   the bridge's `redact()` (`tools/agent-bridge/src/process.ts`) did not know it, so a refresh token printed alone in an answer would not have been caught. Both now
   match `rt.<digits>.<40 to 512 URL-safe characters>` (the old `rt_` guess is kept); tests with a made-up sample of the measured shape were added.
2. With `approval_policy="never"` Codex refused every platform MCP tool call. The driver now also passes
   `-c mcp_servers.manythreads.default_tools_approval_mode="approve"` (checked live: the stand-in MCP server saw the call).
3. `Reconnecting... n/5` is reported as an `error` event even when the run then succeeds. The driver ignores those and keeps the last other
   `error` only to explain a failure (`turn.failed`, or exit 0 without `turn.completed`, or a non-zero exit).
4. `FAILURE_PATTERNS` for Codex are now case-insensitive and include `Missing bearer or basic authentication`.

## Not updated (left for the owner of those files)

- `deploy/images/claude-pod-fake` stand-ins still print the old made-up texts (`FAKE401`, `FAKELIMIT`) and the old event shapes.
- `limitResetsAt` does not read Claude's `rate_limit_event.resetsAt` nor Codex's `Try again at <time>`.

## How the live pods can reach THIS host's bridge (written down, nothing executed on live)

What the live product allows today, from the code:

- The runner kinds `claude_cli` and `codex_cli` are pod-only (they ask the `claude.pods` provider for a bridge inside the cluster). A host
  bridge cannot be one of those.
- The kind that takes an address and a key typed by an admin is `hermes_gateway`. Its address passes the outbound guard on every request:
  10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16 are allowed, loopback and link-local never (unless `MANYTHREADS_HERMES_ALLOWED_HOSTS` lists them).
- **Gap (closed by P19-14, 2026-11-11: the runner has an `agent` field; the text below is what was found):** a `hermes_gateway` runner resolved with `agent: 'hermes'`
  (`packages/plugins/bot-runners/src/resolve.ts`). The run job sends the `manythreads` object (run token, MCP address, tools, model) only for the
  agents `claude-code` and `codex`. So a bridge registered as a `hermes_gateway` runner would run the bot as plain chat with no platform tools
  (it could answer, not post, read or call tools). Since P19-02 the older team connection (which has an `agent` field) can no longer be written
  by anyone but a workspace admin through Runners, and Runners has no `agent` field. The smallest change: an `agent` field (`hermes`,
  `claude-code`, `codex`) on a `hermes_gateway` runner that sets `target.agent` in `resolveRunner` (and the profile rule for the bridge's
  profile names). That change belongs to the owner of `bot-runners` and `runtime-hermes`; it was not made here.
- `docs/agent-bridge.md` said "add the bridge as a connection"; it now says "add it under Runners" with the `agent` field (P19-14).

The steps, in order (each one only written down; the gap above is closed by P19-14, so step 7 can be done once that is deployed):

1. **Network path.** On this host (k3s, node address `10.0.2.15`, bridge `cni0` at `10.42.0.1`, pod network `10.42.0.0/24`) pods reach the host at
   `10.42.0.1`, the same way the existing host Hermes gateway (`hermes-gateway.service`, `10.42.0.1:8642`) is reached today.
   Address to type: `http://10.42.0.1:8650` (or `http://10.0.2.15:8650`). Use a port other than 8642. 8650 is the bridge's default port.
2. **Bind address.** Start the bridge with `--listen 10.42.0.1:8650`, never `0.0.0.0` and never the public address: the bridge starts processes that
   can write files. Bind only to the pod-network address so the machine's public interface does not answer.
3. **Firewall.** `ufw` is inactive and the `iptables` INPUT policy is ACCEPT on this host, so nothing has to be opened. If a firewall is turned on later,
   allow `10.42.0.0/24` to `10.42.0.1` on tcp `8650` only. The server pod has no egress NetworkPolicy; the `manythreads-bots` pods are
   limited by their own policies and are not involved (the call comes from the server pod).
4. **Key.** Make a key of at least 8 characters (24 random bytes in hex is plenty) in a file with mode 0600 (`--key-file`, or `AGENT_BRIDGE_API_KEY`). The same
   key is typed into the runner's form; it is stored encrypted and never shown again.
5. **Config.** One profile per bot name the platform will send (the profile rule `{bot}` is the bot's slug), each with `agent`, `workdir`
   (a clone, not the live checkout) and optional `model` / `modelAliases`. Example: `claude` profile `{ "agent": "claude-code", "workdir": "/srv/bridge/work", "model": "sonnet" }`,
   and a Codex profile `{ "agent": "codex", "workdir": "/srv/bridge/work-codex", "model": "gpt-6-luna" }`.
6. **Service.** An example unit (an example only; the bridge docs advise a dedicated unprivileged user, this host runs as root, so a user that owns the
   `claude` and `codex` logins is needed; the logins are read from that user's `~/.claude` and `~/.codex`):

   ```
   [Unit]
   Description=manythreads agent bridge (host)
   After=network-online.target

   [Service]
   User=bridge
   WorkingDirectory=/opt/manythreads
   Environment=PATH=/home/bridge/.local/bin:/usr/local/bin:/usr/bin:/bin
   ExecStart=/usr/bin/node --experimental-transform-types tools/agent-bridge/src/main.ts --config /etc/manythreads-bridge/bridge.json --listen 10.42.0.1:8650 --key-file /etc/manythreads-bridge/api-key
   Restart=on-failure
   NoNewPrivileges=true

   [Install]
   WantedBy=multi-user.target
   ```

7. **Runner (admin form, Runners > Add).** Kind `hermes_gateway`, **What runs the bot** = "Claude Code on the bridge" or "Codex on the bridge" (the `agent` field, P19-14),
   name for example `host-claude`, base URL `http://10.42.0.1:8650`, the key from step 4, profile rule `{bot}`, open to the chosen teams. Then "Test":
   it asks `GET /health` with the key and must say the bridge answered (it does not list or need a profile). Place a bot with `placement.runs_on: host-claude` in `BOT.md`.
8. **Sharing the login.** The bridge on the host and a person using `claude` on the host share one login and one renewal of the access token. Two
   bridge runs at the same time are fine (the program does the renewing); do not also copy the file to a pod (two copies of one login sign each other out).
9. **Check.** Mention the bot in a thread and read the answer; `journalctl -u manythreads-bridge` shows one line per run (no texts). Undo: delete the
   runner, stop the unit.

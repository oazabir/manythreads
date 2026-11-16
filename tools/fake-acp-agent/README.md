# fake-acp-agent

An ACP agent that is not an agent. It speaks the agent side of the Agent Client Protocol (v1, JSON-RPC, one object per line on
stdin and stdout) with `@agentclientprotocol/sdk` 2.7.0 and plays a **script** instead of running a model. The bridge's ACP driver
(P25-03) and everything above it are tested against it, with no Hermes, Claude or Codex, no sign-in and no model spend.

What it sends follows `docs/spikes/acp-measured.md` (P25-01), per **flavor** (`claude`, `codex`, `hermes`): the sign-in methods, the
permission option ids, which step statuses exist, how a helper is marked, what `session/cancel` does to a running step, what resume and
load replay, and what an unknown session id answers. It also sends what the bridge must drop: `rawInput`, Claude's `toolResponse`,
Codex's `terminal_output_delta`, and an e-mail in the auth status.

## Run it

```
pnpm -C tools/fake-acp-agent start                              # the built-in script, flavor claude
tsx src/cli.ts --script=my-script.json
FAKE_ACP_SCRIPT_JSON='{"scenarios":{"a":[{"do":"text","text":"hi"}]}}' tsx src/cli.ts
FAKE_ACP_FLAVOR=codex FAKE_ACP_STATE_DIR=/tmp/fake-acp tsx src/cli.ts
tsx src/cli.ts --cli auth login --claudeai                      # the terminal sign-in program (prints a URL, reads a pasted code)
```

In a test, in the same process: `createFakeAcpAgent(script).app.connect(stream)` (or `clientApp.connect(fake.app)`); `fake.received`
holds every request the client sent (the `_meta`, the `mcpServers`, the prompt).

## A script

JSON, see `src/script.ts` for the types and `DEFAULT_SCRIPT` for one of each.

- `scenarios`: named lists of actions. A prompt containing `[[name]]` plays that one; else `default`; else the first.
- Actions: `text`, `thought`, `step` (kind, `toolName`, `paths`, `diff`, `ms` for a slow step, `fail`), `helper` (a subagent with its own
  steps), `plan`, `permission` (a step that waits for the person; `onReject` runs after a No), `usage` (with a cumulative cost on the
  Claude flavor), `sleep`, `fail` (a JSON-RPC error), `stop` (a stop reason). `{{prompt}}`, `{{turn}}`, `{{sessionId}}`, `{{cwd}}` fill in text.
- `auth`: `signedIn`, `requireSignIn`, `url`, `deviceCode`, `pendingMs` (`null` waits for `completeSignIn()`), `account`.
- `stateDir`: keep sessions and the sign-in on disk, so a second process can resume or load them and the login program can sign the agent in.
- `cancelDelayMs`, `autoUsage`, `tickMs`.

Known gaps against the real adapters: no MCP client (the `mcpServers` a client sends are recorded, not called), no model, no
`session/set_config_option` effect, `fork` and `title` are advertised but not implemented.

## Tool calls, commands and the chain's scripts (P27-19)
- `{ "do": "mcp", "tool": "tasks.claim", "args": { "taskId": "{{promptId}}" }, "store": "claim" }` makes a real MCP `tools/call` at the `http` server the client gave `session/new` (its bearer header included), shown as a step.
  A refusal (`{ ok: false }`, `isError`, no server) fails the step; the script goes on. `store` keeps the parsed answer for `{{var:claim.task.id}}` in the actions after it.
- `{ "do": "run", "command": "mt-publish check starter", "store": "r" }` runs the command with `sh -c` in the session folder; `{{var:r.code}}` and `{{var:r.out}}` hold its exit code and last output.
- `src/chain.ts`: `chainScript(slug, options?)` and `writeChainScripts(dir, options?)` give one script per bot of the Engineering chain (`CHAIN` lists them in order).
- `bundle.mjs <file>` bundles the agent into one file for `deploy/images/claude-pod-fake`; env `FAKE_ACP_SIGNED_OUT=1` starts it signed out and `FAKE_ACP_SIGNIN_CODE` sets the one code its terminal sign-in accepts.

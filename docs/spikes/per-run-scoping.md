# P5-02 spike · per-run tool scoping

Question (PLAN P5-02): two concurrent conversation runs for two people — can the run id be
carried so tools scope per run? If not, adopt the per-run MCP URL fallback. Orchestrator decides.

## Findings (Hermes v0.21.5+6232, devbox `~/.hermes/hermes-agent`, 2026-10-03)

- **No per-run tool-scope primitive.** `grep -ri per-run|per_run|runId|run_id` over
  `gateway/` + `hermes_cli/` finds only per-run retry counters (`tools/mcp_tool_server_run.py`),
  transient `extra_prompt` (`tools/cronjob_tools.py`) and `HERMES_KANBAN_RUN_ID` — nothing that
  scopes an MCP server, toolset or credential to a run.
- **MCP client config is static.** `mcp_servers:` in `~/.hermes/config.yaml` (see `#:1551`),
  per server: `command`+`args`+`env` (stdio) or `url` + `headers` (HTTP), plus
  `timeout`/`connect_timeout`/`keepalive_interval`/`lazy`. No per-run URL or token variable.
- **Per-invocation selection exists.** `-t TOOLSETS`, `--resume` / `--pass-session-id`,
  `-p <profile>`, `-q/--oneshot` for headless runs — the runtime can already launch one Hermes
  invocation per run, but invocations sharing one config file would share one MCP endpoint.
- **Our side already carries the run.** `withActor` sets `app.run_id` (`Actor.runId`,
  `packages/kernel/src/db/with-actor.ts`); the `run_source_log` insert policy keys on
  `run_id = app.run_id()` (P5-00/P5-03). The run id exists everywhere except inside Hermes.

## Decision: per-run MCP URL fallback (adopted)

P5-09 gateway mints **one MCP endpoint URL + bearer token per run** (token ↔ run_id, bot,
asker, resolved server-side, never trusted from the caller). `runtime-hermes` (P5-10) launches
**one Hermes invocation per conversation run** with a generated per-run config pointing at that
URL (`headers` carry the token). Every tool call is then bot-capabilities ∩ asker-visibility
with run source logging, by construction — a forged or cross-run URL resolves to no run and is
denied (same test shape as P5-15's forged `bank`).

## Deferred

The live two-concurrent-runs experiment needs the P5-09 gateway and P5-16 conversations, so it
moves there: two runs, two people, two run URLs — each run sees only its own tools, and asking
with the other run's URL is denied. This decision unblocks both tasks.

Non-goals: no change to Hermes source (never vendored into this repo); no per-run logic inside
Hermes itself — scoping lives in our gateway, Hermes just gets a URL per run.

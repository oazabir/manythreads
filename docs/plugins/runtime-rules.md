# runtime-rules

The no-model runtime (SPEC §7.1, §8; PLAN P5-10). It registers one `bot_runtime` provider — `rules` — so a bot whose `BOT.md`
says `runtime: rules` runs deterministically, with **no model call anywhere**. That is the whole point: §8's counting benchmark
(twenty bots claim a task, add one and release, and the log must read 1→20 with no duplicate or gap) is a per-PR test only if
it is free, fast and repeatable (`pnpm test:runtime-rules`, PLAN P6-10, where the benchmark itself lands).

## What a rules run is

* Its **rules** are the definition's `capabilities.native`, **in the order the author wrote them** — the one ordered list a
  `BOT.md` already has, so this runtime invents no syntax of its own (`rulesOf`). A rules bot has no body-driven persona to
  render, and its profile is the run's rules as `rules.json`, written for the same reason a Hermes profile is: so `render` is
  honest about being a profile and can be asserted in a test.
* Every rule is called with the trigger's message and its place (`ruleInput`: `channelId`, `body` = the prompt, `threadRootId` —
  exactly the strict shape of `messages.post`; the bot, team and run come from the run's own transaction, never from arguments)
  through the run's scope — the same door a Hermes tool call goes through — so a call is authorized by the broker and its
  effect carries the run's bot. Per-rule arguments arrive with the task substrate (P6), which is what will pass a task id.
* The run answers with **no text**: a rules bot does not chat. Its effects are the answer, and the run row, its audit events and
  `run_source_log` say what happened. The router therefore posts nothing for a rules run, and a rules bot should not be given a
  chat trigger it cannot answer.
* A rule that fails ends the run (`ok: false`, the error's message in the result). The order is the contract; carrying on past
  a failed step is how a rules bot's log starts reading differently run to run.
* A definition with no `capabilities.native` runs, does nothing, and says so in the run's log.

Two consequences worth stating plainly: a rules bot needs no gateway key and no MCP endpoint (the endpoint is opened anyway, so
its run is a run like any other — it just never calls it), and a rules bot can be used as the substrate's test harness without a
model credential anywhere in CI.

## Where the rest of it lives

Routing, the run row, the source log, the reply and the trigger rules all belong to [runtime-hermes](./runtime-hermes.md): the
router looks the provider up by the loaded bot's `bots.runtime` value
(`ctx.providers.get('bot_runtime', runtime)`), so this plugin is only the provider. A `rules` bot needs both plugins loaded;
without `runtime-rules` the run is refused and logged rather than run on the wrong provider.

## Tests

`test/rules.test.ts` — the rules come from `capabilities.native` in order; every rule runs through the scope with the trigger
data and the run answers `text: ''`; a failing rule stops the run with its reason; a definition with no rules does nothing and
logs why; the profile is the run's rules. No database, no model, no Hermes binary.

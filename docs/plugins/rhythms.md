# rhythms

A rhythm is a bot's repeating work (PLAN P6-08; SPEC §6.5): a **heartbeat** (a prompt on a timer), a **routine** (a prompt with a contract and a
page output) or a **task** (a recurring card on the board). Every rhythm runs as one of the team's bots, on a 5-field cron schedule in UTC.

## Tables

| table | what it holds |
|---|---|
| `rhythms` | one row per schedule: `bot_id`, `kind`, `schedule`, optional `model_alias` and `effort` overrides, `contract_path` (routines), `output_path` (`pages/…`), `enabled`, `next_run_at` |
| `rhythm_runs` | one row per firing: `status` (`queued`/`running`/`done`/`failed`), the `run_id` once a runtime starts it, the `task_id` a task rhythm created, `output_path`, and the `reason` a failed routine keeps |

`rhythms` is writable by a team **manager** (lead) only; `rhythm_runs` is written by the system. Both read by team membership; a rhythm id from
another team is a 404.

## The schedule

- Cron is the shared parser in `packages/shared/src/common/cron.ts` (5 fields, `*`, ranges, lists, `/step`, three-letter day and month names).
  It is the same grammar the kernel's job schedules use, so a schedule a person types on the Rhythms screen is one the scheduler can fire.
- `next_run_at` is computed when a rhythm is created or changed, and only an enabled rhythm has one. A schedule that can never fire (Feb 30) is
  refused with a 400 at the API, not silently stored.
- The **tick** job (`rhythms.tick`, every minute) takes every enabled rhythm whose `next_run_at` has passed with `FOR UPDATE SKIP LOCKED` (two
  replicas cannot fire one rhythm twice in a tick), files its run and advances its next slot in the **same transaction** — a crash cannot skip a
  slot or fire it twice. A slot that passed while the server was down is not replayed: the schedule advances to the next future slot.

## What a firing does

- **routine** — the contract is read first from the team repo at `contract_path` (`routines/<slug>.yaml`): `name`, optional `prompt`, and
  `output: { page, mode }` where `page` must be under `pages/` and `mode` is `create`/`replace`/`append` (`RoutineContract` in
  `src/scheduler.ts`). A missing file, bad YAML or an invalid contract is a **failed run with the reason** (the screen can say why) and nothing
  is queued. A good one sets the run's `output_path` (the rhythm's own override wins).
- **task** — creates a card on the board (`kind: other`, branch `rhythm/<id>`) with a `created` event that names the rhythm.
- **heartbeat** — just files the run for a runtime to pick up.
- Every firing emits `rhythms.rhythm.ran` with the run's status and output.

## Routes (`/api/teams/:slug`)

| method | path | who |
|---|---|---|
| GET | `/rhythms` | any team reader |
| POST | `/rhythms` | team **manager** (lead) |
| PATCH | `/rhythms/:rhythmId` | team manager |
| GET | `/rhythms/:rhythmId/runs` | any team reader (last 50) |
| POST | `/rhythms/:rhythmId/run` | team manager; files a run now (202) — rate limited 30/min |

A `botId` or `botSlug` names the bot and must be one of the team's own. `contractPath` must start with `routines/`; `outputPath` must start with
`pages/`. Only a routine needs a contract path; only a bot can own a rhythm.

## Not built yet

The run starter: a queued run row exists so the ledger and the screen are honest, but no job yet opens a bot run for it (`run_id` stays null).
The screen and its forms (P6-08's UI, including a non-lead's proposal) do exist in `clients/web`: **Rhythms** is its own sidebar entry
(`/t/<team>/rhythms`), not a tab inside Boards.

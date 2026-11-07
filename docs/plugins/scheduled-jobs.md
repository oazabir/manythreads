# Scheduled jobs (called Jobs in the app)

The `scheduled-jobs` plugin runs a team's timers: work a bot does again and again without anyone asking. The page in the app, the web address (`/t/<team>/jobs`) and the words on screen say **Jobs**; the code, tables, events and API paths say `scheduled_job`, because the kernel already has its own job queue (`app.jobs`) and a bare "job" would be ambiguous. Until phase 21 the plugin was called `rhythms`; migration 0002 renamed its tables in place, and the old web address `/t/<team>/rhythms` redirects.

A scheduled job is a bot's repeating work (PLAN P6-08; SPEC §6.5): a **heartbeat** (a prompt on a timer), a **routine** (a prompt with a contract and a
page output) or a **task** (a recurring card on the board). Every scheduled job runs as one of the team's bots, on a 5-field cron schedule in UTC.

## Tables

| table | what it holds |
|---|---|
| `scheduled_jobs` | one row per schedule: `bot_id`, `kind`, `schedule`, optional `model_alias` and `effort` overrides, `contract_path` (routines), `output_path` (`pages/…`), `enabled`, `next_run_at` |
| `scheduled_job_runs` | one row per firing: `status` (`queued`/`running`/`done`/`failed`), the `run_id` once a runtime starts it, the `task_id` a task scheduled job created, `output_path`, and the `reason` a failed routine keeps |

`scheduled_jobs` is writable by a team **manager** (lead) only; `scheduled_job_runs` is written by the system. Both read by team membership; a scheduled job id from
another team is a 404.

## The schedule

- Cron is the shared parser in `packages/shared/src/common/cron.ts` (5 fields, `*`, ranges, lists, `/step`, three-letter day and month names).
  It is the same grammar the kernel's job schedules use, so a schedule a person types on the Jobs screen is one the scheduler can fire.
- `next_run_at` is computed when a scheduled job is created or changed, and only an enabled scheduled job has one. A schedule that can never fire (Feb 30) is
  refused with a 400 at the API, not silently stored.
- The **tick** job (`scheduled-jobs.tick`, every minute) takes every enabled scheduled job whose `next_run_at` has passed with `FOR UPDATE SKIP LOCKED` (two
  replicas cannot fire one scheduled job twice in a tick), files its run and advances its next slot in the **same transaction** — a crash cannot skip a
  slot or fire it twice. A slot that passed while the server was down is not replayed: the schedule advances to the next future slot.

## What a firing does

- **routine** — the contract is read first from the team repo at `contract_path` (`routines/<slug>.yaml`): `name`, optional `prompt`, and
  `output: { page, mode }` where `page` must be under `pages/` and `mode` is `create`/`replace`/`append` (`RoutineContract` in
  `src/scheduler.ts`). A missing file, bad YAML or an invalid contract is a **failed run with the reason** (the screen can say why) and nothing
  is queued. A good one sets the run's `output_path` (the scheduled job's own override wins).
- **task** — creates a card on the board (`kind: other`, branch `scheduled job/<id>`) with a `created` event that names the scheduled job.
- **heartbeat** — just files the run for a runtime to pick up.
- Every firing emits `scheduled_jobs.scheduled_job.ran` with the run's status and output. A queued one also carries what the runtime needs to start the bot
  (the scheduled job's name, the routine's prompt and output mode, the model and effort overrides), so the runtime never reads this plugin's tables.

## What happens after a firing is queued

The bot runtime (`runtime-hermes`, `src/router-scheduled-jobs.ts`) hears the queued firing and starts the bot. In plain words:

1. **Can the bot be woken?** It must still exist, be active, and list a `routine` trigger in its `BOT.md` (a trigger that names one routine only
   matches that routine). It also needs a public channel it may post in. If any of this is missing, the firing ends **failed** with a plain
   reason ("The bot X has no routine trigger in its BOT.md …") and no bot run is opened. A firing never stays queued.
2. **One run per firing.** The run is queued once, keyed by the firing's id; a second delivery of the same event starts nothing.
3. **The prompt.** A routine gets the contract's prompt plus where its output goes and how (create, replace or append). A heartbeat gets a short
   "scheduled check-in" naming the scheduled job. A task scheduled job gets the card it created. The scheduled job's `model_alias` and `effort` replace the bot's own
   for that run only.
4. **The ledger.** `queued` becomes `running` (with `run_id`) when the bot's run opens, then `done` or `failed` when it ends. The runtime reports
   with `runtime.scheduled_job.started` and `runtime.scheduled_job.finished`; this plugin updates its own rows from them (`src/ledger.ts`) and announces each
   step with `scheduled_jobs.scheduled_job.ran`. If a run ends without the runtime reporting (a held approval, a crashed worker), the `bots.run.closed` event
   settles the firing as failed.
5. **Where the output goes.** A scheduled run has no thread, so what it posts goes at the top of the team's first public channel that the bot may
   post in.
   - A **routine**'s final reply is written to the contract's page as the bot, through the `pages.write` capability (so the bot needs that grant,
     and the path rules and a live editing session apply). The bot then posts "wrote `<page>` · diff" there, linking to the page in Files where
     its history and diffs are. A run that produced no reply, or a page that could not be written (for example `create` on a page that exists),
     ends **failed** with that reason and writes nothing.
   - A **task** scheduled job's reply is posted in the channel like any run's reply.
   - A **heartbeat** posts nothing by itself: the bot decides, using its own tools. A failed scheduled run posts no notice; the reason is on the
     firing.

## Routes (`/api/teams/:slug`)

| method | path | who |
|---|---|---|
| GET | `/scheduled-jobs` | any team reader |
| POST | `/scheduled-jobs` | team **manager** (lead) |
| PATCH | `/scheduled-jobs/:scheduledJobId` | team manager |
| GET | `/scheduled-jobs/:scheduledJobId/runs` | any team reader (last 50) |
| POST | `/scheduled-jobs/:scheduledJobId/run` | team manager; files a run now (202) — rate limited 30/min |

A `botId` or `botSlug` names the bot and must be one of the team's own. `contractPath` must start with `routines/`; `outputPath` must start with
`pages/`. Only a routine needs a contract path; only a bot can own a scheduled job.

## A person's own routines (P20-10 to P20-14)

A routine can also belong to one **person** instead of a team: `scheduled_jobs.owner_person_id` is set and `team_id` is null (exactly one of the two, a CHECK). It runs as a bot the
person can ask, with the **person as the asker** (`asker_person_id` is generated from the owner, so it can never be set to someone else), in the person's own conversation with that
bot (`bot_conversation` channel). What a bot can read is therefore what that person may read, through the same run space rules as a chat. The routine writes only to the owner's
Personal files.

- **The file.** `Routines/<slug>/routine.yaml` in the owner's Personal files holds the name, the person's words, the prompt, the places to look (`sources`), the schedule and the output.
  The platform reads the prompt from it at every firing, so an edit is live at the next run. The schedule, time zone, sources and output are also columns, so the tick never has to
  parse a file to know when to fire. The output goes to `output_path` (default `Routines/<slug>/output.md`, never under `Memory/`) through the `personal.files` provider (files plugin)
  in `replace`, `create` or `append` mode.
- **Setting up in words** (`POST /api/me/scheduled-jobs/draft`): the sentence and the person's time zone give a *proposal* (name, schedule in words and cron, prompt, sources, output).
  The schedule always comes from the deterministic parser (`wordsToSchedule`); the model (`fast` alias, through the model gateway, purpose `routine_draft`) only words the prompt, and plain
  rules take over when it is unavailable (`by: 'rules'`). Nothing is saved. Creating needs `confirmed: true`, so a routine is never enabled by a script that skipped the preview.
- **Guards** (all enforced by the platform, never by the prompt): at most 20 routines per person; no schedule faster than every 15 minutes and at most 96 firings a day; a monthly cost
  allowance per person (workspace setting, default 5 US dollars, read through the model gateway ledger); the person's quiet hours (a firing due inside them is held until they end);
  one firing at a time per routine; a routine uses the scopes of its owner and cannot widen them (it is the owner's own asker). Only the platform may stop a routine, and it records why
  (`stopped_reason`: `bot_off`, `bot_gone`, `not_a_member`, `consent_withdrawn`, `connection_gone`, `owner_deactivated`, `spend_cap`) before telling the owner **once** with a message in their
  Reminders conversation and the event `scheduled_jobs.scheduled_job.stopped` (the notifications plugin turns it into a bell notification). A person turns it back on from the routine;
  that re-checks the same conditions. Removing a bot sets `bot_id` to null and stops its routines (`bot_gone`); they stay in the list.
- **Tick.** `tickPersonalRoutines` (same once-a-minute job as the team tick) and `tellStops` (its own job `scheduled-jobs.tell-stops`, because each notice is its own transaction and must
  not wait on rows the tick holds). "Run now" skips quiet hours and the gap but not the blockers or the allowance.
- **Action items** (`GET/PATCH /api/me/action-items`): the list is one file, `Action items/action-items.md`, in the person's Personal files; every change is a new version, and a change
  made on a stale copy (the `revision` token) is a 409. The "keep my action items" routine is a personal routine with `recipe_id = 'action-items'`.

| method | path | what |
|---|---|---|
| GET | `/api/me/scheduled-jobs` | my routines, my limits and my settings |
| POST | `/api/me/scheduled-jobs` | make one (needs `confirmed: true`); 409 with a plain sentence when the bot, consent or a connection is missing |
| PATCH / DELETE | `/api/me/scheduled-jobs/:id` | change (rewrites the file; turning on clears a stop) / remove (the files stay) |
| POST | `/api/me/scheduled-jobs/:id/run` | run now (202) — rate limited 10/min |
| GET | `/api/me/scheduled-jobs/:id/runs` | the last 50 firings |
| POST | `/api/me/scheduled-jobs/draft` | a proposal from a sentence — rate limited 20/min |
| PUT | `/api/me/routine-settings` | my time zone and quiet hours |
| GET / PUT | `/api/workspace/routine-settings` | the monthly allowance per person (any member reads; owner or admin changes) |
| GET / PATCH | `/api/me/action-items` | the action-items list |

## Open points

A scheduled run that is held for a person's approval ends its firing as failed; approving the call later resumes the run but not the firing.
The screen and its forms (P6-08's UI, including a non-lead's proposal) do exist in `clients/web`: **Jobs** is its own sidebar entry
(`/t/<team>/jobs`), not a tab inside Boards.

## The screens for a person's routines (P20-11, P20-12)

Code in `clients/web/src/screens/files/routines/` and `screens/files/actionItems/`, mounted in the Account frame (the Files screen is not touched): `/account/routines` (RoutinesTab) and `/account/action-items` (ActionItemsView), both in the Account nav for everyone but a guest. **Routines:** "New routine" takes a sentence and asks `POST /api/me/scheduled-jobs/draft`; the person reads the plan (what was understood, when in words, the prompt, what it may look at, where the answer goes, and the server's notes) and edits anything except the time, which is changed by changing the sentence. "Turn it on" is the only thing that sends `confirmed: true`. The "Ready routines" shelf (`PERSONAL_ROUTINE_RECIPES`) opens the same plan. A row shows On, Paused or Stopped; a stopped routine says why in a sentence and offers "Turn back on". Run now, Runs (what each run read, as counts), Pause and Delete (asks first; the routine's files stay). "Time and limits" holds the time zone, quiet hours, the routine count, the month's spending against the allowance and the per-run limits. **Action items:** tick, edit, add, "Add to board" (the card is made by the person through the tasks API, then recorded in the list), a stale save is refused with 409 and the list reloads with a sentence saying the change was not saved, and the "Keeping it up to date" block offers the keeper routine as a plan the person turns on. The mock (`api/mock-routines.ts`) answers the same routes. Test hooks: `routine-*`, `action-item-*`, `keeper-*`; words are tested in `clients/web/test/routines-words.test.ts`.

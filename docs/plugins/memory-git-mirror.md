# memory-git-mirror

The OKF bundle's mirror between `memory/` in a team's repo and the team's Hindsight bank (SPEC §12.1, PLAN D6 and P5-14). The repo is the truth; the bank is the retrieval engine over it. A commit under `memory/` re-retains each changed concept; a delete or `status: deprecated` forgets it; the first use of a team's memory writes the bundle root; the daily consolidation writes `memory/journal/<date>.md`.

Package: `packages/plugins/memory-git-mirror` (PLAN writes `plugins/memory-git-mirror`; same `discoverPlugins` deviation as the other plugins). Manifest: `extends: ['event.subscribe', 'job.register']`, `dependsOn: ['memory', 'repo-git', 'bots']`, consumes `repo.repo.committed`. It writes to the engine only through the memory provider (`provider.memory`, today memory-hindsight) with `provider.forTeam(tx, teamId)` in a system transaction, so the bank is derived from the team the **database** says a path belongs to, never from an event field, an argument or a bot. It writes to a repository only through the one writer (`ctx.providers.get<RepoProvider>('repo')`), as the system actor.

**Inert without an engine** (`MANYTHREADS_HINDSIGHT_URL` unset): one `not_configured` line per team per day (the same line the feed writes), nothing queued but the removal of a document the bank already holds, and **no write to any repository** — on such a deployment the bundle is files a person edits and this plugin changes nothing. (The live deployment is in that state; deploying this plugin altered no repo.)

## What a concept is

`memory/**.md` except `index.md` and `log.md` (`isConceptPath`, `@manythreads/shared`). Every other file under `memory/` (`.gitkeep`, a `.csv`) is not a concept and is never read. The file is read from the repo **index** (`repo_entries.text_plain`: UTF-8 text up to 1 MB; no git process) and parsed by the shared OKF parser (`parseConcept`): frontmatter capped at 64 KB, aliases and anchors refused, `type` required.

> **P5-24 is not built yet.** The minimum the mirror needs lives in `packages/shared/src/okf` (`parseConcept`, `serializeConcept`, `OkfFrontmatter`, `trustTier`, `isStale`, `isConceptPath`, `renderBundleIndex`, `renderBundleLog`), written under the names PLAN P5-24 lists so that task **extends the module in place**: it adds `sources`, `usage_window`, the actor convention, `OkfIndex`/`OkfLog` and the 40 hostile inputs; it does not rename or replace what is here. `okf_invalid` (422) in the repo writer is P5-25; until then a file that is not OKF reaches git and the mirror reports it.

| What the file is now | The bank | Log line |
|---|---|---|
| a valid concept, not deprecated | **retained**: path + keyed digest | `retained` |
| unchanged since the last retain | nothing | none |
| edited | the old document is **forgotten first**, then the new one retained | `forgotten` `replaced`, `retained` |
| deleted, or no text any more (binary, over 1 MB) | forgotten | `forgotten` `deleted` / `no_text` |
| `status: deprecated` | forgotten (git keeps the history) | `forgotten` `deprecated` |
| `status: draft` | retained, tagged `status:draft` | `retained` |
| not valid OKF (no frontmatter, no `type`, an alias, ...) | nothing, and anything held goes | `withheld` `okf_invalid: <reason>` (once per reason) |
| written by a bot in a run that read something narrower than the team | nothing, and anything held goes | `withheld` `authoring run: <refusal>` |
| written by a bot in a run that has not closed | looked at again; after a day withheld | `withheld` `run_open` |

The log is `memory_retain_log` (the `memory` plugin's table; migration `memory/0002` adds `source_kind = 'concept'`, source id `<team id>/<path>`), so the retain-log route shows concepts next to the feed's lines, to the same people (team leads and workspace admins). The newest `retained` / `forgotten` line of a concept says what the bank holds (the rule of reading the log is one function in `@manythreads/sdk`, `memory-ledger.ts`, which the `memory` plugin uses too).

**The document.** `okf:<first 24 hex of sha-256(path)>:<first 16 hex of the keyed digest>`. The digest is an HMAC-SHA-256 under the workspace's key (`memory_workspace_keys`, the feed's: an unkeyed hash of a concept would let anyone who reads the log or an id test a guess), taken over the text **and** everything the tags and metadata say (type, status, trust tier, origin, tags, `stale_after`): adding a human `verified` entry is a new document, not an unchanged one. The engine is given: a header (path, type, status, trust tier, origin, last author and day), the title, the description and the body (`tidy`ed, cut at 18,000 characters with a note). The frontmatter's own YAML is not sent: provenance (`generated`, `verified`, `sources`) is the platform's and not a claim for the engine to read.

Tags: `okf`, `kind:concept`, `type:<type>`, `trust:<unverified|machine-confirmed|human-reviewed>`, `status:<status>`, `origin:<origin>` (when set), `tag:<t>` for the concept's first eight tags. Metadata: `feed_kind: concept`, `concept_path`, `concept_type`, `status`, `trust_tier`, `origin`, `stale_after`, `actor`, `actor_name`, `occurred_at`, `link` (`/t/<team>/files?open=<path>`); the provider adds `source: platform`, `team` and `workspace`.

## How a commit reaches the bank

Same shape as the feed (docs/plugins/memory.md "How a change reaches the bank"), for one kind of source:

```
repo.repo.committed ──▶ handler (outbox consumer's transaction): one row per concept path in memory_mirror_pending, one queued drain,
                        and, once per team, the job that writes the bundle root. Never reads text, never calls the engine.
                              ▼
         drain job (memory-git-mirror.drain: after the debounce, and cron every minute)
            for each due concept: resolve it NOW ──▶ decide ──▶ engine + log
```

* **The event is only "this path changed".** Every `memory/` path of every commit is marked, puts and deletes, however many (a catch-up of the index emits chunks of at most 500 paths; `memory/` is **not** in the guarded exclusion list `bots/`, `TEAM.md`, `skills/`, `routines/`, so a catch-up reaches the mirror). Debounce `MANYTHREADS_MIRROR_DEBOUNCE_MS` (5 s); `MANYTHREADS_MIRROR_DEFER_MS` (30 s), `MANYTHREADS_MIRROR_BACKOFF_MS` (30 s).
* **The drain reads the file as it is now**, so a late or repeated event cannot bring back a deleted concept, and an event that names the wrong team reads that team's index and finds nothing (`test:memory-cross-team` forges one).
* **Idempotent.** The same concept delivered again is nothing. One drain at a time across replicas (an advisory lock), at most 100 concepts per drain, 25 per engine call, `async: true`.
* **The engine failing** backs the concept off in its own row (30 s, 60 s, ... to 30 min); a 400/413/422 on a chunk retries its items one at a time; after 8 failed retains a `failed` line is written and the row dropped (the next change retries it). A **forget** is never given up on: the row stays, tried every half hour, with one `failed` line that carries the document id.
* **The digest key** is made by the handler that marks a concept (same transaction as the work row) and only read by the drain.

## The bundle root

The first time a team's memory is touched (a commit with a path under `memory/`, with an engine configured) the job `memory-git-mirror.ensure` writes, in one commit by the system (`Create the team memory bundle`, author null), whichever of these is missing:

* `memory/index.md` — frontmatter `okf_version: "0.2"` and nothing else, then a short note;
* `memory/log.md` — date-grouped, newest first: one entry, "The memory bundle was created by the platform".

It never overwrites a file that exists, and records the team in `memory_mirror_teams` in the same transaction (so it happens once however many events arrive) **only when both files are in the index**. The writer's 409 is read for what it is: a 409 that **names files** means somebody wrote one in between (nothing was written, so the other may still be missing: look again, write what is missing), and a 409 that names none (`ref_conflict`) lost a race for the branch (write again); up to three attempts, then the job fails and is retried. Neither is ever "present" until a look at the index says so, and the same rule decides a journal's "exists". An archived team is left alone. **P5-25** makes the writer regenerate every directory's `index.md` and the log in the same commit as a change; these two files are what it starts from, and this job becomes a no-op for a team whose root exists.

## The journal

`memory-git-mirror.journal` (cron `23 2 * * *`, UTC) finds the teams whose `memory_retain_log` has a `retained` or `forgotten` line of the team bank in yesterday (UTC) and queues `memory-git-mirror.journal-team` for each (`{ workspaceId, teamId, date }`, deduplicated). The team job writes `memory/journal/<date>.md`:

```yaml
type: Journal
title: Journal 2026-10-12
tags: [journal]
status: stable
origin: journal
generated: { by: process:journal, at: <when> }
```

The body is counts and links, **never the retained text**: a table of taken-in / taken-out by source kind, and a list of links to what was taken in that day and is still in the bank (no later `forgotten` line), at most 200, the rest counted. **What was left out is not in it**: a journal is a file of the team repo that every member reads, while a withheld line (and why) is the retain log's, readable by leads and workspace admins (SPEC §15); a day with only withheld lines writes no journal. Only the team bank's lines count (`store = 'team_bank'`): a person's file (`person_file`, P5-26) never makes a team's journal, counts or links. The journal's own re-retain and other journals are not counted. Not written for a day with nothing in the log, for a day that is not over, when the file exists (a person's edit stays) or for an archived team; written through the one writer, so the commit emits `repo.repo.committed` and the mirror retains the journal like any concept (type `Journal`, origin `journal`).

## Privacy

`memory/` is the team's repo: team-visible by definition. The one rule that remains is the feed's: **what a bot wrote without being asked to retain it must not out-reach the run that wrote it.** A concept whose last commit was a bot's is judged exactly as a page is: `app.memory_authored_verdict(bot actor, commit time)` at the git author date and at the instant the index recorded it; a run still open defers; any refusal withholds. (The bot writer path, `memory.write`, is P5-26 and out of scope; until then a bot reaches `memory/` only through a `files.write` grant.) The platform's own writes here — the root and the journal — contain no retained text. A run's verdicts survive retention (docs/plugins/retention.md "The feed's verdict").

## Tables (`migrations/0001_mirror.sql`)

`memory_mirror_pending (team_id, path)` — the work list; `memory_mirror_teams (team_id)` — the teams whose root was seen to. Both system-only (`rls: system`, no privilege for the request role), both cascade with the team.

## Tests

* `test/render.test.ts`, `test/decide.test.ts`, `test/journal.test.ts` — pure: the document, tags and metadata, the keyed digest and the id, every case of the decision table, the journal text and the day rules.
* `test/drain.test.ts` — the drain against a real database and a stand-in engine: retained once with its tags, unchanged, edited (forget then retain; a verifier alone is an edit), deleted, deprecated and made stable again, draft, invalid (once, and a held document goes), index/log/non-concepts skipped, binary, a bot's concept in a refused run / outside a run / in an open run (then `run_open`), another team's bank only, a wrong-team event, a team that is gone, engine down (back-off, `failed` after 8), a forget that never gives up, a 422 retried singly, no engine; and the event handler (every path marked, the root requested once, nothing for other paths, `not_configured`).
* `test/bundle.test.ts` — the writer's refusals (file conflict, lost race, persistent, no file found), the bundle root recorded only when both files are there, a journal "exists" only when it is, the team bank's lines only (a `person_file` line adds nothing), no left-out column.
* `test/mirror.test.ts` — through the real server and `tools/fake-hindsight`: a commit reaches the bank; the root written once as the system; an edit, `deprecated` and a delete; an invalid file; the journal from the cron job (counts and links, no text, no withheld link), mirrored, written once; no journal for an empty or unfinished day.
* `test/rls/mirror.test.ts` — both tables invisible to the request role, harness rules, cascade.
* `packages/plugins/memory-hindsight/test/cross-team/feeding.test.ts` (in `pnpm test:memory-cross-team`) — team A's concepts never reach team B's bank, whatever an event claims; each team's root is in its own repo.
* `packages/shared/test/okf/concept.test.ts` — the minimal parser, its refusals and its hostile inputs.

## Not here (open)

* `okf_invalid` refusal in the writer, the regenerated indexes and log, `memory_concepts`: P5-25. `memory.write` and recall filters: P5-26. The full parser: P5-24.
* Retention of the retain log's concept lines follows the same rule as every other line (docs/plugins/retention.md).
* A concept longer than the engine takes is cut (a note says so); chunked documents are not built.
* No backfill: a concept that was in `memory/` before the engine was configured enters the bank when it is next committed.

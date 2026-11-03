# memory-share

The way a team passes knowledge to other teams on purpose. A lead or workspace admin writes a small file that says **what** may leave the team's memory, **to which teams**, **how often** and **who must approve**. The platform (never a model) then picks the matching concepts, builds a **digest** from them (a small, checked bundle of Markdown files), runs it past the workspace's data rules, and asks a person to approve it in Approvals. This plugin stops there: the digest is built, checked, approved and recorded as a run that is **ready**. Handing it to the other team is the next task.

Package: `packages/plugins/memory-share` (PLAN P8-22, P8-23; SPEC §12.3). Manifest: depends on `teams`, `repo-git`, `memory`, `approvals` and `guardrails-dlp`; `extends: ['event.emit', 'event.subscribe', 'job.register', 'hook.pre_egress']`; emits `memory.share.defined`, `memory.share.built` and `memory.share.settled`; consumes `repo.repo.committed` and `approvals.approval.decided`. Schemas: `packages/shared/src/entities/share.ts`, `packages/shared/src/api/shares`, `packages/shared/src/events/memory.share.*.ts`; the bundle check is `packages/shared/src/okf/conformance.ts`. Migration: `migrations/0001_memory_share.sql` in the plugin's own folder (numbered per plugin; the PLAN's "0064" is only a label).

Words used here. A **concept** is one Markdown file of a team's memory with a short header (its type, title, description, tags, status). A **digest** is the bundle sent to other teams: a summary page plus, optionally, copies of the concepts. A **run** is one attempt to build a digest. **Left out** means a concept that matched the share but may not go, with one reason.

## The share file

`routines/shares/<slug>.yaml` in the team's repository, written through a proposal like any other file (a lead or admin applies it).

```yaml
name: Release notes for Support and Marketing
to: [customer-support, marketing]        # destination team slugs; not the team itself
select:
  paths: [decisions/, playbooks/]        # under memory/; a trailing slash means a folder
  types: [Decision, Playbook]            # any of, ignoring case
  tags: [release, customer-impact]       # any of, ignoring case
  minTrust: machine-confirmed            # unverified (default), machine-confirmed, human-reviewed
  skipStale: true                        # default true: leave out concepts past their stale_after
mode: summary                            # summary (default) or full
when: { cron: "0 8 * * MON" }            # or "manual" (default)
approval: review                         # review (default) or auto
approvers: [role:lead]                   # role:<name> or person:<id>; default the team's leads
```

Unknown keys are refused (a typo must not loosen what is shared). If the file is wrong the share is kept as **invalid** with a sentence saying why, and it cannot run; fixing the file loads it again. Deleting the file marks the share **removed** and ends its links. A destination named in the file gets a link in state `requested`; a destination taken out of the file has its link ended. Linking states `accepted` and `paused` belong to the receiving team and are set by the next task. A destination is accepted only if the person who committed the file can read that team (or is a workspace admin); otherwise the file is invalid with the same sentence as for a team that does not exist, so a share file cannot be used to ask which teams exist.

`approval: auto` is honoured only when the person who committed the file was a lead of the team or a workspace owner or admin. Otherwise the share still asks for a review (the page shows what the platform will really do as `approvalEffective`). The same check is made again when a run is built, and the definer must still be an active person: a lead who has since been removed or suspended no longer switches the review off, and the run goes to review.

## What is selected

Selection reads the team's frontmatter index (`memory_concepts`), not the files, so a preview is cheap. The filters (`paths`, `types`, `tags`) decide what **matches**. Without `select.paths`, `memory/shared/` (what other teams sent) and `memory/references/` (original documents) are not even matched. Each matched concept that may not go is **left out** with the first reason that applies, in this order:

| reason | meaning |
|---|---|
| `received` | it came from another team (`origin: share`, or under `memory/shared/`): never passed on |
| `original` | it is an original document (under `references/`, or type Reference, or links into `references/` that cannot be removed) |
| `personal` | it is a note about a person (`origin: person`) |
| `draft` / `deprecated` | its status |
| `team_only` | its header says `share: never` |
| `trust` | below `minTrust` |
| `stale` | past its `stale_after` while `skipStale` is on |
| `dlp` | the workspace's data rules stopped it |
| `unreadable` | its file could not be read when the digest was built |
| `too_large` | over the digest's size cap |

**Only what changed goes.** Each run records a manifest (path to content hash) of what it carried. The next run is compared with the last run that was `sent` in the same mode: the same hash does not go again, a new hash is "changed", a new path is "added". A concept the team has since deprecated or marked team-only is named in the next digest as **retired** (no content). It is named by its path only (`decisions/old`), never by its title, type or tags today, because it may have become private since it was sent.

**Known limit (owner question for P8-24):** the baseline is the last `sent` run of the share, shared by all destinations. A team that accepts later, or whose delivery failed, gets only what changed since that run. A baseline per destination needs the delivery records of P8-24. A cap of 300 concepts and 6 MB applies; the rest are left out as `too_large`.

## The digest

An OKF bundle (the memory format, version 0.2):

- `index.md` with `okf_version` and nothing else;
- `log.md` with one dated entry;
- `digest.md`, type `Digest`, with `from` (the team id), `share`, `period`, and one entry in `sources` per concept; the summary text is footnoted `[^s1]` to those ids. A title or description cannot forge a footnote or a heading;
- in `full` mode, a copy of each selected concept at its own path with `sources` replaced by one entry pointing home, links into `references/` removed, and `verified` turned into `origin_trust` (trust does not travel).

One digest goes to every team that has accepted, so the bundle names none of them (who else receives it is not the recipient's to know); the recipient is added at delivery (P8-24).

The same selection always builds the same bytes and the same fingerprint (`digestSha`), so two presses of Run now never file two digests of the same files. The bundle is checked with the memory parsers (`checkOkfBundle`) before anything is asked of a person; a digest that fails the check ends `blocked` with the first problem.

## The data rules

Every piece of text that would leave goes through `guardrails-dlp` at `pre_egress` with the workspace's guard preset: each title, description and body, each retired path, the digest summary, and then every file of the finished bundle (so tags, resource, type, stale_after and every other copied field are covered too). A redaction replaces the text in the digest and is counted. A stop leaves that concept out as `dlp` (the run names its path, never its text). If the finished summary or any finished file still trips a rule, or would be redacted, the run ends `blocked`. If no `pre_egress` hook is registered at all (the data-rules plugin is not running), nothing may leave: the run ends `blocked`. A workspace whose policy has no detector switched on is not blocked; that is the workspace's own choice (open owner question: whether to refuse in that case too).

## Runs and approval

Run states: `building`, `empty` (nothing matched or nothing changed), `blocked`, `awaiting_approval`, `ready`, `denied`, `expired`, `failed`, `sent` (set by the next task).

1. A run begins from **Run now** (a lead or admin, filed as them) or from the schedule (`when.cron`; a tick job runs each minute, starts due shares and lets unanswered approvals lapse).
2. A build job makes the digest. The result is stored with the run (the files are readable only by the system role, never through the API).
3. With `review`, an Approvals row is filed: source `grant`, tool `memory.digest.send`, requested by the person who pressed Run (a scheduled run is filed as the person who defined the share). Its preview names the destinations, what is included, what is left out with reasons, and the difference since last time. It never holds the text of a concept. The approvers are the share's `approvers`. **The requester can never decide their own digest.** Approving moves the run to `ready` (and the Approvals row to `ran`, so the hand-back sweep leaves it alone); denying moves it to `denied`. An approval nobody answers lapses in 7 days and the run becomes `expired`.
4. With `auto` (honoured as above) the run goes straight to `ready` with no row.

A run is built only for teams that have accepted the share and are not archived. With none, the run ends `empty` with the reason "No team has accepted this share yet (or the teams that did are archived)"; the preview still shows each link's state. A scheduled run of a share whose sending team is archived, or that has no receiving team, is skipped. In `summary` mode each included concept's file is read again at build time (not only the index), and a concept that carries a `from` key (received from another team) is left out as `received`.

A run that stays in `building` for more than 15 minutes (a crashed build) is failed by the tick with "The digest was not finished in time. Run the share again.", so it cannot keep its share from running again (one `building` run per share).

Run now answers `202` with the run in `building`; read the run again to see where it ends. Only one digest of a share is built at a time (a second press gets `409`).

## Routes

| route | who | answer |
|---|---|---|
| `GET /api/teams/:slug/shares` | anyone who can read the team | the shares with destinations, the last run's state, `canManage` |
| `GET /api/teams/:slug/shares/:shareSlug` | same | one share |
| `GET /api/teams/:slug/shares/:shareSlug/preview` | lead or admin | selection only, nothing built or stored: counts, headline ("Matches 12 concepts · 3 left out"), included, left out with reasons, the diff |
| `POST /api/teams/:slug/shares/:shareSlug/run` | lead or admin | `202`, the new run; `409` when a build is already running or the share is invalid |
| `GET /api/teams/:slug/shares/:shareSlug/runs[?limit=]` | lead or admin | the runs, newest first |
| `GET /api/teams/:slug/shares/:shareSlug/runs/:runId` | lead or admin | one run |

Runs are for managers only because they name what was left out.

## Data and permissions

Tables (all with forced row-level security): `memory_shares` (one per file, with the definition, status, schedule and `auto_allowed`), `memory_share_links` (one per destination; keeps the destination's name and slug because people outside a team cannot read it), `memory_share_runs` (one per attempt, with the digest files, the manifest and the lists). Team readers read shares and links; managers read runs, except the `bundle` column, which the request role cannot read at all. Only the system role writes shares and links; a run can be started by a manager as themselves, at the first state, and only the system role changes it afterwards. Two definer functions are the only ways to file and settle the Approvals row (`app.memory_share_request_approval`, system role only; `app.memory_share_settle`).

## Events

`memory.share.defined` (a file was loaded, found invalid or removed), `memory.share.built` (a run reached `awaiting_approval`, `ready`, `empty`, `blocked` or `failed`, with counts and the number of concepts withheld by reason) and `memory.share.settled` (an approval turned a run `ready` or `denied`, or it expired). They carry ids, counts and short reason codes only; never a path, a title or any text of a concept. The audit trail's "what was withheld" view (P10-05) reads these counts.

## Not built here

- Accepting a share, delivery to the destination's inbox and moving a run to `sent` (P8-24).
- Receiving and importing a digest on the destination side (P8-25).
- Any web page: the share list, the preview, the run history and the Approvals card (P8-26). The routes above are what that page will use.
- The Archivist's narrative in `digest.md`: the summary is built by the platform from titles and descriptions only.

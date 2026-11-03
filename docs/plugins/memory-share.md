# memory-share

The way a team passes knowledge to other teams on purpose. A lead or workspace admin writes a small file that says **what** may leave the team's memory, **to which teams**, **how often** and **who must approve**. The platform (never a model) then picks the matching concepts, builds a **digest** from them (a small, checked bundle of Markdown files), runs it past the workspace's data rules, and asks a person to approve it in Approvals. The **receiving team** must accept the share first (its leads decide in Approvals) and can pause or end it later. An approved digest is **delivered** into each accepting team's inbox, and the receiving side **imports** it without a model: it checks the whole bundle, files it under `memory/shared/<sending team>/`, and refuses the whole thing if anything is wrong. A workspace switch, **Memory sharing**, stops every send.

Package: `packages/plugins/memory-share` (PLAN P8-22 to P8-25; SPEC §12.3). Manifest: depends on `teams`, `repo-git`, `memory`, `approvals`, `guardrails-dlp` and `memory-inbox`; `extends: ['event.emit', 'event.subscribe', 'job.register', 'hook.pre_egress', 'provider.inbox.importer']`; emits `memory.share.defined`, `memory.share.built`, `memory.share.settled`, `memory.share.linked`, `memory.sharing.switched`, `memory.digest.delivered` and `memory.digest.imported`; consumes `repo.repo.committed` and `approvals.approval.decided`. Schemas: `packages/shared/src/entities/share.ts`, `packages/shared/src/api/shares`, `packages/shared/src/events/memory.share.*.ts`; the bundle check is `packages/shared/src/okf/conformance.ts`. Migration: `migrations/0001_memory_share.sql` in the plugin's own folder (numbered per plugin; the PLAN's "0064" is only a label).

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

Unknown keys are refused (a typo must not loosen what is shared). If the file is wrong the share is kept as **invalid** with a sentence saying why, and it cannot run; fixing the file loads it again. Deleting the file marks the share **removed** and ends its links. A destination named in the file gets a link in state `requested` (and an accept row is filed for that team, below); a destination taken out of the file has its link ended. The states `accepted`, `paused` and `revoked` belong to the receiving team. A destination is accepted only if the person who committed the file can read that team (or is a workspace admin); otherwise the file is invalid with the same sentence as for a team that does not exist, so a share file cannot be used to ask which teams exist.

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

**Known limit (owner question):** the baseline is the last `sent` run of the share, shared by all destinations. A team that accepts later, or whose delivery failed, gets only what changed since that run. A baseline per destination (the delivery records of P8-24 make it possible) is not built. A cap of 300 concepts and 6 MB applies; the rest are left out as `too_large`.

## The digest

An OKF bundle (the memory format, version 0.2):

- `index.md` with `okf_version` and nothing else;
- `log.md` with one dated entry;
- `digest.md`, type `Digest`, with `from` (the team id), `share`, `period`, and one entry in `sources` per concept; the summary text is footnoted `[^s1]` to those ids. A title or description cannot forge a footnote or a heading;
- in `full` mode, a copy of each selected concept at its own path with `sources` replaced by one entry pointing home, links into `references/` removed, and `verified` turned into `origin_trust` (trust does not travel).

One digest goes to every team that has accepted, so the bundle names none of them (who else receives it is not the recipient's to know). The recipient's own team is not written into the bundle either: the delivery record names it.

The same selection always builds the same bytes and the same fingerprint (`digestSha`), so two presses of Run now never file two digests of the same files. The bundle is checked with the memory parsers (`checkOkfBundle`) before anything is asked of a person; a digest that fails the check ends `blocked` with the first problem.

## The data rules

Every piece of text that would leave goes through `guardrails-dlp` at `pre_egress` with the workspace's guard preset: each title, description and body, each retired path, the digest summary, and then every file of the finished bundle (so tags, resource, type, stale_after and every other copied field are covered too). A redaction replaces the text in the digest and is counted. A stop leaves that concept out as `dlp` (the run names its path, never its text). If the finished summary or any finished file still trips a rule, or would be redacted, the run ends `blocked`. If no `pre_egress` hook is registered at all (the data-rules plugin is not running), nothing may leave: the run ends `blocked`. A workspace whose policy has no detector switched on is not blocked; that is the workspace's own choice (open owner question: whether to refuse in that case too).

## Runs and approval

Run states: `building`, `empty` (nothing matched or nothing changed), `blocked`, `awaiting_approval`, `ready`, `denied`, `expired`, `failed`, `sent` (delivered to at least one accepting team; set by the delivery job).

1. A run begins from **Run now** (a lead or admin, filed as them) or from the schedule (`when.cron`; a tick job runs each minute, starts due shares and lets unanswered approvals lapse).
2. A build job makes the digest. The result is stored with the run (the files are readable only by the system role, never through the API).
3. With `review`, an Approvals row is filed: source `grant`, tool `memory.digest.send`, requested by the person who pressed Run (a scheduled run is filed as the person who defined the share). Its preview names the destinations, what is included, what is left out with reasons, and the difference since last time. It never holds the text of a concept. The approvers are the share's `approvers`. **The requester can never decide their own digest.** Approving moves the run to `ready` (and the Approvals row to `ran`, so the hand-back sweep leaves it alone); denying moves it to `denied`. An approval nobody answers lapses in 7 days and the run becomes `expired`.
4. With `auto` (honoured as above) the run goes straight to `ready` with no row.

A run is built only for teams that have accepted the share and are not archived. With none, the run ends `empty` with the reason "No team has accepted this share yet (or the teams that did are archived)"; the preview still shows each link's state. A scheduled run of a share whose sending team is archived, or that has no receiving team, is skipped. In `summary` mode each included concept's file is read again at build time (not only the index), and a concept that carries a `from` key (received from another team) is left out as `received`.

A run that stays in `building` for more than 15 minutes (a crashed build) is failed by the tick with "The digest was not finished in time. Run the share again.", so it cannot keep its share from running again (one `building` run per share).

Run now answers `202` with the run in `building`; read the run again to see where it ends. Only one digest of a share is built at a time (a second press gets `409`).

## The receiving team's consent (P8-24)

Naming a team in a share file opens a link in `requested`. The platform then files an Approvals row **to the destination team** (source `grant`, tool `memory.share.accept`, "Let Engineering share its memory with Support: Release notes"). Its preview names the sending team, the share, its form and filters, never any text. Only the destination team's leads and the workspace's owners and admins can decide it, and **the person who wrote the share never can** (the requester can never decide their own row). Approving moves the link to `accepted` (recording who); denying ends it (`revoked`, ended by the team). The tick asks again for a link whose row was never filed.

The receiving team can later **pause** (nothing arrives until it resumes), **resume**, or **end** the link (`app.memory_share_link_act`; a lead of the receiving team or a workspace owner/admin). A link ended by the team (`by_team`, also a denied accept row) stays ended for that share: naming the team in the file again does not bring it back, nothing is filed for it again and no new accept row is asked for. Only a link the sending file itself dropped (`removed`) starts over as `requested` when the team is named again. To ask a team that ended a link, the sender writes a new share (a new file name); the team has to accept that one. Naming the team a second time while a row is open is the same row.

**Memory sharing** (workspace switch, default on): off stops every send. No run is started or built, a ready digest waits (and is given up on after 14 days), and `app.deliver_inbox_item` refuses. An owner or admin changes it; everyone in the workspace reads it.

## Delivery (P8-24)

When a run becomes `ready` (approved, or `auto`), a delivery job hands the digest to each destination the approver was shown that still has an `accepted` link. The hand-over is the definer function **`app.deliver_inbox_item(run, destination)`**, which checks everything again for every caller:

- the caller is the platform, or a person who manages the **sending** team (anyone else, including a lead of the destination, gets `42501`; a run that does not exist answers the same, so ids cannot be probed);
- the run belongs to an active share of the sending team and is `ready` or `sent`;
- the workspace switch is on, the destination exists, is in the same workspace and is not archived;
- the destination is one of the teams recorded on the run when its digest was built (the ones the approver was shown), whatever the link says now;
- the link is `accepted` right now (`requested`, `paused` and `revoked` deliver nothing).

It writes one inbox item in the **destination's** inbox (origin `share`, named `digests/<sending slug>/<period>`, sender check `pass`, no file attached) and one delivery record. It is **idempotent** per share, destination and content fingerprint: a second call returns the first delivery and writes nothing. `memory.digest.delivered` is announced once. The run becomes `sent` when at least one team received it; `empty` if none can; a failed hand-over leaves it `ready` and the tick tries again.

The digest's words are not copied into the item. The importer reads them from the approved run in the database (checked against its fingerprint), so what the inbox item says can never change what is filed.

## Receiving (P8-25)

The memory inbox passes a delivered digest, and a `.zip`/`.okf` bundle someone dropped, to this plugin's `inbox.importer`. A delivered digest skips the foreign-bundle hold (it is already authenticated by the link) but not the size hold. A bundle dropped from outside is still **held** until a lead releases it, then imported.

The whole bundle is judged first and **refused whole** at the first problem, with a plain sentence on the item and `memory.digest.imported` (outcome `refused`, a reason code). Refused: a path with `..`, `.`, an empty part, a backslash, a control character or an absolute path; a file that is not `.md`; two files that differ only in case; a symbolic link or any special file in a zip; an encrypted zip entry; zip64; more than 2,000 files; more than 8 MB (a digest) or 50 MB (a bundle from outside) unpacked, or a file over 1,000,000 bytes; text that is not UTF-8 or has a NUL; a zip whose inflated size differs from what it declares, or whose local header disagrees with its directory; a root `index.md` with anything but `okf_version: "0.2"`; a concept with invalid frontmatter or a YAML alias; and, for a digest, a missing `digest.md`, `verified`, more than one source, or any link into the sender's `references/`.

What is filed is rewritten: only the keys the receiving side knows are kept (`type`, `title`, `description`, `tags`, `status`, `stale_after`, `sources`, `resource`, `usage_window`, `origin_trust`); `verified`, `generated`, `from`, `origin` and `share` of the sender are dropped; the platform stamps `origin: share` (`import` for an outside bundle), `from: <sending team id>`, `generated.by: process:share`; bundle-absolute links (`/facts/x.md`) are re-pointed into the folder. Afterwards any link, definition or `href`/`src` that leads out of the folder (a relative link that climbs above it, a `/`-absolute one that does not land in it, the same spelled with `%2e%2e` or `\`) loses its target and keeps its text; web addresses and anchors stay. Files go under `memory/shared/team-<sending team slug>/` (every digest folder starts with `team-`, an outside bundle's never does, so a team called `external` or `team-external` can never land in an outside bundle's folder) and an outside bundle under `memory/shared/external/<name>/`, one commit as the system (steps of 190 files for a very large bundle). The bundle's own `index.md` and `log.md` are not filed: the repository writer regenerates the team's. Received concepts are `unverified` here whatever the sender said; the sender's claim is kept as `origin_trust`. The Brain mirror retains them into the bank tagged `from:<team>`.

Before filing, the importer reads the delivery again from the database and refuses (`link_ended`, nothing filed) when the link is no longer `accepted`, the share is no longer `active` (removed or invalid), the receiving team is archived, or Memory sharing is off.

## Routes

| route | who | answer |
|---|---|---|
| `GET /api/teams/:slug/shares` | anyone who can read the team | the shares with destinations, the last run's state, `canManage` |
| `GET /api/teams/:slug/shares/:shareSlug` | same | one share |
| `GET /api/teams/:slug/shares/:shareSlug/preview` | lead or admin | selection only, nothing built or stored: counts, headline ("Matches 12 concepts · 3 left out"), included, left out with reasons, the diff |
| `POST /api/teams/:slug/shares/:shareSlug/run` | lead or admin | `202`, the new run; `409` when a build is already running or the share is invalid |
| `GET /api/teams/:slug/shares/:shareSlug/runs[?limit=]` | lead or admin | the runs, newest first |
| `GET /api/teams/:slug/shares/:shareSlug/runs/:runId` | lead or admin | one run |
| `GET /api/teams/:slug/shares/incoming` | anyone who can read the team | the shares other teams send to this team (sender, share, form, state, last delivery), `canManage` |
| `POST /api/teams/:slug/shares/incoming/:linkId/:action` | lead of this team or workspace owner/admin | `action` is `pause`, `resume` or `revoke`; `409` for a move the state does not allow, `404` for a link that is not this team's |
| `GET /api/workspace/memory-sharing` | anyone in the workspace | `{ enabled, canChange, changedAt }` |
| `PUT /api/workspace/memory-sharing` | workspace owner or admin | `{ enabled }`; `Run now` answers `409` while it is off |

Runs are for managers only because they name what was left out. None of these routes is a credential or session route, so none has an `ABUSE_ROUTES` row; each carries its own inline `rateLimit`.

## Data and permissions

Tables (all with forced row-level security): `memory_shares` (one per file, with the definition, status, schedule and `auto_allowed`), `memory_share_links` (one per destination; keeps the destination's name and slug because people outside a team cannot read it), `memory_share_runs` (one per attempt, with the digest files, the manifest and the lists). Team readers read shares and links; managers read runs, except the `bundle` column, which the request role cannot read at all. Only the system role writes shares and links; a run can be started by a manager as themselves, at the first state, and only the system role changes it afterwards. Definer functions are the only ways to file and settle the Approvals rows and to move a link or write across teams: `app.memory_share_request_approval` and `app.memory_share_settle` (digest), `app.memory_share_request_accept` and `app.memory_share_settle_accept` (system role only), `app.memory_share_link_act` (receiving team's lead), `app.memory_share_incoming`, and `app.deliver_inbox_item`. Migration `0002` adds `memory_sharing_settings` (the switch, one row per workspace; everyone reads, owner/admin writes) and `memory_share_deliveries` (one row per digest handed to one team, unique per share, destination and fingerprint; managers of the sending team read), and `memory_share_links.approval_id`. The memory-inbox plugin's migration `0003` lets an item stage and failed stage be `import`.

## Jobs

`memory-share.build` (builds one run's digest), `memory-share.deliver` (hands a ready digest to each accepting team) and `memory-share.tick` (every minute: starts due scheduled runs, fails a build stuck for 15 minutes, expires unanswered approvals, asks teams that have not been asked to accept, and delivers a ready digest that has not gone). The build and the delivery are keyed by the run, so a run is never worked on twice at once.

## Seed data

Seed v8 (`seedInboxAndShares` in `packages/test-utils/src/seed-inbox.ts`, PLAN P8-27) puts two shares from Engineering to Customer support in a seeded site: `engineering-facts-for-support` (accepted) and `incident-lessons-for-support` (waiting for Customer support's leads), next to the inbox items they relate to. The accepted link is written in the database, because the person who wrote a share can never accept it and Omar is the only lead or admin Customer support has in the seed. The cross-team suite (`pnpm test:memory-cross-team`, `sharing.test.ts`) checks that a delivered digest reaches the accepting team's memory and bank and no other team's.

## Events

`memory.share.linked` (a link moved: accepted, paused, resumed, ended), `memory.sharing.switched` (the workspace switch changed), `memory.digest.delivered` (a digest reached one team's inbox; ids and counts), `memory.digest.imported` (a received bundle was filed or refused whole, with a reason code). Also `memory.share.defined` (a file was loaded, found invalid or removed), `memory.share.built` (a run reached `awaiting_approval`, `ready`, `empty`, `blocked` or `failed`, with counts and the number of concepts withheld by reason) and `memory.share.settled` (an approval turned a run `ready` or `denied`, or it expired). They carry ids, counts and short reason codes only; never a path, a title or any text of a concept. The audit trail's "what was withheld" view (P10-05) reads these counts.

## Not built here

- A baseline per destination (a team that accepts late gets only what changed since the last sent run), a digest summary written by the Archivist, and audit-trail mappers for the new events.
- The run history. The web page (P8-26) is built: Memory → Sharing (the share list, preview, Run now, New share, requests and "Received from"), the digest and request cards in Approvals, and Workspace → Memory sharing. It lists only each share's last digest.
- The Archivist's narrative in `digest.md`: the summary is built by the platform from titles and descriptions only.

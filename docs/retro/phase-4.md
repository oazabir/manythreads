# Phase 4 retro (Files and the team repo)

Sections are written by the task that did the work; the orchestrator adds the gate and the timings at phase exit.

## 1. Reflect and refactor (P4-00)

Answers to PLAN Phase 4 section 0, and what was done before the repo store was written.

- **Channels and files both check channel ACL on blob reads: one capability or two copies?** One rule in SQL (`app.visible_channel_ids`, retro phase 3 section 10). What was missing was the
  SDK door: `ctx.access.readableTeamIds(tx, perm)` and `ctx.access.readableChannelIds(tx, perm)` now wrap the two functions with a typed result, for plugins that need the sets in code
  (the Files tree merges repo paths by team and `channels/<name>/` by channel). Nothing in `files` or `search` hand-wrote that call in TypeScript (their uses are in SQL policies and
  plpgsql, where the function is called directly inside `(SELECT ...)`), so there was no call to swap; the first consumers are the tree API and the repo plugin.
- **Does the composer assume the blob is on `storage-local`?** No, and now `storage-s3` proves it: the same `BlobStorage` contract suite (`@manythreads/test-utils/blob-contract`) runs against
  both providers, and `files-s3.test.ts` runs the real upload, download, 413 and delete routes on MinIO. The interface gained `list` (the GC needs to find blobs no row points at).
  `MANYTHREADS_STORAGE=local|s3` picks which plugin loads; the server registers one `storage` provider.
- **Live push fan-out.** A post to a 2,000-member channel was 2,000 `pg_notify` statements, awaited one after the other. `ctx.realtime.pushToPeople` (same payload) and `pushMany`
  (a payload each) send the whole audience in one statement; channels (posts, edits, deletes, reactions, typing, new channel), DMs and notifications use them. A test counts statements
  for a 2,000-person audience: one.
- **`parseMarkup` was quadratic in claims** (each candidate against every earlier claim, 180 ms for 13,000 mentions). Claims are now checked with sorted-interval sweeps, one linear pass per
  phase; 13,000 mentions parse in under 30 ms, output identical to the old parser on 60,000 random strings (the equivalence check was run once and is not kept).
- **Blob GC and deleted-message files.** Decision: a file whose only messages were deleted is hidden at once (RLS: `orphaned_at`), deleted after 30 days; a daily job (`files.blob-gc`,
  cron through the new `ctx.jobs.register(..., { cron })`, the server now runs the scheduler) deletes expired rows and every unreferenced blob older than 24 h, with a dry-run mode,
  an empty-database guard and one metrics line per run. See `docs/plugins/files.md`.
- **Server shutdown.** `app.close()` waited 72 s (Fastify's keep-alive timeout) when a streamed download finished just after the one-shot idle-connection close. `close()` now sweeps
  idle connections every 100 ms while it waits. It showed up as a "hook timed out" in a test that ended with a download, one run in three.

### Mistakes added to MISTAKES.md

- A `NOTIFY` per person in a loop; a quadratic claim check; a store-agnostic feature (GC) that needed a way to enumerate the store.
- Fastify closes idle connections once at `close()`: a connection that goes idle after that waits the keep-alive timeout.

### Not done, carried on

- The Helm chart does not template the `MANYTHREADS_STORAGE` / `MANYTHREADS_S3_*` variables or `MANYTHREADS_BLOB_GC*` (set them through the chart's extra environment).
- The seed writes its attachment to a local directory: with `MANYTHREADS_STORAGE=s3` the seeded file has a row and no object.
- `.tmp/*.part` leftovers of storage-local are not collected (they are not blobs and are not listed).

## 2. What phase 4 delivered

- **Team repo (P4-01..05, `repo-git`):** a bare git repo per team created by a job on team creation, first commit lays out §5.1 with
  `TEAM.md`. One writer per team (queue + `pg_advisory_xact_lock`, CAS on `baseBlobSha`); a stale write is 409 with current content.
  Text only (NUL anywhere or invalid UTF-8 → 422 `attachment_not_in_repo`), 1 MB per file, per-team quota (413 `repo_quota_exceeded`).
  Guarded paths (`bots/`, `TEAM.md`, `skills/`, `routines/`) refused for bots (broker + writer) and for non-leads ("change by pull request").
  Other plugins use `ctx.providers.get<RepoProvider>('repo')`.
- **Files (P4-06):** one tree over repo entries and `channels/<name>/` attachments with identical rows; team ACL for repo folders,
  channel ACL for attachment folders; `memory/` marked as managed by team memory; repo content route with safe mime and CSP.
- **Pages (P4-07):** `pages.write` (create/replace/append), event `pages.page.written` (PLAN says `page.written`; event types have three
  segments).
- **History (P4-08):** commits per path, unified diff, rendered Markdown diff in the client, restore as a new commit.
- **Viewers and apps (P4-09/10):** Markdown (Tiptap, raw round-trip), CSV (single-cell diff), PDF (pdf.js legacy build), media, code,
  Mermaid in a sandboxed frame, Office card, Google link card; embedded apps in `sandbox="allow-scripts"` with a strict CSP and a
  5-minute HMAC per-open token for sub-resources.
- **Files screen (P4-11):** tree, breadcrumb, list, preview, upload, new, rename, move, delete, History panel, restore confirm, page read
  view, phone breadcrumb sheet. Plates: files 3.3%, history 4.3% (P), page 2.3% (P-loose).
- **Storage (P4-13):** `storage-s3` (MinIO in CI), blob GC (dry-run unless `MANYTHREADS_BLOB_GC=on`, instance marker), seed v4 (repo
  content with history, CSV, Mermaid, app, memory, bots placeholders; PDF/PNG/MP4/docx attachments through the storage provider).
- **Deferred:** P4-12 (optional LibreOffice worker) — Office files show a card with download.

## 3. Security review

`docs/retro/security-phase-4.md`: 1 critical (embedded-app CSP bypass via a percent-encoded path), 4 medium (forged co-author trailers,
no repo quota, unrated read routes, blob GC across deployments), 6 low. All fixed with tests before the gate.

## 4. Gate

Run with no agents active: lint, typecheck, `pnpm test` (2,076), `test:rls` (262), `test:events` (122), `test:schema-compat` (370) green;
`pnpm e2e` 247 passed with two phone W baselines failing — both real regressions from the Files stylesheet (it redefined the shared
`.linkish` and its empty header slot squeezed the phone channel title); fixed in 1cf2c6a.

## 5. Carried into later phases

- Guests (Lena) get 403 on the whole team tree, including their granted channel's files; a guest view of granted folders is open.
- Files with no channel have no upload route; "Open in thread"/Share on attachment rows; Export PDF and Pin on pages.
- Web client has no specific copy for `repo_quota_exceeded`.
- Markdown files over 200 KB open in Raw only.
- A commit made but not recorded (request rolled back) is indexed by the next write without an event.
- Parallel agents exhaust the shared dev Postgres (100 connections): run gates with agents idle; vitest `--maxWorkers=3`.

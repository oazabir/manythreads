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

# files

Attachments of channels: the `files` table, the upload and download routes, and the link from a message to its files (SPEC section 5.2 and principle 8, PLAN P3-08).
Code: `packages/plugins/files`. Schemas: `packages/shared/src/{entities/file,api/files,events/files.file.*}`. The bytes live in the storage provider registered as
`storage` (`storage-local` by default, [storage-s3](./storage-s3.md) with `MANYTHREADS_STORAGE=s3`; see [storage-local.md](./storage-local.md) for the interface); this plugin owns everything about people, channels and names. Phase 4 adds the
team repo and a tree over both stores (below); attachments never go to git.

## Who reads a file

The channel decides, on **every read**: `GET /api/files/:id` and `/content` select the row through row level security, so access is exactly "can read the channel now".

| File | Read by | Written (uploaded) by | Deleted by |
|---|---|---|---|
| in a channel | whoever `app.visible_channel_ids('read')` holds the channel for (members of the team, members of a private channel or DM, a guest with a grant) | whoever holds it in `visible_channel_ids('post')` (a guest with a `read` grant cannot upload; an archived channel takes nothing) | the uploader, or a lead of the channel's team / a workspace admin (`app.channel_can(channel, 'manage')`) |
| of a team (no channel; Files, phase 4) | `app.readable_team_ids('read')` | the team's `post` set | the uploader or a lead |

There is no signed URL, token or cache that outlives the check: the URL carries only the file id, the response says `cache-control: private, no-cache`, and take the grant away
and the next request is **403**. Hidden and missing look the same (403, never 404), as in channels. Criterion 7: Lena without a grant gets 403 on the metadata and the bytes; so does
Sameera of another team.

## Table (`migrations/0001_files.sql`)

`files(id, workspace_id, team_id?, channel_id?, folder_path, name, blob_key, size bigint, mime, sha256, uploader_id, created_at)`, RLS **C** for channel files (the hoisted channel
set, one array probe per statement) and **T** for team files; comment `rls: team`; passes `findRlsViolations`, `explainRlsViolations` and `findPerRowPolicyCalls`.

- `folder_path` is `channels/<name>/` for a channel, `dms/<channel id>/` for a DM or bot conversation. It is written at upload time: a channel renamed later keeps the old path on
  its old files, so the Files tree (phase 4) must follow `channel_id`, not the string.
- Unique `(channel_id, folder_path, name)`: the route renames a second `report.pdf` to `report (2).pdf` (up to 100), so two uploads never collide and nothing is overwritten.
- Indexes: `(channel_id, id DESC)`, `(team_id)`, `(uploader_id)`, GIN trigram `(name)` (used by [search](./search.md)).
- Checks: name is one path segment (no `/`, `\`, control characters, `.` or `..`), folder path ends in `/` and has no `..`, `sha256` is 64 hex digits.
- A `BEFORE INSERT` definer trigger sets `team_id` from the channel and refuses another workspace: a caller names the channel, never the team. `UPDATE` is refused for everyone
  but the system role (a stored file's name, bytes and owner never change). Deleting a channel cascades to its rows (nothing in the product deletes channels; the blobs of such rows
  are collected by the blob GC, see below).

## Routes

| Method and path | What it does |
|---|---|
| `POST /api/channels/:channelId/files` | Upload. The body is **the file itself**, a raw byte stream (any content type, no multipart): `x-file-name` carries the name percent-encoded UTF-8 (or `?name=`), `content-type` the declared type. 201 `FileMeta`. 60 per minute per caller. |
| `GET /api/channels/:channelId/files?before=&limit=` | Newest first, cursor by uuid v7 (`before` is the id of the oldest file held), `limit` 1 to 200. |
| `GET /api/files/:fileId` | Metadata (`FileMeta`: no `blobKey`). |
| `GET /api/files/:fileId/content` | The bytes, streamed from the provider. `?download=1` forces `attachment`. |
| `DELETE /api/files/:fileId` | Removes the row, then the bytes; `files.file.deleted`. A second delete is 403 (the file is gone and so hidden). |

Refusals: 400 (no body, interrupted upload, bad attachment), 401, 403, 409 (archived channel; more than 100 files of one name), 413 (`validation_failed` code, the envelope's code for it), 503 (no storage provider).

### Upload limits and what happens mid-stream

`MANYTHREADS_MAX_UPLOAD_BYTES` (default 52,428,800 = 50 MB, read at each request). A declared `content-length` over the cap is refused before a byte is read. Otherwise the provider
counts as the bytes arrive and rejects at the first byte over the cap (`BlobTooLargeError`): the route answers **413 with the error envelope**, the partial blob is deleted, no row is
written, and the request body is discarded (`resume()`) instead of destroying the socket, so the client can still read the answer. The composer refuses over-cap files first
(criterion 7: 80 MB is refused client side); the server cap is the defence in depth.

Plugin routes get no raw body by default. A route declares `rawBody: true` (SDK `HttpRouteDefinition`): the host mounts it in its own encapsulated Fastify context with a catch-all
content-type parser that hands the request through unparsed (`req.stream`, the socket itself), without the built-in JSON and text parsers consuming it first, and without changing
what any other route does with an unknown content type. The transaction of the route stays open while the bytes arrive (one pooled connection per running upload), so a slow
sender could pin the pool: the route takes an upload slot first (at most `MANYTHREADS_MAX_CONCURRENT_UPLOADS`, default 4, bodies in flight per process and 2 per person, 429
beyond), cuts a body that sends nothing for `MANYTHREADS_UPLOAD_IDLE_MS` (20 s) or takes longer than `MANYTHREADS_UPLOAD_MAX_MS` (10 min), and frees the slot as soon as the
bytes have arrived. A response `body` that is a Node `Readable` is piped as is (downloads); the route gives no `schema.response`.

### Names and types

- **Name**: NFC, the last segment of whatever path the client sent (`..\..\boot.ini` is `boot.ini`, `../../etc/passwd` is `passwd`), control characters, line separators, zero-width
  characters and bidi overrides removed, `<>:"|?*` replaced by `_`, no leading or trailing dots or spaces, at most 255 bytes with the extension kept; nothing left means `file`.
  The blob key never comes from the name (it is 128 random bits chosen by the provider), so a name cannot reach the disk.
- **Type** (`mime`): the first bytes win over the header (PNG, JPEG, GIF, WebP, BMP, AVIF, PDF, ZIP, gzip, MP4, QuickTime, WebM, MP3, Ogg, WAV). Otherwise the declared type when it
  is a well formed `type/subtype` (parameters dropped); an `image/*` that the bytes do not confirm becomes `application/octet-stream`.
- **Download headers**: `content-type` as stored, except the types a browser would run (`text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/xml`, JavaScript, CSS), which
  are sent as `application/octet-stream`; `content-disposition: attachment; filename="<ascii>"; filename*=UTF-8''<pct>` unless the stored type is one of the safe images
  (PNG, JPEG, GIF, WebP, AVIF, BMP), which show `inline`; `x-content-type-options: nosniff`; `content-security-policy: default-src 'none'; sandbox`; `cross-origin-resource-policy: same-origin`.

## Attaching to a message

**Decision: ids in `message.meta.attachments` (a list of `FileId`), not an entity link.** The message carries what it shows, in the order the sender chose, and a read needs one batched
`SELECT` instead of a join through `entity_links`. (The `file` entity type and its resolver exist for other kinds of reference: `[[file]]` chips and links from tasks and pages.)

1. The composer uploads each file (progress, size errors) and gets a `FileMeta` back.
2. It posts the message with `attachments: [fileId, ...]` (`PostMessageRequest`, at most 10). The channels route checks that every id is a file **of this channel uploaded by the sender**
   (400 otherwise: not someone else's file, not another channel's, no duplicates) and stores `{ attachments: [...] }` in `meta`.
3. Every read of a message (`ChannelMessage`: list, one message, the live push) resolves the ids to `attachments: FileSummary[]` (`id, name, size, mime`) for what the caller can read:
   a deleted file, or one in a channel they cannot see, is left out. Download is always `GET /api/files/:id/content`: the card holds no URL with authority.

`ChannelMessage.attachments` is optional in the schema (an older client or fixture still parses) and always sent by the server. A message still needs a body of at least one
character; a composer that sends only files can use the file names as the text. Deleting a message **hides** the files only that message listed, then deletes them after 30 days (next section). The channels plugin
reads `app.files` only when a message has attachments, so it still runs without this plugin.

## Files of deleted messages (migration 0002)

**Decision: a file whose only references are deleted messages is hidden at once and deleted after 30 days.** Not "keep" (a deleted message's attachment readable by the whole channel
for ever contradicts why it was deleted) and not "delete with the message" (a lead deleting the wrong message would lose the bytes with no way back; the 30 days are the way back).

- **Hidden at once, for everyone but the system role.** A definer trigger on `app.messages` (the files plugin depends on channels) stamps `files.orphaned_at` when a message is deleted
  and no live message of the channel still lists the file (`meta.attachments` probe, GIN index `messages_attachments`). The `files_select` policy shows a row only while `orphaned_at IS NULL`,
  so the download route, the channel's file list, message cards, file search, links and the uploader's own delete all stop seeing it (403, as for any hidden file). A file that another live
  message still lists stays visible until the last of them is deleted. A file never attached to a message is the channel's file and is not touched.
- **Deleted after `MANYTHREADS_FILES_ORPHAN_DAYS` (default 30)** by the blob GC below: first the row, then, in the same sweep, the bytes (nothing references them any more).
- **Undo within the window** (an operator, as the system role): `UPDATE app.files SET orphaned_at = NULL WHERE id = ...`. Nobody else can stamp or clear the mark: the app role has no
  `UPDATE` privilege and cannot call `app.files_mark_orphaned`; `files_no_update` still refuses every change except that one stamp.
- Messages deleted before the migration were backfilled at migration time (their 30 days start then). A deleted message's `meta` keeps its attachment ids (the mapper hides them from readers), which is what the trigger and the GC read.

## Blob garbage collection (`files.blob-gc`)

A blob is garbage when **no `files` row has its key**. Rows go away through the delete route (which removes the bytes itself), through the 30-day purge above, through a channel or
team cascade, and by an upload that stored its bytes and then failed to commit its row. The job `files.blob-gc` (a `ctx.jobs.register` queue with `cron: '17 3 * * *'`: **daily at 03:17 UTC**, stored by the server at start,
one run however many replicas) cleans all of them up:

1. A sweep's first run deletes `files` rows whose `orphaned_at` is older than the orphan period (30 days).
2. It pages through `storage.list` (1,000 per page, ascending by key), asks `SELECT blob_key FROM app.files WHERE blob_key = ANY(page)` (index `files_blob_key`), and deletes every
   blob that no row references **and is older than the grace period** (24 h): the bytes of an upload exist in the store before its row does, so a young blob may be an upload in flight.
3. A run looks at up to 200,000 blobs, then enqueues a follow-up job with a cursor (the last key) and stops, so no transaction runs for hours.

| Setting | Default | |
|---|---|---|
| `MANYTHREADS_BLOB_GC` | `dry-run` | `dry-run` (everything except the deletions: counts and bytes are reported as "would delete"), `on`, `off`. Only the word `on` deletes: unset, empty or anything else means `dry-run`, so a deployment opts in and a typo never deletes. A job payload `{ "dryRun": true }` also forces a dry run once. Helm: `server.blobGc.mode`, shipped as `dry-run`. |
| `MANYTHREADS_BLOB_GC_GRACE_HOURS` | `24` | Minimum 1. |
| `MANYTHREADS_FILES_ORPHAN_DAYS` | `30` | Minimum 1. |
| `MANYTHREADS_BLOB_GC_ALLOW_EMPTY` | unset | `1` lifts the empty-database guard below. |
| `MANYTHREADS_BLOB_GC_ADOPT_MARKER` | unset | `1` adopts the store's instance marker for a database that has none (see "Instance marker"). |

**Guard.** If the database holds no `files` row at all but the store holds old unreferenced blobs, the run deletes nothing and logs a warning: the server is probably pointed at the wrong
database (every blob would look like garbage). A deployment that really deleted its last file sets `MANYTHREADS_BLOB_GC_ALLOW_EMPTY=1` once.

**Instance marker (a bucket, prefix or directory belongs to ONE database).** "No row names this blob" is only garbage when the store is this database's alone: two deployments that share a
bucket and prefix, or a staging database restored from production, would each delete the other's blobs after the grace period. So before the first deletion of a run the GC compares two ids:
one in the table `app.blob_gc_instance` and one in the store (S3: the object `<prefix>.instance`; local: `<dir>/.instance`; neither is ever listed as a blob). On a fresh pair the first deleting
run writes both (the store's write is create-only). It deletes only while they are equal; it refuses (`refused` in the metrics line, a warning) when the store's marker is another id, when the
database has none but the store has one (use `MANYTHREADS_BLOB_GC_ADOPT_MARKER=1` once to adopt it, for a database restored from a backup that predates the marker), or when the provider
cannot keep a marker. Give every deployment its own bucket or prefix (`MANYTHREADS_S3_PREFIX`); a database copied for another deployment keeps the copied id, so point the copy at its own store
and clear the id (`DELETE FROM app.blob_gc_instance` as the system role) before turning the GC on. A listing entry without a modified time counts as "now", so it is never old enough to delete.
The shipped default is `dry-run`: read the metrics line first, then set `on`.

**Metrics** are one line per run in the server log (`job.log`, level info; warn when something failed or the guard refused): `files.blob-gc {"provider":"local","graceHours":24,"dryRun":false,"purgedFiles":3,"scanned":12044,
"referenced":12031,"withinGrace":4,"orphans":9,"deleted":9,"bytes":1843022,"failed":0,"refused":null,"next":null,"ms":812}`. A failed deletion is counted and retried by the next sweep. To try it on
production data first: set `MANYTHREADS_BLOB_GC=dry-run`, read the line, then `on`. To run it now: `SELECT app.enqueue_job('files.blob-gc', '{}', NULL, NULL)` as the system role.

The GC knows only the `files` table. A plugin that stores blob keys elsewhere (none does: pages and the repo are git, attachments never go to git) must add its table to the reference
check before it ships, or its blobs would be collected. `.tmp/*.part` files of crashed uploads (storage-local) are not blobs and are not listed; delete `.part` files older than a few
minutes by hand or with a cron job.

## The Files tree (`src/tree.ts`, PLAN P4-06)

`GET /api/teams/:slug/files/tree?path=&limit=` (`GetFilesTreeResponse`: `{ path, folder, entries, truncated }`) is **one listing over two stores** with **one row shape** (`FilesTreeEntry`): `kind` (file | folder), `path`, `name`, `size`,
`mime`, `updatedAt`, `updatedBy`, `source` (`repo` | `attachment`), `readOnly`, `readOnlyReason`, `managedBy`, and the ids that apply (`fileId`, `channelId`, `blobSha`), plus `contentUrl`, a URL that serves the bytes
(`/api/files/:id/content` or `/api/teams/:slug/repo/content?path=`), so an `<img src>` works for both. Folders first, then names (byte order); `limit` (default 500, at most 2,000) cuts the list and says `truncated`.
`folder` says what is true of the folder being listed (the breadcrumb's last step).

| Path | Rows come from | Access |
|---|---|---|
| `` (root) | the repo's root through the `repo` provider (`list`), plus a `channels` folder | team membership (the team row through RLS) |
| a repo folder (`pages`, `memory/facts`, ...) | the provider (the `repo_entries` index with the last commit of each file) | team membership; a missing folder, or a file asked as a folder, is 404 |
| `channels` | one folder per channel of the team the caller can read, with its newest upload | the channels RLS shows (`app.channels`); `can_post` from `app.visible_channel_ids('post')` decides `readOnly` of the folder |
| `channels/<name>` | the channel's `files` rows, `path = channels/<current name>/<file name>` (the tree follows `channel_id`, not the stored `folder_path`) | the channel's ACL **on every read**: a private channel, a guest without a grant and a name that does not exist are all **403**, indistinguishable |
| `channels/<name>/x` | none: attachment folders are flat | 404 |

- **Criterion 6**: Lena (guest, in no team) is 403 on `#dev` attachments and on the team's tree (the team is not hers to read); Nadia is 403 on Marketing's tree; a team member sees `channels/` without the private channels she is not in.
- **Read-only** (`readOnly` + `readOnlyReason`): `change_by_pull_request` for `bots/`, `skills/`, `routines/` and `TEAM.md` for a member who is not a lead or admin (a direct write is 403; criterion 9: Priya), `attachment` for every attachment row and the
  `channels` folder (an upload never changes in place), `no_write_access` for a reader who cannot post (also the channel folders). `managedBy: 'team_memory'` marks `memory/` and everything below it (the journal is written by
  the team's memory; facts stay editable, so it is a note, not `readOnly`).
- Files of a team that belong to no channel (`files.channel_id IS NULL`) have no upload route yet and are not listed.
- The repo part is optional: without a `repo` provider the root lists `channels` alone and any repo folder is 503. `channels/` in the repo is refused by the writer, so the two never collide. A channel renamed after an upload keeps
  the old `folder_path`; two files of one name under the old and the new folder would show as the same path (distinct `fileId`s): rare, not handled.

## Entity link

`ctx.links.registerResolver('file', ...)`: title is the name, subtitle `#channel · 2.1 MB`, href `/t/<team>/c/<name>?panel=file:<id>` (null for a DM). It runs as the caller, so a file in a
channel they cannot read resolves to nothing.

## Events

`files.file.uploaded` (`channelId, teamId, fileId, uploaderId, name, size, mime`) and `files.file.deleted` (`channelId, teamId, fileId, deletedBy`), schema version 1, as the acting
person, in the transaction of the change; a refused request emits nothing.

## Manifest

| Field | Value |
|---|---|
| name / version / kind | `files` / `0.1.0` / `server` |
| extends | `event.emit`, `job.register` (the blob GC queue) |
| dependsOn | `channels` (tables and `visible_channel_ids`; loaded and migrated after it) |
| events | emits `files.file.uploaded`, `files.file.deleted` |
| job | `files.blob-gc`, cron `17 3 * * *` |
| provider used | `ctx.providers.get('storage')`, looked up per request (and per GC run) |

## Not here

Rename and move, team files without a channel (the `files.team_id`-only rows have no upload route yet). Virus scanning and thumbnails. A cleanup of `.tmp/*.part` files of crashed uploads (see storage-local). Range requests for video seeking. Quotas per person or team.

## Tests

`test/files-api.test.ts` (upload and download, 413 mid-stream and by `content-length`, ACL for Sameera, Lena (grant, read-only, revoke), a private channel, a DM, archived, traversal and
control characters in names, delete, attachments on messages), `test/rls/files-rls.test.ts` (`pnpm test:rls`: visibility per persona equals the channel set, writes, triggers, checks),
`test/gc.test.ts` (hidden deleted-message files, the GC: grace, dry run, cascades, purge after 30 days, paging, the empty-database guard, the job through the worker and its log line), `test/events/files-events.test.ts` (`pnpm test:events`), `test/files-tree.test.ts` (the merged tree, rows, read-only reasons, ACL per folder), `e2e/api/files/attach-acl.spec.ts` (`pnpm e2e --project=api`, including a real 51 MB upload), `e2e/api/files/tree.spec.ts`.

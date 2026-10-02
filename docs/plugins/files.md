# files

Attachments of channels: the `files` table, the upload and download routes, and the link from a message to its files (SPEC section 5.2 and principle 8, PLAN P3-08).
Code: `packages/plugins/files`. Schemas: `packages/shared/src/{entities/file,api/files,events/files.file.*}`. The bytes live in the storage provider registered as
`storage` (`storage-local` by default, see [storage-local.md](./storage-local.md)); this plugin owns everything about people, channels and names. Phase 4 adds the
team repo and a tree over both stores; attachments never go to git.

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
  stay until a cleanup job exists, see "Not here").

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
what any other route does with an unknown content type. The transaction of the route stays open while the bytes arrive (one pooled connection per running upload), which the
rate limit keeps modest. A response `body` that is a Node `Readable` is piped as is (downloads); the route gives no `schema.response`.

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
character; a composer that sends only files can use the file names as the text. Deleting a message does not delete its files (they stay in the channel's Files). The channels plugin
reads `app.files` only when a message has attachments, so it still runs without this plugin.

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
| dependsOn | `channels` (tables and `visible_channel_ids`; loaded and migrated after it) |
| events | emits `files.file.uploaded`, `files.file.deleted` |
| provider used | `ctx.providers.get('storage')`, looked up per request |

## Not here

Folder tree, viewers, rename and move, team files and the repo (phase 4). Virus scanning and thumbnails. A cleanup job for blobs whose row went away with a channel, and for `.tmp/*.part`
files of crashed uploads (see storage-local). Range requests for video seeking. Quotas per person or team.

## Tests

`test/files-api.test.ts` (upload and download, 413 mid-stream and by `content-length`, ACL for Sameera, Lena (grant, read-only, revoke), a private channel, a DM, archived, traversal and
control characters in names, delete, attachments on messages), `test/rls/files-rls.test.ts` (`pnpm test:rls`: visibility per persona equals the channel set, writes, triggers, checks),
`test/events/files-events.test.ts` (`pnpm test:events`), `e2e/api/files/attach-acl.spec.ts` (`pnpm e2e --project=api`, including a real 51 MB upload).

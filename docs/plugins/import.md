# import

import brings the history of another chat product into a team: you upload the export file that Slack or Mattermost gives you, read a report of what would happen (a **dry run**, which writes nothing), and then start the import. It runs in
the background and ends with a plain report. The channels, messages, threads and reactions arrive with the times they were written, as if they had always been here. Only workspace owners and admins can use it. PLAN P14-13.

Words used on this page. An **archive** is the export file. A **placeholder** is a stand-in for a person who is in the archive but has no account here yet. A **dry run** is a read of the archive that only counts. **Idempotent** means that doing the same import twice leaves
the same result as doing it once.

Not in scope yet: copying the bytes of attached files (see "What is left out"), Mattermost attachments, importing custom emoji, user groups, pinned messages, edits history, or any other product (Teams, Discord).

## The steps an admin takes

Settings, Import (`/settings/workspace/import`).

1. **Upload.** Choose where it is from (Slack or Mattermost), the team the channels go into, and the file. The file is sent as a raw stream (`POST /api/admin/imports?source=slack&team=engineering`), never held in memory, and stored with the storage provider as it arrives.
   The server reads the first bytes: a Slack export must be a zip; a Mattermost export a zip or a JSON-lines file. Anything else is refused at once with a plain sentence. The name and the type the browser sent are never believed.
2. **Dry run** (`POST /api/admin/imports/:id/dry-run`). A background job reads the stored archive and writes the report onto the run: people matched, channels, messages, threads, reactions, files, and each kind of thing it would leave out. It writes no message,
   no channel, no person and no map row. The admin can run it again.
3. **Start** (`POST /api/admin/imports/:id/start`). Refused until a dry run has finished. Only one import runs at a time in a workspace. The job writes the import in batches of 100 messages, each in its own transaction, and updates the run's progress.
4. **Report.** When it ends (`done`, `failed` or `cancelled`) the run keeps a final report with the same shape as the dry run, now saying what happened. The stored archive is deleted when a run ends; an archive nobody started is deleted after 7 days (the run and its report stay).
5. **Cancel** (`POST /api/admin/imports/:id/cancel`) asks a queued or running import to stop after the batch it is on. What it already wrote stays.

A run moves through `uploaded`, `analysing`, `analysed`, `queued`, `running` and ends in `done`, `failed` or `cancelled`.

## Who becomes whom

- **Matched by email.** A person in the archive is matched to a person here only by a **verified** email address (`person_emails.verified_at` is set). An address someone typed but never confirmed proves nothing, so it never matches. The match is exact, in lower case.
- **Placeholders.** Everyone else gets a placeholder: an `actors` row of kind `system` with a row in `app.import_people` (name, email, source id). Their messages are written under it and are shown as "Name (imported)" (the `app.message_authors` function names it). A placeholder cannot sign in and is not a member of any team or channel.
- **Claiming.** When an email address becomes verified for a person here, or a person who already has a verified address first gets an account, and an unclaimed placeholder has that address, all of the placeholder's messages and reactions become that person's in the same transaction (database triggers on `person_emails` and `actors` call
  `app.import_claim_for_person`). Their reaction to a message they already reacted to stays one reaction. One `import.person.claimed` event per placeholder says how many messages moved. A person with no email in the archive (a deleted user) can never be claimed.
- **Claimed during a long run.** A run can take hours and decides who writes what when it starts. If someone's address becomes verified while it is going, the run notices at the next batch (100 messages) and writes the rest as that person; whatever was written as the placeholder in between is handed over when the run ends (`app.import_move_claimed`), so nothing stays under a placeholder that has an owner. A reaction the person already had stays one reaction.
- **Bots and apps** in the archive are not people: their messages are left out and counted ("app messages"). This holds for Mattermost too: a user marked as a bot is skipped like a Slack app.

## What is written, and where

- **Public channels** are made in the chosen team through the channels plugin (`MessageProvider.importChannel`), with the name made into a valid channel name ("Dev Ops!" becomes `dev-ops`); if the name is taken the new one gets `-2`, `-3`. A name with no Latin letter or digit (Arabic, Chinese) cannot become a channel name, so the archive's short name is used instead (Mattermost `name`, the Slack channel id in lower case).
- **A private channel** is made only with its members: the people the archive lists for it who are matched, active, not guests and on the chosen team. If nobody qualifies the channel is left out. Nobody is added who was not in the archive's list, and no admin is added.
- **A direct conversation** is written only into the DM of the same people, made with `app.dms_get_or_create` (the door that makes every DM). It needs **every** person of the conversation to be matched; otherwise the whole conversation is left out ("direct conversation not matched"). Because it
  is the people's own DM, no admin reads it: it is visible to its members only, like any DM.
- **Messages** go through `MessageProvider.post(..., { imported })`, one at a time, as their author. They keep the time they were written (`created_at`), sort in the order they were written, and carry `meta.importedFrom = { source, id }`. Threads are rebuilt from the archive's thread ids; a reply
  whose first message is not in the archive is written as a top-level message and counted ("reply without its first message"). Reactions are written with the message. Text is made safe: control characters removed, a message longer than 40,000 characters cut (and counted).
- **Nothing is announced.** An imported message raises no `channel.message.posted` event, no push, no unread mark, no notification and no link-preview job. Mentions in the archive become plain text (`@nadia`, `@channel`); nobody is notified. A `<url|label>` link becomes `[label](url)` for http, https and mailto only.
- Every channel, message and person is recorded in `app.import_map` / `app.import_people` by the id the archive uses.
- **Keys are scoped.** A Slack id is unique in a Slack workspace, but a Mattermost name or username is not unique across servers. Mattermost keys therefore start with a short fingerprint of the export (the first 12 hex characters of a hash of the export's version and its first team's name and display name), so two servers' `general` or `alicia` are never one channel or one person. The map is also **team-aware**: the key of a channel and of its messages is prefixed with the chosen team, so the same archive imported into another team makes new channels instead of silently finding the first team's. The same archive into the same team stays a no-op. Direct conversations are the people's own DM and do not depend on the team. Limit: two Mattermost servers with the same version and the same first team name and display name look like one server.

## Doing it twice, and stopping halfway

The import is keyed by the archive's own ids. A second run over the same archive, or over a longer archive that contains the first one's messages, finds each message in `app.import_map` (joined to the message itself, so a message that is gone from the database is written again) and skips it, counting it as "already imported". A thread
reply whose first message came from an earlier run is attached to it. A job that is cut off (a crash, a deploy) is tried again up to 3 times, starting from the top and skipping what is written (placeholders already made are found again, not made twice); after that the run is `failed` with a plain sentence, the stored archive is dropped, and uploading the same archive again carries on where it stopped.

**Cancel and runs that nothing works on.** Cancel on a run that is only waiting (`queued`) or being read (`analysing`) ends it at once from the request (`cancelled`, stored archive dropped); a job that is still alive finds the status changed and stops before it writes a placeholder or a channel. Cancel on a `running` import asks it to stop after the batch it is on. If a server dies in the middle of a run, the sweep job (`import.sweep`, every 10 minutes) ends any run that is `analysing`, `queued` or `running`, has not been touched for 30 minutes and has no job waiting or running for it: it becomes `failed` with a plain sentence and its archive is dropped. What it had already written stays. After that the run can be deleted and another import started.

## What is left out, and said so

The report lists, with counts, everything it did not import: app and bot messages, huddles, canvases, system messages (joins, topic changes), empty messages, channels without members, direct conversations whose people are not all matched, private channels that do not list their members, entries of the archive that were refused
or could not be read, lines that were too long, replies without their first message, files that are named but whose bytes are not in the archive, messages that were shortened, and reactions by people not in the archive.

**Files.** A Slack export holds only the *address* of an attached file, not its bytes, and the server never fetches an address from an archive. A message with a file keeps a line `(file: name)`. Copying the bytes of files that are in an archive (a Mattermost zip with its `data` folder) through the files plugin is
not done yet.

## Hostile archives

An archive is data from outside; nothing in it is ever run, and nothing is extracted to disk. The reader is a small zip reader of its own (`src/zip.ts`) that reads the central directory and streams entries; each rule has a test (`test/zip.test.ts`, `test/reader.test.ts`, `test/import-api.test.ts`). A Mattermost export that lists more than 200,000 people, 100,000 channels or 2,000,000 channel memberships is refused with a plain sentence. An upload that is refused (not an admin, unknown or archived team, too large, another upload running) reads at most 1 MiB of the body, is answered, and the connection is then closed, so a refused client cannot keep the server reading.

| attack | what happens |
|---|---|
| zip bomb (a tiny file that inflates to gigabytes) | an entry of 1 MiB or more that claims to inflate more than 200 times its stored size is refused unread; a lie about the size is caught while inflating (the stream is stopped at the declared size); one entry is at most 64 MiB (4 GiB for a Mattermost JSON-lines file) and the archive 8 GiB in all |
| 2 GB claims | an upload that *declares* more than the limit (`MANYTHREADS_IMPORT_MAX_BYTES`, default 1 GiB) is refused with 413 before its body is read; one that does not declare is cut when it passes the limit; the stored copy is removed |
| path traversal | a name with `..`, a leading `/`, a drive letter, a backslash, `//`, `.` parts, a control character or NUL, or nested more than 32 deep or longer than 512 characters, is refused. Names are only ever looked up in the archive's own table, never joined to a path on disk |
| symbolic links, devices, pipes | refused by the file mode in the directory |
| encrypted, unknown compression | refused |
| duplicate names, overlapping data, a local header that disagrees with the directory | all copies of a duplicate are refused; overlapping or disagreeing entries are refused |
| too many entries, a directory that lies about the entry count, zip64 tricks, multi-disk archives, an end-of-directory signature hidden in the comment | refused or read correctly (the end record must end exactly at the end of the file) |
| JSON | each element of a day file is parsed alone, so one broken element costs that element; nesting deeper than 64 is refused before parsing, with no recursion; the scan is one pass |
| 40,000-character lines, 1 MB messages, huge lines | a JSON-lines line over 4 MiB is discarded as it arrives, never held in memory; a long message is cut to 40,000 characters |
| wrong encodings | text must be UTF-8 (with or without a byte order mark) or UTF-16 with one; anything else is refused instead of guessed at; lone surrogates are replaced |
| URLs in the archive | never fetched; only written as links when http, https or mailto |
| a message dated in the future | its time is put back to now |

The reading happens from a private temporary copy of the stored archive whose sha256 is checked against the upload; the copy is removed when the job ends.

## Data

Migrations `0001_import.sql` and `0002_import_claim_later.sql` (the move of what a placeholder still owns, used by the claim function and by the end of a run, and the right to stamp `finished_at` when a request ends a run). Three tables, all with forced row level security:

| table | what | who |
|---|---|---|
| `import_runs` | one row per uploaded archive: source, team, status, the stored blob key, the dry-run and final reports, progress, a plain error | workspace owners and admins read, insert (as themselves) and change the state columns; the reports and the checksum are written by the job |
| `import_people` | the placeholders | admins read; the job and the claim function write |
| `import_map` | which channel, direct conversation or message each archive id became | the job only |

Functions (owned by the system role): `app.import_act_as(actor)` (the job writes each message as its author; refused for a bot, a webhook or anyone but a person or a placeholder of this plugin), `app.import_claim_for_person(person)`, the two trigger functions, and a replacement of `app.message_authors` that names placeholders.

The blob garbage collector of the [files](./files.md) plugin treats `import_runs.blob_key` as referenced.

## Events and the audit log

Emitted: `import.run.uploaded`, `import.run.analysed`, `import.run.started`, `import.run.finished`, and `import.person.claimed` (written by the claim function). They carry ids and counts, never a name, an email address, a file name or text. The [audit](./audit.md) plugin shows them as `import.uploaded`, `import.analysed`, `import.started`, `import.finished` and `import.person_claimed`.

## Test data

`packages/plugins/import/test/fixtures/` holds a Slack export (`slack-export.zip`: 3 channels with 200 messages, threads, reactions, a file, two direct conversations, an app, a huddle, a canvas) and a Mattermost export (`mattermost-export.jsonl`), made by `test/fixtures.ts`; regenerate with
`pnpm exec tsx packages/plugins/import/test/generate-fixtures.ts`. A test fails if the committed files differ from the generator. Their people are the seed workspace's own, so the fixtures can be uploaded to a freshly seeded server.

## Manifest

| Field | Value |
|---|---|
| name / kind | `import` / `server` |
| dependsOn | `channels`, `direct-messages`, `teams`, `webhooks` |
| extends | `event.emit`, `job.register` |
| jobs | `import.analyse`, `import.run` (detached, one per workspace at a time), `import.purge` (daily), `import.sweep` (every 10 minutes) |
| routes | `POST/GET /api/admin/imports`, `GET/DELETE /api/admin/imports/:runId`, `POST .../dry-run`, `.../start`, `.../cancel`; all admin only |
| setting | `MANYTHREADS_IMPORT_MAX_BYTES` (largest upload in bytes, default 1073741824) |

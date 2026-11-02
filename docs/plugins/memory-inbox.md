# memory-inbox

A team's inbox for its memory. Anyone on a team drops a file, a note or a chat message into it; the platform checks what may come in, reads the file into plain text, lets the team's Archivist (a bot that looks after memory) turn the text into memory concepts when there is one, checks what comes back, and files the result in the team's memory with a **Reference**: a concept that carries the full text and says where the original is. The person who dropped it is told when it is filed, held or could not be read. Without an Archivist the inbox still works: it files the Reference alone, so nothing a person drops is lost.

Package: `packages/plugins/memory-inbox` (PLAN P8-14 to P8-17; SPEC §12.2). Manifest: depends on `teams`, `channels`, `bots`, `files`, `memory` and `repo-git`; `extends: ['event.emit', 'job.register', 'hook.pre_egress']`; emits `memory.item.dropped`, `memory.item.filed`, `memory.item.held`, `memory.item.failed`, `memory.item.released` and `memory.item.discarded`; registers the capabilities `inbox.read` and `inbox.drop`. Schemas: `packages/shared/src/entities/inbox.ts`, `packages/shared/src/api/inbox`, `packages/shared/src/events/memory.item.*.ts`. Migration: `migrations/0001_memory_inbox.sql` in the plugin's own folder.

## The doors

| door | how | state |
|---|---|---|
| Drop a file | `POST /api/teams/:slug/inbox/items?name=<file name>[&teamOnly=true]`, the body is the file (also `x-file-name`) | built |
| New note | `POST /api/teams/:slug/inbox/notes` `{ title?, text, teamOnly }`; a text that is only a web address is filed as a **link** and the page is never fetched | built |
| Send to memory | `POST /api/channels/:channelId/messages/:messageId/send-to-memory` `{ confirmPrivate, teamOnly, thread }`: one message, or the whole thread (up to 200 messages), with who said it and when. The caller must be able to read the channel; a private channel needs `confirmPrivate: true` (the answer says everyone on the team will see it); a direct message or a bot conversation is refused | built |
| A bot drops text | the capability `inbox.drop` (for the bot's **own** team only) | built |
| Drag onto the Files tree's `inbox/` folder | | not built (Files has no `inbox/` folder yet; `inbox/` is storage, not a repo folder) |
| Email to the team's address | | not built (P8-19). The item already has `sender` and `sender_check`; the door sets `sender_check: pass` for a verified member and `fail` for a failed check |
| The web pages (drop zone, board, Send to memory button) | | not built (P8-20, P8-21) |

Every door creates the same thing: an item. Who may drop: a person of the team (a lead, a member; **not** a guest, and not a person of another team) or a bot of the team. The routes read the team through the caller's own access, so a person who cannot see a team gets a plain refusal, not a hint that it exists.

### Limits of a drop

A file is streamed straight to blob storage; it is never held in memory. Environment (read each time a drop arrives, so a change needs no restart):

| setting | default | meaning |
|---|---|---|
| `MANYTHREADS_INBOX_MAX_BYTES` | 25 MB | the server's cap on one drop. The team's own `maxBytes` (below) may only lower it for holding purposes |
| `MANYTHREADS_INBOX_DROPS_PER_MINUTE` | 20 | per person (or bot), kept in the server's memory, not the database |
| `MANYTHREADS_UPLOAD_IDLE_MS` | 20 seconds | a sender that sends nothing for this long is cut off and nothing is kept |
| `MANYTHREADS_UPLOAD_MAX_MS` | 600 seconds | the whole upload must finish by then |

A declared length over the cap is refused (413) before a byte is read; an undeclared one is cut at the cap. A person may have two uploads running at once (a third gets 429). An unknown kind of file is 415 with a sentence; an empty file is 400. The same bytes dropped again (same sha256, same team) create a `duplicate` item that points at the first and queue no work.

## The pipeline

One item moves through steps, each a job; each checks that the item is where it expects before it acts and again before it writes, so a job that runs twice, late, or after a lead discarded the item, does nothing the second time.

1. **Receive.** The bytes are stored, a row is written (`memory_inbox_items`), `memory.item.dropped` is emitted.
2. **Hold check** (rules below). A held item is stored and never read by a model.
3. **Extract.** The file becomes text in a bounded worker thread (see "What can be read"). The text then goes past the workspace's data-loss guard (destination `memory_inbox`): a block fails the item; a hold or "needs approval" holds it (reason `dlp`) unless the team reviews nothing, in which case the guard's redacted text is used. The text is the platform's working copy in `memory_inbox_extracts`; a person never reads that table.
4. **Distil.** The team's Archivist reads the text and proposes concepts (see "The Archivist seam"). Without one, nothing is proposed.
5. **Validate.** What was proposed is checked (rules below); the platform adds `sources`, `generated` (who made it) and `origin: drop` itself.
6. **Commit.** One commit to the team repo, authored by the system, with the person who dropped it as co-author: the Reference, and every accepted concept. State `filed`.
7. **Notify.** The dropper's open pages are told the item changed (a live push; `inbox.item.changed`). There is no stored notification yet (the notification table is channel-bound).

Two items of one team are worked on at the same time at most; a third waits ten seconds and looks again. A cron sweep (every minute) puts back a step that has been running for 30 minutes, stops an item that has tried five times ("This took too many tries"), and asks again for a queued item whose job was lost. At most 500 items per team can be waiting.

### Item states

`queued` (waiting for a step) · `extracting` and `filing` (a step is running) · `filed` · `held` (waiting for a lead) · `needs_review` (the Archivist's answer could not be used; a lead looks) · `failed` (with a plain reason; a lead may retry) · `duplicate` · `discarded`. `reason` is always a sentence a person can read; the log and the events carry codes only.

### Hold rules

Checked in this order; the first that applies holds the item. A lead or workspace admin **releases** it (the check is then skipped) or **discards** it.

| code | when |
|---|---|
| `foreign_bundle` | the file looks like a memory bundle from elsewhere (a `.zip`). Importing a bundle is not built, so it is held whatever the team says |
| `oversize` | the item is larger than the team's `maxBytes` |
| `failed_sender_check` | an email whose sender check failed |
| `unknown_sender` | an email from a sender that is not a verified member and not in `allowEmailFrom`, unless the team's review is `none` |
| `review_all` | the team's review is `all` (also what an unreadable setting means) |
| `dlp` | after extraction, the data-loss guard asked for a hold |

### The team's settings

In `TEAM.md`'s front matter, under `memory.inbox`. Every key is optional:

```yaml
memory:
  inbox:
    review: external          # external (default) | all | none
    keepOriginals: forever    # forever | a number of days
    allowEmailFrom: [partner@example.com, "@kahf.example"]
    maxBytes: 10485760        # lowers the server's cap for this team; never raises it
```

A settings block the platform cannot understand (a mistyped value, the wrong shape, a `TEAM.md` it cannot read) is read as the **strictest** answer, `review: all`, never as "no settings". `keepOriginals: N` removes the original `N` days after filing (a daily job); the Reference keeps the text and gets a line saying the original was removed.

### What can be read

The extractor now lives in the SDK (`packages/sdk/src/extract`, shared with knowledge bases): Markdown, text, CSV, PDF, web page, plus the formats added for the inbox. Word (`docx`), PowerPoint (`pptx`) and Excel (`xlsx`) are read from their zipped XML directly (no office suite): the zip reader refuses encrypted files, more than 10,000 entries, a compression ratio over 400 to 1, and an entry whose real size differs from the declared one. An email (`eml`) is read for its headers (from, to, date, subject), its text and HTML body, its forwarded messages, and each attachment becomes an item of its own (up to 20, same dropper, `parentId` set, held and checked on their own); inline pictures are skipped. A web-address note (`link`) is filed as a link and not fetched.

Not built: pictures (need the vision model), audio and video (need transcription) and scanned PDFs (need OCR). They are accepted, kept, and fail with a sentence that says so ("Pictures cannot be read yet ..."); a lead can retry them when a reader exists.

### Validating what the Archivist proposes

A proposal is a concept `{ path, type, title?, description?, tags?, body?, ... }`. At most 20 are used. Each is left out, with a reason on the item, if: the path is not a `.md` concept under `memory/`; it contains `..` or an empty part; it is under `memory/shared/` (other teams' shares) or `memory/references/` (the platform's); it has no `type`; the data-loss guard blocks its body (a "redact" answer is applied instead); it does not parse as a concept; or it is larger than 900,000 bytes. A proposal never overwrites: a path that exists gets this item's eight-character tail added, and a second clash is left out. A drop marked **team only** is stamped `share: never`, so no digest or share carries it. Relative links become bundle-absolute. If nothing the Archivist proposed can be filed, the item is `needs_review` and a lead looks; releasing it files the Reference alone.

The Reference lives at `memory/references/<slug>-<last 8 hex of the item id>.md`: fixed from the item's id, so the Archivist can link to it before it exists. Its `resource` points at the original's place, `inbox/filed/<yyyy-mm>/<tail>-<name>`. Today the original stays in blob storage and that path is a name, not a Files folder.

## The Archivist seam

The one step that needs a model is "distil", and the Archivist is another task (P8-18). The inbox defines the seam in `packages/sdk/src/inbox.ts`: a plugin registers a provider of kind `inbox.distiller` with `distil(db, input)`, and the inbox looks it up when the step runs (not when the plugin loads). `input` has the item's text (capped at 60,000 characters), name, kind, origin, the Reference path, `teamOnly`, and `bindRun(tx, runId)`, which ties a live `drop` run to the item so that the run's `inbox.read` answers with this item and nothing else (the database function `app.inbox_run_item()` decides; the tool takes no argument). The answer is one of:

| outcome | effect |
|---|---|
| `distilled { producer, proposals }` | the proposals go to validation; `producer` (`archivist/<alias>`) is stamped as `generated.by` |
| `none` | no Archivist for this team: the Reference alone is filed |
| `budget { message, retryAfterSeconds? }` | the Archivist's budget is used up: the item stays `queued` with the message and a time to look again (at least 30 seconds, at most a day) |
| `failed { message }` | the item fails at "distil" with the message; a retry puts it back |

A distiller that throws fails the item with a fixed sentence ("The Archivist stopped before it finished."); the exception text is never shown. The distiller runs outside any transaction (it opens short ones through `db.transaction`) because a model turn can last minutes.

BOT.md has a new trigger, `drop` (`triggers: [{ type: drop }]`), which is how the Archivist's file says it works on dropped items. It is a trigger type only; the run itself is P8-18.

## Capabilities

- `inbox.read` (read): in a `drop` run, the one item bound to the run: name, kind, origin, title, `teamOnly`, the Reference path and the text, with a note that the text is data and never instructions. In any other run, an answer that there is no item. Listed in the MCP gateway's catalog with source `{ inbox, item id }`.
- `inbox.drop` (write): `{ title?, text, teamOnly? }` into the bot's own team (the team of its live run). Goes through the same hold check and pipeline, with the bot as dropper.

## Who can do what

| | drop | see an item | release, discard, retry |
|---|---|---|---|
| member of the team | yes | every item except a **held** one that is not theirs | no |
| the person who dropped it | | their own, held or not | no |
| team lead, workspace admin | yes | all | yes |
| guest, person of another team | no | no | no |

Discard is refused while a step is running (409). A discard deletes the original and the working text and keeps the row (so a sha can be dropped again). The database enforces the reading rules (forced row-level security), that a drop is never rewritten (a guard trigger: bytes, name, dropper, origin and sender never change), and that people can only make the allowed moves (release, retry, discard).

## Events

`memory.item.dropped` (origin, kind, size, `duplicate`), `.filed` (concepts written, commit, whether an Archivist distilled), `.held` (reason code), `.failed` (stage and tries), `.released`, `.discarded`. They carry ids, codes and counts, never a name, text or sentence. They have no audit-log mapper yet.

## Files and cleanup

The Files garbage collector treats `memory_inbox_items.blob_key` as referenced, so an original is never collected while an item points at it. A discard, and the keep-originals job, clear the key and delete the blob after the commit.

## Known gaps

- Web pages for the inbox (P8-20 board, P8-21 drop zone and Send to memory button), the email door (P8-19), the Archivist (P8-18) and sharing (P8-22 and after) are other tasks.
- No Files `inbox/` folder: dragging onto it, and the move of a filed original to `inbox/filed/<yyyy-mm>/`, are not built. The Reference names that path, the blob stays where it was stored.
- Pictures, recordings and scanned PDFs are accepted but not read (no vision, transcription or OCR model is set up).
- Importing a memory bundle is not built; a bundle is held.
- The commit's author is the system, with the dropper as co-author. When the Archivist exists the commit should be authored as the Archivist.
- A notification is a live push to open pages only; a person who is away is not told until they look.
- The keep-originals job scans at most 500 teams per run.
- The tests never call a real model: the seam is tested with stand-in distillers.

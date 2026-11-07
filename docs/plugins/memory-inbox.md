# memory-inbox

A team's inbox for its memory. Anyone on a team drops a file, a note or a chat message into it; the platform checks what may come in, reads the file into plain text, lets the team's Archivist (a bot that looks after memory) turn the text into memory concepts when there is one, checks what comes back, and files the result in the team's memory with a **Reference**: a concept that carries the full text and says where the original is. The person who dropped it is told when it is filed, held or could not be read. Without an Archivist the inbox still works: it files the Reference alone, so nothing a person drops is lost.

Package: `packages/plugins/memory-inbox` (PLAN P8-14 to P8-17; SPEC §12.2). Manifest: depends on `teams`, `channels`, `bots`, `files`, `memory`, `repo-git`, `tasks` and `connections` (the last two for the email door and the action items, below); `extends: ['event.emit', 'job.register', 'hook.pre_egress']`; emits `memory.item.dropped`, `memory.item.filed`, `memory.item.held`, `memory.item.failed`, `memory.item.released`, `memory.item.discarded` and `memory.personal_item.changed` (a person's own inbox, below); registers the capabilities `inbox.read` and `inbox.drop`. Schemas: `packages/shared/src/entities/inbox.ts`, `packages/shared/src/api/inbox`, `packages/shared/src/events/memory.item.*.ts`. Migrations: `0001_memory_inbox.sql`, `0002_email_door_actions.sql`, `0003_import_stage.sql` and `0004_personal_inbox.sql` in the plugin's own folder.

## The doors

| door | how | state |
|---|---|---|
| Drop a file | `POST /api/teams/:slug/inbox/items?name=<file name>[&teamOnly=true]`, the body is the file (also `x-file-name`) | built |
| New note | `POST /api/teams/:slug/inbox/notes` `{ title?, text, teamOnly }`; a text that is only a web address is filed as a **link** and the page is never fetched | built |
| Send to memory | `POST /api/channels/:channelId/messages/:messageId/send-to-memory` `{ confirmPrivate, teamOnly, thread }`: one message, or the whole thread (up to 200 messages), with who said it and when. The caller must be able to read the channel; a private channel needs `confirmPrivate: true` (the answer says everyone on the team will see it); a direct message or a bot conversation is refused | built |
| A bot drops text | the capability `inbox.drop` (for the bot's **own** team only) | built |
| Drag onto the Files tree's `inbox/` folder | | not built (Files has no `inbox/` folder yet; `inbox/` is storage, not a repo folder) |
| Email to the team's address | `inbox+<team>@<mail domain>`; the mail transport pushes a received message to `POST /api/workspace/inbox-mail/:connection?spf=&dkim=` (the body is the message) | built (the door and its address; the transport that receives real mail is not, see "Email to the team's address") |
| The web pages (drop zone, board, Send to memory button) | | the Inbox tab is P8-21 |

Every door creates the same thing: an item. Who may drop: a person of the team (a lead, a member; **not** a guest, and not a person of another team) or a bot of the team. The routes read the team through the caller's own access, so a person who cannot see a team gets a plain refusal, not a hint that it exists.

### Limits of a drop

A file is streamed straight to blob storage; it is never held in memory. Environment (read each time a drop arrives, so a change needs no restart):

| setting | default | meaning |
|---|---|---|
| `MANYTHREADS_INBOX_MAX_BYTES` | 25 MB | the server's cap on one drop. The team's own `maxBytes` (below) may only lower it for holding purposes |
| `MANYTHREADS_INBOX_DROPS_PER_MINUTE` | 20 | per person (or bot), kept in the server's memory, not the database |
| `MANYTHREADS_UPLOAD_IDLE_MS` | 20 seconds | a sender that sends nothing for this long is cut off and nothing is kept |
| `MANYTHREADS_UPLOAD_MAX_MS` | 600 seconds | the whole upload must finish by then |
| `MANYTHREADS_MAIL_DOMAIN` | `mail.manythreads.invalid` | the domain team email addresses are made on (`inbox+<team>@<domain>`); the default never resolves |

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
| `foreign_bundle` | the file looks like a memory bundle from elsewhere (a `.zip` or `.okf`). It is held until a lead releases it, then the bundle importer (the memory-share plugin, P8-25) checks the whole bundle and files it under `memory/shared/external/<name>/`, or refuses it whole. A digest another team delivered (origin `share`) is not held for this reason |
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

## Email to the team's address

Mail sent to a team's address becomes an item. The subject is the item's title, each attachment becomes an item of its own (the extract step makes them from the message, with the message's sender and trust), and **no bot runs for the message**: the door files it and nobody answers it. (A bot hears about a mail only through an `inbox` trigger of the connections plugin, which this door does not touch.)

**The address.** `inbox+<team slug>@<mail domain>`. It is made on a workspace-wide `email` connection with the short name `inbox`, which a workspace owner or admin switches on once with `POST /api/workspace/inbox-mail` (201 the first time, 200 after; it leaves the usual `connections.connection.changed` audit line and holds no password). The mail domain is `MANYTHREADS_MAIL_DOMAIN`; when it is not set the address is made on `mail.manythreads.invalid`, a domain that never resolves, so the address can be shown but nothing can be sent to it until an admin names the real one. `GET /api/teams/:slug/inbox/email` returns what the Inbox tab shows: `address` (null until the mailbox is on), `connection`, a `reason` sentence when there is no address (it says whether the reader can switch it on: `canSetUp`), `allowedSenders` (the team's `allowEmailFrom`) and `rule`, one sentence saying who is let in. A guest gets 403.

**Delivery.** `POST /api/workspace/inbox-mail/:connection?spf=<verdict>&dkim=<verdict>` with the message as the body (`message/rfc822` or any content type). It is for workspace owners and admins (a person, a bot or the platform's own transport acting as one); nobody else, 403. The size cap is `MANYTHREADS_INBOX_MAX_BYTES` (413). The answer lists one delivery per team named in `To`, `Cc` and `Delivered-To`/`X-Original-To` (the first five only; the rest say `ignored`): `received`, `duplicate` (the same Message-ID was already delivered to that team; the first item is named) or `ignored` (no such team, archived). 201 if anything new was filed, else 200. A message with no `From`, no recipient that is a team address, or no body is 400.

**Who is let in.** Two facts, kept apart:

1. *What the sending domain proved* comes from the transport, in the query (`spf`, `dkim`; each `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror` or `permerror`). It passes when at least one of them passed and neither failed; no result, a soft fail or a neutral answer counts as failed. **A header inside the message is never read for this**: every header is written by whoever sent the mail, so a forged `Authentication-Results` or `Received-SPF` line proves nothing. The transport must report the verdict for the domain in the `From` address (alignment), not for the envelope sender.
2. *Who the sender is* comes from the `From` address, looked up among the workspace's active people (their main address or a verified extra address).

Together they give the item's `sender_check`, and the hold rules above do the rest:

| proved by the sending domain | the sender | `sender_check` | the item |
|---|---|---|---|
| no | anyone | `fail` | held `failed_sender_check`; no person is credited as the dropper |
| yes | a person of this team, or a workspace owner or admin (never a guest) | `pass` | goes in (unless the team's review is `all`); credited to that person |
| yes | anyone else | `none` | held `unknown_sender`, unless the address is in the team's `allowEmailFrom` (or review is `none`) |

A listed address that failed the check is still held. A forged mail never carries a real person's name, whoever it claims to be from. The same message (the same Message-ID) delivered again to the same team is one item (`memory_inbox_mail`, system role only). A `.eml` file dropped by hand through the upload route is read by the same parser: the same title rule, body and attachment items.

## Action items on the board

An Archivist note of type `Action Items` lists actions one to a line, `- [ ] what (owner: Name; due: 2026-11-20)` (`parseActionItems` in `packages/shared/src/okf/action-items.ts` reads them; the owner and the due date are optional, the due date must be a real date). The Inbox tab shows each action of a filed item with an Add to board button. The click is the **person's** act, never a bot's:

1. `GET /api/teams/:slug/inbox/items/:itemId/actions` returns `{ actions, canAdd }`. Each action has `conceptPath` and `index` (together they name it), `what`, `ownerName`, `ownerActorId` (the person of the team the name means, when exactly one matches by full or first name), `due`, `done`, `prepared` (the body to send: `title`, `description`, `kind: other`, `priority: normal`, `branch: main`; the owner and the due date are written into the description because a card has no field for them), and `taskId` / `addedBy` when somebody already added it.
2. The web sends `prepared` to `POST /api/teams/:slug/tasks` as the signed-in person. (If `ownerActorId` is set, it may then hand the card over with the existing handoff route.)
3. The web tells the inbox which action it was: `POST /api/teams/:slug/inbox/items/:itemId/actions` `{ conceptPath, index, taskId }`. The inbox accepts it only from a person who may post on the team, for a card of this team that **this person created** (a bot's card, or somebody else's, is refused with 400), and for an action the item really has (404 otherwise). The same card again is 200; a different card for an action already on the board is 409; a first record is 201. `memory_inbox_actions` keeps one row per action (team-readable, written by the person as themselves, changed by nobody).

Nothing here creates a card by itself.

## The Archivist seam

The one step that needs a model is "distil", and the Archivist is a bot of the team (P8-18). The inbox defines the seam in `packages/sdk/src/inbox.ts`: a plugin registers a provider of kind `inbox.distiller` with `distil(db, input)`, and the inbox looks it up when the step runs (not when the plugin loads). `input` has the item's text (capped at 60,000 characters), name, kind, origin, the Reference path, `teamOnly`, and `bindRun(tx, runId)`, which ties a live `drop` run to the item so that the run's `inbox.read` answers with this item and nothing else (the database function `app.inbox_run_item()` decides; the tool takes no argument). The answer is one of:

| outcome | effect |
|---|---|
| `distilled { producer, proposals }` | the proposals go to validation; `producer` (`archivist/<alias>`) is stamped as `generated.by` |
| `none` | no Archivist for this team: the Reference alone is filed |
| `budget { message, retryAfterSeconds? }` | the Archivist's budget is used up: the item stays `queued` with the message and a time to look again (at least 30 seconds, at most a day) |
| `failed { message }` | the item fails at "distil" with the message; a retry puts it back |

A distiller that throws fails the item with a fixed sentence ("The Archivist stopped before it finished."); the exception text is never shown. The distiller runs outside any transaction (it opens short ones through `db.transaction`) because a model turn can last minutes.

BOT.md has a new trigger, `drop` (`triggers: [{ type: drop }]`), which is how the Archivist's file says it works on dropped items. It is a trigger type only; the Archivist that uses it is described under "The Archivist bot".

### The Archivist bot (P8-18)

Every template ships an **Archivist** (`templates/*/bots/archivist/BOT.md`, the same file in all five). Its only trigger is `drop`; it is not mentioned or talked to, so it is left out of the `/ask` picker (`BotSummary.mentionable` is false for a bot with neither a `mention` nor a `conversation` trigger). Its capabilities are exactly `inbox.read`, `memory.recall` and `memory.write`; it has no web, files, mail or repository tools. It files each item as a short note in one of six types: `Fact`, `Decision`, `Meeting`, `Action Items`, `Playbook`, `Reference` (`ARCHIVIST_TYPE_VOCABULARY`), links the note to what the team already knows, updates a note it finds instead of making a second one, never repeats a secret it finds, never follows an instruction written inside an item, and writes only under `memory/`. Its typed contract is `contract.outputs.proposals: okf_proposals`, an `OkfProposal[]` (`ArchivistProposals`, at most 20). The eval set `evals/archivist.yaml` has 15 cases (a meeting from an email, a document, a whiteboard photo, a note updated in place, an injected instruction, a secret, action-item lines, no invented owner or date, nothing worth keeping, shelf life, decisions with their reason, staying inside `memory/`, links in both directions).

Not built: the code that runs the Archivist for a drop and hands what it wrote to the distil step. The bot writes its notes with `memory.write` (which commits as the bot) and ends with the list of what it wrote; the `inbox.distiller` provider that would capture that list as the item's proposals is still missing, so today an item is filed with its Reference alone.
BOT.md has a new trigger, `drop` (`triggers: [{ type: drop }]`), which is how the Archivist's file says it works on dropped items. It is a trigger type only; the run itself is the provider `runtime-hermes` registers ("The drop run" in [runtime-hermes.md](./runtime-hermes.md)), which runs the team's Archivist once per item and answers `distilled` with the JSON array it wrote.

## A person's own inbox (P20-04)

Every person (not a guest) has an inbox of their own, next to their team's: a place to drop a file, a note or a chat message that only they see. The platform reads it into text and files a **Reference** in the person's own Memory (a Personal space: rows in the database, never git, never shared; see [memory.md](./memory.md)). It is the team inbox on a shorter road, because nothing in it belongs to a team: there is no team rule, no review by a lead and no Archivist step. A person who wants something in a team uses **Send to team**.

Where it lives: its own table, `memory_personal_inbox_items` (migration `0004`), keyed by the owner. Only the owner reads it; an admin sees it only during a live audited open of that person's space, and then cannot change it. The owner drops, releases, discards and retries; everything else is the pipeline's. The database keeps the same rules as for the team inbox (what a drop is never changes, only the allowed moves are made) and a cap of 200 waiting items per person. The original is kept in blob storage until the owner discards the item (the Files garbage collector reads `memory_personal_inbox_items.blob_key` too).

The road: **receive** (the same bytes already in the person's inbox make a `duplicate`; nothing is read again) → **hold check** → **read and file**. Two jobs: `memory-inbox.personal-hold` and `memory-inbox.personal-file` (one item at a time each), and a cron `memory-inbox.personal-sweep` (every minute: a step that lost its job goes back in the queue; after five tries it fails with a sentence).

- **Held** (the owner decides; release lets it through, discard deletes the original): a memory bundle from somewhere else (`foreign_bundle`; a bundle cannot be imported into a Personal space, so a released one then fails with a plain sentence), a file over the size cap (`oversize`, 25 MB unless `MANYTHREADS_INBOX_MAX_BYTES` says less), and text the workspace's data rules say looks private (`dlp`: a key, a card number or the like; the same `pre_egress` guards as the team inbox are asked, destination `memory_inbox`).
- **Filed**: a Reference at `memory/references/<name>-<8 characters of the id>.md` in the person's bundle, written through the Memory plugin's database door `app.memory_personal_put` as the system. It carries the text (the first 20,000 characters if longer), `origin: drop`, and `resource: personal-inbox/<item id>`. A discard of a filed item is refused (409): it is a file in Memory now, with its own history; delete it there.
- **Failed**: a file that cannot be read says why in a plain sentence (a picture, a recording, a damaged PDF); the original stays for a retry.

Reading is the same as for the team inbox (Markdown, text, CSV, PDF, Word, PowerPoint, Excel, email, HTML; a text that is only a web address is kept as a link and never fetched).

| route | answer |
|---|---|
| `GET /api/me/inbox/items[?state=&limit=]` | the person's own items (not discarded ones unless `state=discarded`), and the size cap `maxBytes` |
| `GET /api/me/inbox/items/:itemId` | one item; another person's id answers 404 |
| `POST /api/me/inbox/items?name=` | a file (the body is the file, streamed; the same limits and `415`/`413`/`429` answers as the team drop); `{ item, duplicate }`, `201` or `200` for a duplicate |
| `POST /api/me/inbox/notes` | `{ title?, text }`; `{ item, duplicate }` |
| `POST /api/me/inbox/items/:itemId/release` | a held item goes on (a `dlp` hold goes back to the read, the others to the hold check); `409` if not held |
| `POST /api/me/inbox/items/:itemId/discard` | deletes the original; only a waiting, held or failed item (`409` otherwise) |
| `POST /api/me/inbox/items/:itemId/retry` | puts a failed item back at the read; `409` if not failed |
| `POST /api/me/inbox/items/:itemId/send-to-team` | `{ teamSlug, teamOnly }`; drops a copy of the original into that team's inbox as the person, so that team's rules apply (its holds, its size cap, its review mode); `{ teamItemId, duplicate }`. The person needs to be able to post in the team; a held, discarded or duplicate item, or one whose original is gone, is refused (`409`) |

Every item has `personId` and `space` (`person:<id>`) instead of a team, `teamOnly` is always false, and the fields for email (`sender`, `senderCheck`, `parentId`) are empty. Each move writes one `memory.personal_item.changed` event (item id, state, origin, kind, size, whether it was a duplicate; never the name or the text). A move is not pushed live (the team inbox pushes to the dropper's open tabs; the push carries a team id, which a person's own item does not have), so a screen reads the list again.

**Send to memory** (`POST /api/channels/:channelId/messages/:messageId/send-to-memory`) takes `target: 'team' | 'personal'` (default `team`). With `personal` the message (or its thread) goes to the person's own inbox, from any channel or direct message they can read; `confirmPrivate` and `teamOnly` do not apply, because nobody else is shown it. The answer is the person's item in the shape above.

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

## Routes and jobs

Every route reads the team through the caller's own access; each carries its own inline `rateLimit` and none is a credential or session route.

| route | who | answer |
|---|---|---|
| `GET /api/teams/:slug/inbox/items[?state=&limit=]` | the team | the items the caller may see, `canManage`, the team's size cap |
| `GET /api/teams/:slug/inbox/items/:itemId` | the team | one item (a held item only to its dropper and the managers) |
| `POST /api/teams/:slug/inbox/items/:itemId/release` | lead or admin | a held item goes on; `.released` |
| `POST /api/teams/:slug/inbox/items/:itemId/discard` | lead or admin | deletes the original and the working text, keeps the row; `409` while a step runs |
| `POST /api/teams/:slug/inbox/items/:itemId/retry` | lead or admin | puts a failed item back at the step that failed |
| `GET` and `POST /api/teams/:slug/inbox/items/:itemId/actions` | the team (record: a person of the team) | the action lines of the item's Action Items concepts; record which card an action became |
| `GET /api/teams/:slug/inbox/email` | the team | the team's inbox address, when the mail door is set up |
| `POST /api/workspace/inbox-mail` | workspace admin | sets up the mail door on an email connection |

The drop, note, send-to-memory and mail-delivery routes are in "The doors". The jobs, one queue each (`serialKey` is the item, so one item is never worked on twice at once): `memory-inbox.hold`, `memory-inbox.extract`, `memory-inbox.distil`, `memory-inbox.commit`, `memory-inbox.import` (a bundle, handed to the `inbox.importer` of memory-share), and two crons, `memory-inbox.sweep` (every minute) and `memory-inbox.keep` (daily, the keep-originals rule).

## Events

`memory.item.dropped` (origin, kind, size, `duplicate`), `.filed` (concepts written, commit, whether an Archivist distilled), `.held` (reason code), `.failed` (stage and tries), `.released`, `.discarded`. A bundle that arrives here is judged by memory-share, which emits `memory.digest.imported` (see [memory-share.md](./memory-share.md)). They carry ids, codes and counts, never a name, text or sentence. They have no audit-log mapper yet.

## Files and cleanup

The Files garbage collector treats `memory_inbox_items.blob_key` as referenced, so an original is never collected while an item points at it. A discard, and the keep-originals job, clear the key and delete the blob after the commit.

## Known gaps

- A person's own inbox has no Archivist step (the Reference is the whole result), no email door, no live push, and the Memory screen's Personal view and an inbox screen for it are not built yet (P20 UI).

- The Inbox tab (drop zone, Send to memory button, the address, the Add to board button) is P8-21; sharing (P8-22 and after) is another task.
- The email door has no transport of its own: nothing yet receives real mail, checks SPF and DKIM and calls the delivery route. Until one exists an admin (or a script acting as one) delivers messages by hand. The trusted-sender rule is stricter than "any person in the workspace": a person of the team or a workspace owner/admin.
- A card has no owner or due-date field, so an action's owner and date go into the card's description.
- The Archivist's run for a drop is not wired to the distil step (see "The Archivist bot").
- No Files `inbox/` folder: dragging onto it, and the move of a filed original to `inbox/filed/<yyyy-mm>/`, are not built. The Reference names that path, the blob stays where it was stored.
- Pictures, recordings and scanned PDFs are accepted but not read (no vision, transcription or OCR model is set up).
- Importing a bundle needs the memory-share plugin (it registers the `inbox.importer`); with none registered the item fails with a plain sentence and is never filed unchecked. A single hand-dropped `digest.md` is not a bundle and goes through the normal path. The import stage is `import` (jobs `memory-inbox.import`).
- The commit's author is the system, with the dropper as co-author. When the Archivist exists the commit should be authored as the Archivist.
- A notification is a live push to open pages only; a person who is away is not told until they look.
- The keep-originals job scans at most 500 teams per run.
- The tests never call a real model: the seam is tested with stand-in distillers.

## The Inbox tab and the email door in the web (PLAN P8-19, P8-20, P8-21)

- The drop zone shows the team's address from `GET /api/teams/:slug/inbox/email` (the rule in one sentence and the allowed outside senders). While the workspace mailbox is off, a workspace admin sees a "Switch it on" button that calls `POST /api/workspace/inbox-mail`; anyone else reads the server's sentence, which says to ask an admin. The item list no longer carries an address.
- A filed item whose concepts include an `Action Items` concept asks `GET /api/teams/:slug/inbox/items/:itemId/actions` and shows one line per action. "Add to board" sends the server's `prepared` body to `POST /api/teams/:slug/tasks` as the signed-in person, then tells the inbox which card it made (`POST .../actions`) so the action shows as added to everyone. If the second call fails, the card exists and the page says so instead of making another.
- The offline mock (`clients/web/src/api/mock-inbox.ts`) starts with the mailbox off, answers all of the above, and seeds the Engineering release notes with an Action Items concept.

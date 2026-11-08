# Google

Drive, Gmail and Calendar, as each person's own sign-in.

## What it does

- A bot can search and read the asker's Drive files, mail and calendar, and with approval draft, label or send mail and add or change calendar events.
- A channel can plan a voice room ahead (Schedule a room). The event is put on the organizer's own Google calendar with the join link in it.
- `calendar.find_free_time` finds a free slot for several people who share a team with the asker.
- A person or a team lead can pick a Drive folder as a source for a knowledge base.

## Set up at Google

1. In Google Cloud, make an OAuth client (type: web). A workspace that uses it only for its own domain can choose the "Internal" user type and needs no review by Google. An app for outside users does need review for the mail scopes.
2. Add the redirect address `<site address>/api/me/connections/google/callback` (Settings, Connections shows the exact one).
3. Turn on the Drive, Gmail and Calendar APIs.
4. Give the client id and secret to manythreads at Settings, Connections, Apps (or the server variables `MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID` and `_CLIENT_SECRET`).

## Services, scopes and why

A person ticks services one at a time. A later service asks only for the new scope (`include_granted_scopes`).

| Service | Scope | Why |
|---|---|---|
| Drive (read), ticked by default | `drive.readonly` | search, read, and the knowledge source |
| Gmail (read) | `gmail.readonly` | search and read mail |
| Gmail drafts | `gmail.compose` | save a draft the person sends themselves |
| Gmail labels | `gmail.modify` | put labels on and take them off |
| Gmail (send) | `gmail.send` | send, always after approval |
| Calendar (read), ticked by default | `calendar.events.readonly` | list events |
| Calendar (add and change events) | `calendar.events` | planned rooms, create and update |
| Calendar (free and busy) | `calendar.freebusy` | find a free time |

Every sign-in also asks for `openid` and `email`, and for offline access so a refresh token is issued.

## Tools

`google_drive.search`, `google_drive.read`, `gmail.search`, `gmail.read`, `gmail.list_labels`, `gmail.draft`, `gmail.label`, `gmail.send`, `google_calendar.list_events`, `google_calendar.create_event`, `google_calendar.update_event`, `google_calendar.free_busy`, and `calendar.find_free_time`. Writes wait for approval and show a card with every recipient, the subject and the first 1,500 characters of the text. Nothing deletes or cancels.

## Triggers

None. New mail in a label (`gmail_label_mail`) is not built: a run that mail starts has no asker, so it could not use the person's tools. That needs an owner decision. A routine can ask `gmail.search` for `label:<name> newer_than:1d` instead.

## Sync

- **Planned rooms.** The job `meetings.scheduled-sync` runs every 10 minutes and reads up to 50 plans starting within 48 hours at the organizer's calendar. A moved event changes the plan. A deleted event cancels it.
- **Drive source.** The first pass takes Drive's change token first, then walks the folder, so an edit during the walk is seen next time. Later passes read the change feed. A removed or trashed file is removed from the base. A file moved out of the folder is dropped at the next full read (every 24 hours).
- Docs become plain text, Sheets the CSV of the first sheet, Slides plain text, and Word, Excel and PowerPoint files go through the extractor.
- Who may read: a file is copied into a team base only when it is shared with "anyone", or by domain or by name with every verified member email. A group share never counts.

## Limits

A file read is cut at 20,000 characters. A document is at most 10 MB, a pass takes at most 100 documents and 20 MB, and a source is read every 60 minutes unless set (15 to 10,080). Free/busy covers at most 31 days and ten other addresses. `gmail.send` takes up to 20 recipients, no bcc, no header. Gmail answers only the headers it is asked for. Changing an event does not email the guests.

## Proved against the stand-in only

- The real consent screen, the "Internal" user type, and Google's review of restricted mail scopes.
- Real refresh-token expiry and rotation, and the real revoke address.
- Drive change feeds on a shared drive, and the real size and rate limits of the Drive, Gmail and Calendar APIs.
- The exact free/busy answer for a calendar that is not shared.
- That a changed event does not email guests.

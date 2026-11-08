# Microsoft 365

OneDrive, Outlook mail, Outlook calendar and SharePoint, as each person's own sign-in.

## What it does

- A bot can search and read the asker's OneDrive and SharePoint files and Outlook mail and calendar, and with approval draft, categorize or send mail and add or change events.
- A channel can plan a voice room ahead. The event goes on the organizer's Outlook calendar.
- `calendar.find_free_time` works for Microsoft calendars too.
- A person or a team lead can pick a OneDrive or SharePoint folder as a source for a knowledge base.

## Set up at Microsoft

1. In the Azure portal, register an application (web). Choose the account types you need: work and school only gives you free/busy and SharePoint search.
2. Add the redirect address `<site address>/api/me/connections/microsoft/callback`.
3. Add the delegated permissions in the table below. An administrator may have to approve `Sites.Read.All` for the organisation.
4. Give the application id and secret, and the directory (default `common`), to manythreads at Settings, Connections, Apps.

## Services, scopes and why

| Service | Scope | Why |
|---|---|---|
| OneDrive (read), ticked by default | `Files.Read` | search, read, knowledge source |
| Outlook mail (read) | `Mail.Read` | search and read |
| Outlook drafts | `Mail.ReadWrite` | save a draft, and make the reply draft |
| Outlook categories | `Mail.ReadWrite`, `MailboxSettings.Read` | list and set colour categories |
| Outlook (send) | `Mail.Send` | send, after approval |
| Outlook calendar (read), ticked by default | `Calendars.Read` | list events |
| Outlook calendar (add and change events) | `Calendars.ReadWrite` | planned rooms |
| Outlook calendar (free and busy) | `Calendars.ReadBasic` | find a free time |
| SharePoint (read) | `Sites.Read.All` | search, read, knowledge source |
| Teams meeting transcripts | `OnlineMeetingTranscript.Read.All` | not built |

Every sign-in also asks for `openid`, `email`, `offline_access` and `User.Read`.

## Tools

`onedrive.search`, `onedrive.read` (reads an Excel workbook as CSV: first sheet, cells A1 to Z200), `outlook.search`, `outlook.read`, `outlook.list_folders`, `outlook.draft`, `outlook.list_categories`, `outlook.categorize`, `outlook.send`, `outlook_calendar.list_events`, `outlook_calendar.create_event`, `outlook_calendar.update_event`, `outlook_calendar.free_busy`, `sharepoint.search`, `sharepoint.read`. Writes wait for approval.

## Triggers

None. New mail in a folder (`outlook_folder_mail`) is not built, for the same reason as Gmail: a run started by mail has no asker.

## Sync

- **Planned rooms.** The same 10-minute read of the organizer's calendar as for Google.
- **OneDrive and SharePoint sources.** Read through the document door with the person's own grant. OneDrive uses Microsoft's change feed (`delta`). A moved or deleted file is dropped at the next full read.
- The team rule is the same: only files everyone on the team can open are copied in.

## Limits

`outlook.send` takes at most 10 recipients in all (the approval card keeps ten items of a list), no bcc, no reply-to, ASCII addresses only. A reply is made with `createReply`, set to exactly the text the approver read, and then sent. Microsoft has no "do not tell the guests" switch, so changing an event with guests emails them. `outlook_calendar.free_busy` and SharePoint search work for work and school accounts only. Microsoft has no revoke address, so a sign-in is forgotten on our side only.

## Proved against the stand-in only

- The real consent behaviour of `Calendars.ReadBasic`, `MailboxSettings.Read` and `Sites.Read.All`.
- `getSchedule` and the file search on a real tenant (shapes were written from the documentation).
- `createReply`, the PATCH of a reply draft, and that the reply stays in its conversation.
- That a `$filter` without `$orderby` on messages answers newest first.
- Reading a real workbook through the range API, and the `Prefer: outlook.timezone="UTC"` header.

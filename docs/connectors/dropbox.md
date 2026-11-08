# Dropbox

Dropbox folders as a source for a knowledge base.

## What it does

A person or a team lead picks a folder (or the whole Dropbox) as a source. Its files are copied into a knowledge base and kept up to date. Nothing is written back. The tools to search and read files from a bot run are listed in the catalog but not built.

## Set up at Dropbox

1. In the Dropbox App Console make a scoped app with "full Dropbox" access.
2. Add the redirect address `<site address>/api/me/connections/dropbox/callback`.
3. On the Permissions tab turn on `account_info.read`, `files.metadata.read`, `files.content.read` and `sharing.read`.
4. Give the app key and secret to manythreads at Settings, Connections, Apps.

## Services, scopes and why

One service, Dropbox files (read), ticked by default. `files.metadata.read` lists, `files.content.read` downloads, `sharing.read` tells who can open a file, and `account_info.read` is the identity the screen shows. The sign-in uses PKCE and asks for offline access (a refresh token, because Dropbox access tokens last four hours). Downloads come from a second Dropbox host.

## Tools

`dropbox.search` and `dropbox.read` are listed as not available. The service is used by the knowledge sync only.

## Triggers

None.

## Sync

- `files/list_folder` with `recursive`, then `list_folder/continue` with the cursor Dropbox hands back. The cursor is the resume point inside a pass and between passes. Dropbox lists a deleted file, so removals are exact.
- A root is `root` or a top folder's lower-case path. A file's remote id is its lower-case path.
- **Who may read.** Sharing by e-mail counts if the addresses cover everyone on the team. A link anyone can open means anyone. A team-only link, a password link, or a group is "not everyone". A file that cannot be read is "not everyone" and is left out of a team base (counted in `skippedLimited`).
- Limits per pass: 100 documents and 20 MB; one document at most 10 MB. Every 60 minutes unless set.

## Limits

The picker offers `root` and top folders. Folders inside folders are not offered.

## Proved against the stand-in only

- PKCE and offline access with a real app.
- The real shape of sharing answers (members, links, groups).
- Cursor expiry and the `reset` answer on a long-idle source.
- Download limits of the content host.

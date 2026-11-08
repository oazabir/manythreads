# Box

Box folders as a source for a knowledge base.

## What it does

A person or a team lead picks a folder as a source. Its files are copied into a knowledge base and kept up to date. Nothing is written back. The tools to search and read files from a bot run are listed in the catalog but not built.

## Set up at Box

1. In the Box developer console make a custom app with user authentication (OAuth 2.0).
2. Add the redirect address `<site address>/api/me/connections/box/callback`.
3. Under Application scopes, allow only "Read all files and folders stored in Box" (`root_readonly`). Box has no scope parameter in the sign-in, so this setting at Box is the limit, like Notion.
4. Give the client id and secret to manythreads at Settings, Connections, Apps. Some companies need an admin to approve the app first.

## Services, scopes and why

One service, Box files (read), ticked by default, with the scope `root_readonly`. No PKCE. Box rotates the refresh token on every renewal and manythreads keeps the new one. Box has no revoke address that fits the shared code, so a sign-in is forgotten on our side.

## Tools

`box.search` and `box.read` are listed as not available. The service is used by the knowledge sync only.

## Triggers

None.

## Sync

- Box's own change feed (events) needs an enterprise scope, so a pass walks the folder tree under the root, one folder page per call. A pass after the first reports only the files edited since the last one. Then the trash is read newest first, and files trashed since the last pass are removed.
- A folder is visited on every pass, so a quiet pass over a big tree is many calls that return few files.
- A file moved out of the root is not noticed. A file deleted for good is noticed only if it passed through the trash. Box has no deletion feed, so stored documents are re-checked.
- **Who may read.** The file's own link (`open` means anyone; a company link or anything else is "not everyone"), the owner, and the collaborators of the file and of each folder above it (at most ten). A group or an invitation without an address is "not everyone".
- Limits per pass: 100 documents and 20 MB; one document at most 10 MB. Every 60 minutes unless set.

## Limits

The picker lists the root folders the grant offers.

## Proved against the stand-in only

- Consent and refresh rotation with a real app.
- Collaboration and shared-link answers on a real enterprise account.
- Trash listing order and the cost of a full walk on a large tree.

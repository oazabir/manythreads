# Notion

Pages the person shares with the connection.

## What it does

A bot can search the pages a person shared, read one, and (after approval) add a page under a shared page. A person or a team lead can pick "everything shared with the connection", or one database, as a source for a knowledge base.

## Set up at Notion

1. At notion.so/my-integrations make a public integration.
2. Add the redirect address `<site address>/api/me/connections/notion/callback`.
3. Give the client id and secret to manythreads at Settings, Connections, Apps.
4. When a person signs in, Notion asks them which pages to share. What they do not share, manythreads cannot see.

## Scopes and why

Notion has no scopes. What the app may do is set on the integration at Notion, and what it may reach is what the person shares. There is one service (Notion). Sign-in has no PKCE; it relies on the `state` and the app secret. Notion's tokens are not renewed (there is no refresh); a token Notion rejects means the person connects again.

## Tools

`notion.search`, `notion.read_page`, `notion.create_page` (a write: waits for approval).

## Triggers

None.

## Sync

Notion offers no change feed. A pass asks for pages newest edit first and stops at the first page not edited since the last pass. Notion rounds edit times to the minute, so the mark is held back two minutes and a page may be listed once more (the knowledge side skips a version it has). A page in Notion's trash is removed. Notion has no feed of deletions or un-sharing, so those stored pages are re-checked on every pass, and a page that simply stops being returned is dropped at the next full read.

Who may read: Notion's API does not say who in the workspace can open a page, so a page counts as "not everyone" unless it is published to the web. In a team base, only published pages are copied in. A Personal base takes whatever the person can open.

## Limits

A page read follows at most 40 block calls, 5,000 blocks and 3 levels deep. A document is at most 10 MB.

## Proved against the stand-in only

- The consent screen and the sharing picker.
- Notion's real rounding of edit times, and its sort and paging behaviour.
- A real page with many nested blocks.

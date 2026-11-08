# Confluence

Confluence Cloud pages as a source for a knowledge base.

## What it does

A person or a team lead picks a Confluence space as a source. Its pages are copied into a knowledge base and kept up to date as they change. Nothing is written back. The tools to search and read pages from a bot run are listed in the catalog but not built.

## Set up at Atlassian

1. At developer.atlassian.com make an OAuth 2.0 (3LO) app of its own for Confluence (not the Jira one).
2. Add the redirect address `<site address>/api/me/connections/confluence/callback`.
3. Add the permissions `read:confluence-content.all`, `read:page:confluence` and `read:space:confluence`.
4. Give the client id and secret to manythreads at Settings, Connections, Apps. The person signs in, then picks a space at Knowledge, Add a source.

## Services, scopes and why

One service, Confluence pages (read), ticked by default. The scopes are the three above. The sign-in also asks for `offline_access` and `read:me`, and uses Atlassian's consent address with `prompt=consent`. The site is found from the list of sites the grant reaches (the first one). Tokens are renewed with a refresh token.

## Tools

`confluence.search` and `confluence.read_page` are listed as not available. The service is used by the knowledge sync only.

## Triggers

None.

## Sync

- A root is one space (its numeric id).
- Pages come newest edit first. A pass stops at the first page not edited since the last pass. Then the space's trash is read the same way, and its pages are removed from the base. Archived pages are not read.
- A page's version is the time of its latest version.
- **Who may read.** A page counts as open to everyone only if the space allows anonymous reading and neither the page nor one of its ancestors (at most ten) is restricted. Anything else, including a group such as the site's own users, is "not everyone". In a team base such a page is left out and counted in `skippedLimited`.
- Limits per pass: 100 documents and 20 MB; one document at most 10 MB. Every 60 minutes unless set (15 to 10,080).
- Pages are converted from Confluence storage format to Markdown.

## Limits

The folder picker lists the spaces the grant offers, not pages inside a space. A source reads with the person's own sign-in. If the sign-in is lost the source pauses ("... is no longer connected") and what is indexed stays searchable.

## Proved against the stand-in only

- Atlassian's consent, the site list and refresh rotation for a second app.
- That the three scopes give every call the sync makes.
- Anonymous-access and restriction answers on a real site.
- The trash listing and cursor behaviour on a large space.

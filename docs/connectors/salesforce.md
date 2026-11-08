# Salesforce

Accounts, contacts and cases, as each person's own sign-in.

## What it does

A bot can find a customer, search cases, read a case, and (after approval) add a case comment or set a case status.

## Set up at Salesforce

1. In Setup, App Manager, make a connected app with OAuth turned on.
2. Add the callback `<site address>/api/me/connections/salesforce/callback`.
3. Add the scopes `api` and `refresh_token`. The app must allow them without a client-secret exception.
4. The workspace admin enters the org's address label (for example `acme` for `acme.my.salesforce.com`) with the client id and secret at Settings, Connections, Apps. Or set `MANYTHREADS_OAUTH_SALESFORCE_INSTANCE` on the server. Without either, starting the sign-in answers a plain 409.

## Services, scopes and why

One service, Records, ticked by default. The scopes are `api` and `refresh_token`. PKCE is used. Salesforce's refresh answer carries no new refresh token and no lifetime, so the tool refreshes after a 401. Adding a service asks again for earlier scopes.

## Tools

`salesforce.find_customer`, `salesforce.search_cases`, `salesforce.read_case`, `salesforce.add_case_note`, `salesforce.set_case_status`. Writes wait for approval. A case comment is always sent with `IsPublished: false`, so the customer never sees it. A record id is 15 or 18 letters and digits. Text typed into a search is quoted as a SOQL literal: the quote and backslash are escaped, and so are the `%` and `_` of a `LIKE`.

## Triggers

None.

## Sync

None.

## Limits

The label is one plain label (letters, digits, single hyphens, at most 63) and the host is built as `https://<label>.my.salesforce.com`. Sandboxes and custom domains are not built. Nothing deletes or merges.

## Proved against the stand-in only

- Consent and refresh with a real connected app, including the no-secret-exception rule.
- SOQL against a real org: `LIKE` escaping, and field-level security hiding `Description`.
- That `IsPublished: false` keeps a comment internal in a real org.

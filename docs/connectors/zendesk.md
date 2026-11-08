# Zendesk

Support tickets, as each person's own sign-in, and a work-app address that wakes a bot when a ticket is created.

## What it does

A bot can search tickets, read one, find a customer, and (after approval) add an internal note, reply to the customer, or set a status. The shipped Support responder starts from `ticket.created` when a lead makes a Work apps address named `zendesk` in the support channel.

## Set up at Zendesk

1. In Admin Center, Apps and integrations, APIs, OAuth clients, make a client. Use the redirect address `<site address>/api/me/connections/zendesk/callback`.
2. The workspace admin enters the Zendesk subdomain (for example `acme` for `acme.zendesk.com`) together with the client id and secret at Settings, Connections, Apps. Or set `MANYTHREADS_OAUTH_ZENDESK_INSTANCE` on the server. Without either, starting the sign-in answers a plain 409.
3. For triggers: make a Work apps address for Zendesk at the support channel's Integrations screen. In Zendesk make a webhook that points to it, and paste its signing secret into manythreads.
4. Make a trigger or an automation in Zendesk that calls the webhook when a ticket is created.

## Services, scopes and why

| Service | Scopes | Why |
|---|---|---|
| Tickets (read), ticked by default | `read` | search, read, find a customer |
| Tickets (write) | `tickets:write` | note, reply, status |

PKCE is used and the token request is JSON. Adding a service asks again for the scopes agreed before.

## Tools

`zendesk.search_tickets`, `zendesk.read_ticket`, `zendesk.find_customer`, `zendesk.add_note`, `zendesk.reply`, `zendesk.set_status`. Every write waits for approval. The card says whether the customer sees it (a reply does, an internal note does not) and holds the whole text, in pieces of at most 250 characters (at most eight), so the approver reads exactly what goes out. A text is capped at 2,000 characters and may hold no control or direction-override character. There is no field for recipients, authors or a private flag.

## Triggers

`ticket_created`. A bot's BOT.md has `- type: webhook`, `connection: zendesk` (the address's short name) and `event: ticket.created`. Zendesk signs with `X-Zendesk-Webhook-Signature` and `-Timestamp` (base64 HMAC-SHA256 of timestamp + body). A call older than 5 minutes is refused. A repeat is dropped for 7 days. The run starts with no asker, so it uses only the bot's own rights, never a person's sign-in.

## Sync

None. Tickets are read when asked.

## Limits

The subdomain is one plain label (letters, digits, single hyphens, at most 63). The host is built as `https://<label>.zendesk.com` and the label is checked again on every call, so nothing can point a call elsewhere. A ticket id is digits with no leading zero. A search phrase drops quotes and backslashes. Nothing deletes or merges. An error carries our words, an id and a status, never the words of a ticket.

## Proved against the stand-in only

- That `read` and `tickets:write` give every call the tools make, and that Zendesk accepts PKCE and the JSON token request.
- Zendesk's search relevance for a quoted phrase.
- A real webhook signature and its 5-minute window.
- Freshdesk is not built (it uses a personal API key).

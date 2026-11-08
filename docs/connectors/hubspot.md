# HubSpot

Contacts and notes in the CRM, as each person's own sign-in.

## What it does

A bot can find a contact, read one, and (after approval) add a note or set the lead status.

## Set up at HubSpot

1. In a HubSpot developer account make a public app.
2. Add the redirect address `<site address>/api/me/connections/hubspot/callback`.
3. Add the scopes `crm.objects.contacts.read` and `crm.objects.contacts.write`.
4. Give the client id and secret to manythreads at Settings, Connections, Apps.
5. For a work-app address: make one for HubSpot at the channel's Integrations screen and paste the app's client secret as the signing secret. The door checks the v3 signature, which covers the public address, so the server's public URL must be right or every call is refused with 401.

## Services, scopes and why

| Service | Scope | Why |
|---|---|---|
| Contacts (read), ticked by default | `crm.objects.contacts.read` | find and read |
| Contacts (write) | `crm.objects.contacts.write` | notes and lead status |

No PKCE. Tokens are renewed with a refresh token.

## Tools

`hubspot.find_contact`, `hubspot.read_contact`, `hubspot.add_note`, `hubspot.set_lead_status`. Writes wait for approval and show the whole text in the card. A contact id is digits with no leading zero.

## Triggers

None in the catalog. A HubSpot address works and delivers an event to a bot (`X-HubSpot-Signature-v3` and `X-HubSpot-Request-Timestamp`, base64 HMAC-SHA256 of `POST` + the public address + body + timestamp; 5 minutes), but no catalog trigger names it yet.

## Sync

None.

## Limits

Only contacts are covered. Deals and tickets are not built. A portal can rename its lead status values; the tool uses what the portal returns.

## Proved against the stand-in only

- Consent and refresh with a real app.
- The note association type (202) and lead status values on a real portal.
- The v3 signature against a real delivery.

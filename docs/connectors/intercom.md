# Intercom

Conversations with customers, as each person's own sign-in, and a work-app address that wakes a bot when a conversation starts.

## What it does

A bot can search conversations, read one, find a customer, and (after approval) add an internal note, reply to the customer, or change a conversation's state.

## Set up at Intercom

1. In the Intercom developer hub make an app, and turn on OAuth.
2. Add the redirect address `<site address>/api/me/connections/intercom/callback`.
3. In the developer hub choose what the app may do. Intercom has no scope parameter, so this is where the limit is set.
4. Give the client id and secret to manythreads at Settings, Connections, Apps.
5. For triggers: make a Work apps address for Intercom at the channel's Integrations screen. In the developer hub, add a webhook with that address for new conversations and paste the client secret as the signing secret.

## Services and why

There are two services (Conversations read, ticked by default; Conversations write), but Intercom tokens carry no scope. The split here is the person's own choice, and what the app can really do is what the developer hub allows. Tokens do not expire and have no refresh: a rejected token means "connect again". No PKCE.

## Tools

`intercom.search_conversations`, `intercom.read_conversation`, `intercom.find_customer`, `intercom.add_note`, `intercom.reply`, `intercom.set_state`. Every write waits for approval, with the same card rules as Zendesk (the whole text in pieces, 2,000 characters at most, and whether the customer sees it). A write first reads `/me` for the admin id, which Intercom wants on a reply, a note and a state change, and refuses to write if that answer is not a plain id. Every call sends `Intercom-Version: 2.11`.

## Triggers

`conversation_created`. Intercom signs with `X-Hub-Signature: sha1=<hex>` (HMAC-SHA1 of the body). It sends no timestamp in the signature, so the event time inside the body must be within 7 days.

## Sync

None.

## Limits

Conversation ids are letters and digits. Only the United States region is supported. Intercom's EU and Australia regions are not built. Nothing deletes or merges.

## Proved against the stand-in only

- The shapes of Intercom 2.11 search and reply.
- The admin id lookup on a real workspace.
- A real webhook signature.
- That the developer hub settings really limit a token.

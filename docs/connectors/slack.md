# Slack

A Slack app joined to manythreads.

## What it does

- A linked person can talk to their Personal bot in a direct message with the Slack app.
- A public channel can be joined to a Slack channel. Words posted by linked people show in the channel as that person with "via Slack", and what the channel says goes back to Slack.
- Only linked people are heard. Anyone else gets one plain sentence about how to link.

## Set up at Slack

1. At api.slack.com/apps make an app. Add the bot scopes `chat:write`, `channels:history`, `im:history` (and `groups:history` for private channels).
2. Install it to the workspace. Copy the bot token (`xoxb-...`) and, under Basic Information, the signing secret.
3. In manythreads, Settings, Chat apps, Slack: paste both and turn the switch on. The token is checked with `auth.test`.
4. In Slack, Event Subscriptions: paste the address shown on the page as the Request URL. Slack's first call is a `url_verification`; manythreads answers it with the challenge as plain text. Subscribe to `message.channels` and `message.im`.
5. Add the app to each Slack channel you want to join, then at the manythreads channel ask for a code and write `connect <code>` in that Slack channel.
6. Each person links with `start <code>` (or just the code) in a direct message to the app.

Slack swallows a message that starts with `/`, so commands are plain words: `connect`, `start`, `unlink`, `bot [name]`. A leading `/` or `!` also works.

## Credentials and why

The bot token sends (`chat.postMessage`). The signing secret checks every call: `X-Slack-Signature` is `v0=` plus HMAC-SHA256 of `v0:<timestamp>:<raw body>`, compared in constant time. A call whose `X-Slack-Request-Timestamp` is more than 5 minutes off is refused with 401.

## Tools

None.

## Triggers

A message arrives (`message_received`).

## Sync

Events come in as `event_callback` with a `message` event. A message with a `bot_id` or any subtype (edits, joins, bot posts, including our own) is skipped so nothing loops. A repeated `event_id` is read once. Out: `chat.postMessage` with `&`, `<` and `>` escaped, so a message cannot make a Slack mention or link. A 429 is retried after `Retry-After`. `invalid_auth`, `token_revoked` and `account_inactive` mark the account as needing attention.

## Limits

Plain text only (no files, cards or reactions). The app must be added to a channel before it sees it. At most 4,000 characters in. The wrong-code lockout is in memory per server replica.

## Proved against the stand-in only

- A real `url_verification` and a real signature.
- The scopes needed for private channels and for direct messages in a real workspace.
- Slack's rate limit tiers and message size limit.
- App distribution and Enterprise Grid.

# Microsoft Teams

An Azure bot joined to manythreads, through the Bot Framework.

## What it does

- A linked person can talk to their Personal bot in a chat with the Teams bot.
- A public channel can be joined to a Teams channel. Words posted by linked people show in the channel with "via Teams".
- Only linked people are heard. Anyone else gets one plain sentence about how to link.

## Set up at Microsoft

1. In the Azure portal make an Azure Bot (single tenant or multi-tenant). Note its application (client) id and make a client secret.
2. In manythreads, Settings, Chat apps, Teams: enter the application id and the client secret and turn the switch on. manythreads asks Microsoft for a token to check them.
3. In the bot's configuration paste the address shown on the page as the messaging endpoint, and add the Microsoft Teams channel.
4. Install the bot in Teams (a sideloaded app package, or your organisation's catalog).
5. Each person links with `start <code>` (or the code) in a chat with the bot. To join a channel: `@Bot connect <code>`.

In a Teams channel the bot only sees messages that mention it, so a command starts with the mention.

## Credentials and why

The client secret (stored as the account's bot token) lets manythreads get a token from `login.microsoftonline.com` to send. Teams calls the door with `Authorization: Bearer <JWT>`, and the JWT is the only proof. It is checked with `node:crypto` only:

- three parts of bounded size, algorithm exactly `RS256`, a `kid` found in the key set Microsoft publishes at `login.botframework.com` (the `jwks_uri` in a document is never followed);
- an RSA key of 2048 to 8192 bits, the signature, issuer `https://api.botframework.com`, audience equal to the bot's application id;
- `exp` and `nbf` with 5 minutes of clock difference, the `serviceurl` claim equal to the activity's `serviceUrl`, and a key endorsed for `msteams`.

Keys are kept 24 hours. An unknown `kid` causes at most one new look a minute. If Microsoft cannot be reached the held keys are used for up to a week more.

## Tools

None.

## Triggers

A message arrives (`message_received`).

## Sync

Replies are sent to `<serviceUrl>/v3/conversations/<id>/activities` as plain text. The `serviceUrl` comes from the activity, so it is hostile: a chat id is `<serviceUrl>|<conversation id>` and is made and later dialled only when the host is on the Microsoft list (`*.botframework.com`, `smba.trafficmanager.net`, https, no port, no credentials). Any other address is never contacted and the message from it is not stored. A 401 gets one new token and one retry. Activity ids are unique only inside a conversation, so the replay key includes the conversation. A mention of another person becomes their name; the bot's own mention is removed.

## Limits

Plain text only. Teams answers into the conversation it was asked in; there is no first message to a person who never wrote. A reply thread belongs to its channel as a whole. Microsoft's key cache is per server replica.

## Proved against the stand-in only

- A real Bot Framework JWT, real keys, and the endorsement check.
- The real list of Microsoft service hosts (regions, government clouds).
- Single-tenant versus multi-tenant bot tokens.
- Sideloading, and mention formats in real channels.

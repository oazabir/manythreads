# WhatsApp

A WhatsApp Business number joined to manythreads, for direct chats.

## What it does

A linked person can talk to their Personal bot from WhatsApp. WhatsApp here is direct chats with the number only: there are no group chats and no channel bridge.

## Set up at Meta

1. In Meta for Developers make an app with the WhatsApp product, and a WhatsApp Business account with a phone number. Note the phone number id, the permanent access token and the app secret.
2. In manythreads, Settings, Chat apps, WhatsApp: enter the access token, the app secret and the phone number id, choose a verify word, and turn the switch on. The page shows the callback address.
3. In the Meta console, WhatsApp, Configuration: paste that callback address and the verify word, and subscribe to `messages`. Meta checks the address once with a GET that carries the verify word; manythreads echoes the challenge only when the word matches and the challenge is a plain number or short token.
4. Each person: Account, Chat apps, WhatsApp, "Link", then sends the code (or `/start <code>`) to the number.

## Credentials and why

| Credential | Use |
|---|---|
| Access token | sends messages |
| App secret | checks `X-Hub-Signature-256: sha256=<hmac of the raw body>` on every call |
| Verify word | answers Meta's one-time address check |
| Phone number id | a call about another number is not read |

All sealed, never shown again.

## Tools

None.

## Triggers

A message arrives (`message_received`).

## Sync

Messages move as they happen. The 24-hour window: WhatsApp only allows a free-form reply within 24 hours of the person's last message. When the window is closed, the answer is kept as `waiting` and sent when they next write (at most 20 at once). Waiting rows older than 7 days are marked dead by the nightly purge.

## Limits

Direct chats only. Text only. At most 4,000 characters in. Same code rules as Telegram (10 minutes, once, a lockout after five wrong tries). A replay of an update id is ignored. The Graph API version is `v21.0`.

## Proved against the stand-in only

- Meta's real verification GET and signature on a real delivery.
- The 24-hour window as Meta applies it, and the template messages needed to open a conversation (not built).
- Real rate limits and error codes.
- Number registration and business verification.

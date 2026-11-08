# Telegram

A bot in Telegram joined to manythreads.

## What it does

- A linked person can talk to their Personal bot in a direct chat with the Telegram bot.
- A public channel can be joined to a Telegram group. Words posted in the group by linked people show in the channel as that person with "via Telegram", and what the channel says goes back to the group.
- Only linked people are heard. Anyone else gets one plain sentence saying how to link (at most once an hour per chat), and nothing of theirs is stored.

## Set up at Telegram

1. In Telegram, talk to @BotFather and make a bot. Copy the bot token.
2. In manythreads, Settings, Chat apps, Telegram: paste the token and turn the switch on. manythreads asks Telegram to send updates to its address (`setWebhook`) with a secret word, and shows the address.
3. Each person: Account, Chat apps, Telegram, "Link". Send `/start <code>` to the bot in a private chat (or just the 8-digit code).
4. For a group: at the channel's Integrations screen, tab Chat apps, ask for a code, add the bot to the group, and send `/connect <code>` there. A bot must be allowed to read group messages (turn off privacy mode with BotFather).

Other commands: `/unlink` and `/bot [name]` (private chats only).

## Credentials and why

The bot token sends messages. The secret word Telegram echoes in the header `X-Telegram-Bot-Api-Secret-Token` is the only proof a call is from Telegram. Both are sealed and never shown again.

## Tools

None. This is a bridge, not a tool source.

## Triggers

A message arrives (`message_received` in the catalog). A linked person's group message with a bot mention starts a run with that person as the asker.

## Sync

Messages are carried both ways as they happen. The door claims each update id first, so a replay is ignored. Messages out are queued per link, retried up to 3 times, and a 429 waits for `retry_after`. A message that itself came in over Telegram is not sent back to it.

## Limits

Only text is read (photos, voice, stickers are ignored). A message with files is sent out as text plus "N files attached in manythreads". Text is plain, with no formatting, at most 4,000 characters in. Five wrong codes from one chat in 15 minutes lock it for 15 minutes (per server replica, in memory). A code works once, for 10 minutes. The door reads at most 1 MB.

## Proved against the stand-in only

- A real `setWebhook` and the secret-token header.
- Telegram's real rate limits and `retry_after` values.
- Group privacy mode, supergroup ids and bot-added events.
- Messages with captions, edits and forwards.

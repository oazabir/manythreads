# slack-compat (SPIKE, P5-01)

Spike-only plugin: a Slack-shaped inbound door for the Hermes agent runtime. See the spike report
`docs/spikes/slack-compat.md` for the setup, the proof and the decision. This page documents what the
code does; nothing here is product API.

## Routes

- `POST /api/slack-compat/chat.postMessage` — **public** (no session). Body: `token` (a pairing token
  minted for the bot), `channel` (channel id), `thread_ts` (thread root message id, optional), `text`.
  The token is hashed and resolved through `app.bots_pairing_resolve`; unknown or revoked is 401.
  Answers `{ ok: true, channel, ts }` where `ts` is the delivery id (`meta.deliveryId` of the message
  that lands). Rate limit 60/min per client address. The route reads no channel rows (an anonymous
  transaction sees none through RLS): it validates the shape, resolves the token and enqueues.

## Jobs

- `slack-compat.deliver` — runs as SYSTEM. Re-validates everything (channel exists, belongs to the
  bot's team, not archived; thread root is a live root of the same channel; the bot actor row still
  exists), then inserts into `app.messages` with the bot as author, emits `channel.message.posted`,
  pushes `message.posted` to the channel audience and records unread state. Idempotent on
  `meta.deliveryId`; failures throw (retry, then dead-letter).

## Spike-only warnings

- The handler writes `app.messages` directly instead of going through the channels plugin. P5-10
  runtime work must reuse the channels behaviour, never copy this insert.
- `chat.postMessage` is Slack-shaped (`thread_ts`, `ts`) only so the Hermes adapter stays a thin
  POST; it is not a general Slack API.

## Loading

Not loaded by default. A real deployment loads it only with `MANYTHREADS_SPIKE_SLACK_COMPAT=1`; the test servers
(`testPlugins`) load it so its specs run (`SPIKE_PLUGIN_DIRS` in `packages/server/src/start.ts`). The job refuses a
bot that is not `active` and any channel that is not a public team channel (the spike has no membership check); the
idempotency lookup is scoped to the channel. P5-10 replaces this door and the plugin goes away with it.

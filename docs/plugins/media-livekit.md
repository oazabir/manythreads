# media-livekit

The default `provider.media` plugin (PLAN P15-02): it carries the audio of voice rooms through a self-hosted LiveKit server. Code: `packages/plugins/media-livekit`. The contract it fulfils is
`MediaProvider` in `packages/sdk/src/media.ts`; the plugin that uses it is [meetings.md](./meetings.md); the decision and what is not yet verified: [docs/spikes/voice.md](../spikes/voice.md).

## The provider contract

`createRoom`, `token(actor, room, grants, { ttlSeconds })` (at most 10 minutes, clamped inside the provider too), `closeRoom`, `kick(room, identity)`, `listen(room, options)` (optional; the listener below), `verifyWebhook(headers, rawBody)` (returns a
parsed notice or `null` for anything not signed correctly) and `status()` (`{ configured, provider, reason }`). Without configuration every call but `status` and `verifyWebhook` throws
`MediaNotConfiguredError`, which the meetings routes turn into a plain 409. `assertTokenRequest` is the one place that decides who may get a token: a person gets publish and subscribe; a bot gets
nothing, except the note-taker's and the recorder's listener whose token must subscribe only, never publish, and is hidden (`listenOnly`). A person asking for `listenOnly` is refused.

## How it talks to LiveKit

Written by hand with `node:crypto` and `fetch` (no LiveKit package):

- **Tokens**: HS256 JWT, issuer = API key, subject = actor id, `video` grant for one room (`roomJoin`, `canPublish`, `canSubscribe`, `hidden`, `canPublishData: false`).
- **Room API** (Twirp over HTTP, `/twirp/livekit.RoomService/CreateRoom | DeleteRoom | RemoveParticipant`) with a 60-second admin token. A room or person that is already gone counts as done.
  A failure becomes a plain message ("The media server did not answer." / "The media server refused our key."); the raw error, which may hold a key, is never passed on.
- **Webhooks**: LiveKit POSTs to `/api/meetings/media-webhook` with an `Authorization` JWT signed with the same key; its `sha256` claim must equal the base64 SHA-256 of the raw body. Wrong key, wrong body,
  expired token or `alg: none` is refused.

## The listener (P15-18, P15-19)

`MediaProvider.listen(room, { identities, onChunk, onClosed, listener? })` joins a room as a server-side, listen-only participant and hands back cut-up audio of the people it is told to hear. The note-taker
([meetings.md](./meetings.md)) and the recorder use it; nothing else does, and a bot's run has no call that reaches it.

- **Identity.** The listener joins as a hidden participant named `notetaker:<meetingId>` (the recorder: `recorder:<meetingId>`). It is deliberately not an actor id: the webhook handler drops any unknown actor id from
  a room, so a UUID-shaped identity would be kicked. Its token is made by the provider itself (`canPublish: false`, `canSubscribe: true`, `hidden`, `listenOnly`); the room's own check, `assertTokenRequest`, refuses
  a listen-only request from a person and a publishing request from a bot.
- **Worker.** One `worker_threads` Worker per room (`src/listener.ts` starts it, `src/listener-worker.ts` runs in it, `src/listener-core.ts` holds the decisions and is tested without a media server). The library
  `@livekit/rtc-node` (pinned, a prebuilt native module for linux-x64-gnu, so it loads on the `node:22-slim` server image) is loaded only inside the worker, and only when a listener is started, so the server starts
  and runs without it. The worker gets the media address, a token and the list of people, never the API key or secret; its heap is capped (192 MB). If it dies, `onClosed('error')` tells the meetings plugin,
  which starts another on its next sweep. It is a thread in the **server process**, not a separate deployment.
- **Who is heard.** A track is subscribed only when its owner is on the list; any other track is unsubscribed at once and not a sample of it is read. When the list changes, a person who left it loses their track
  immediately and what was buffered for them is discarded. The audio is cut at pauses by the energy detector in `packages/sdk/src/audio/vad.ts` (silence of 600 ms or more, at most 30 s a chunk, 16 kHz mono) and posted
  to the server thread as WAV chunks.
- **Address.** The worker joins from inside the server pod, so the chart sets `MANYTHREADS_LIVEKIT_LISTEN_URL=ws://manythreads-media:7880` (the service). Without it the worker would use the public `wss://…/livekit` name, which a pod behind the site's router may not reach; the sweep's warning then ends with the reason.
- **Limit.** At most `MANYTHREADS_NOTETAKER_MAX_ROOMS` (default 10, chart `media.noteTakerMaxRooms`) rooms with a note-taker per server process; the eleventh answers 409 "The note-taker is busy, try again in a minute."
  Recording has its own `MANYTHREADS_RECORDING_MAX_ROOMS`. Both counts are per server process; the live site runs one.
- **Fake.** `createFakeMediaProvider().listen` (in `packages/sdk/src/media.ts`, used by `media-fake`) records the subscriptions, keeps one listener per identity, and `POST /api/test/media/speak` (test servers only)
  delivers a WAV with the text after a `FAKEASR:` marker, answering `{ delivered: false }` when the person is not subscribed. `published()` stays empty: a listener never publishes.

What a real LiveKit does with the listener's token and the worker's subscription is a live check (P15-00).

## Settings (environment)

| Variable | Meaning |
|---|---|
| `MANYTHREADS_LIVEKIT_URL` | what browsers connect to, `wss://...` or `ws://...` |
| `MANYTHREADS_LIVEKIT_API_KEY` | the key |
| `MANYTHREADS_LIVEKIT_API_SECRET` | the secret, at least 32 characters |
| `MANYTHREADS_LIVEKIT_API_URL` | optional: the address the manythreads server uses for the room API when it differs from the browsers' (inside the cluster: `http://manythreads-media:7880`); derived from the public one when unset |

With any of the first three missing the plugin is "not configured" and says which. The settings are in the environment, not the admin screen, for now (a question for the owner).
The chart sets them when `media.enabled` is true and generates the key; the dev compose profile `media` starts a server for them (`deploy/compose/dev.env.example`).

## Tests

`packages/plugins/media-livekit/test/livekit.test.ts`: configuration, token claims and lifetime, the refusal of a bot's token, the calls it would make, the signed webhook, "not configured"; `listener-core.test.ts` (who is subscribed, what is discarded) and `listener.test.ts` (the worker protocol, with a fake worker file).
That a real LiveKit accepts them is a live-site check. `media-fake` (`packages/plugins/media-fake`) is the test-only provider used by the meetings tests; the server loads it only in tests.

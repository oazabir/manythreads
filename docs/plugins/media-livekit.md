# media-livekit

The default `provider.media` plugin (PLAN P15-02): it carries the audio of voice rooms through a self-hosted LiveKit server. Code: `packages/plugins/media-livekit`. The contract it fulfils is
`MediaProvider` in `packages/sdk/src/media.ts`; the plugin that uses it is [meetings.md](./meetings.md); the decision and what is not yet verified: [docs/spikes/voice.md](../spikes/voice.md).

## The provider contract

`createRoom`, `token(actor, room, grants, { ttlSeconds })` (at most 10 minutes, clamped inside the provider too), `closeRoom`, `kick(room, identity)`, `verifyWebhook(headers, rawBody)` (returns a
parsed notice or `null` for anything not signed correctly) and `status()` (`{ configured, provider, reason }`). Without configuration every call but `status` and `verifyWebhook` throws
`MediaNotConfiguredError`, which the meetings routes turn into a plain 409. `assertTokenRequest` is the one place that decides who may get a token: a person gets publish and subscribe; a bot gets
nothing, except the planned note-taker whose token must subscribe only, never publish, and is hidden (`listenOnly`). A person asking for `listenOnly` is refused.

## How it talks to LiveKit

Written by hand with `node:crypto` and `fetch` (no LiveKit package):

- **Tokens**: HS256 JWT, issuer = API key, subject = actor id, `video` grant for one room (`roomJoin`, `canPublish`, `canSubscribe`, `hidden`, `canPublishData: false`).
- **Room API** (Twirp over HTTP, `/twirp/livekit.RoomService/CreateRoom | DeleteRoom | RemoveParticipant`) with a 60-second admin token. A room or person that is already gone counts as done.
  A failure becomes a plain message ("The media server did not answer." / "The media server refused our key."); the raw error, which may hold a key, is never passed on.
- **Webhooks**: LiveKit POSTs to `/api/meetings/media-webhook` with an `Authorization` JWT signed with the same key; its `sha256` claim must equal the base64 SHA-256 of the raw body. Wrong key, wrong body,
  expired token or `alg: none` is refused.

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

`packages/plugins/media-livekit/test/livekit.test.ts`: configuration, token claims and lifetime, the refusal of a bot's token, the calls it would make, the signed webhook, "not configured".
That a real LiveKit accepts them is a live-site check. `media-fake` (`packages/plugins/media-fake`) is the test-only provider used by the meetings tests; the server loads it only in tests.

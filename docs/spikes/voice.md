# P15-00 decision record · voice rooms

Question (PLAN P15-00): which media server carries the audio of a voice room, how does it run next to manythreads, and what do we know today versus what only the live site can tell us?
Status: **decided, built in files, not run.** Nothing was installed or deployed for this record; the compose profile and the chart values are off by default.

## Decision

**LiveKit, self-hosted, as a selective forwarding unit (SFU).** An SFU receives each person's audio once and forwards it to the others without mixing it, so a room of 10 costs the
server 10 uploads and 90 small downloads, not a mixing job. It is open source (Apache 2.0), has a browser SDK, a server API with signed tokens and signed webhooks, and a built-in TURN relay.

manythreads does not depend on LiveKit's code. The SDK has a `provider.media` kind (`packages/sdk/src/media.ts`): create a room, mint a token, close a room, drop a person, read a signed
notice. The `media-livekit` plugin is the default implementation. A different media server is a different plugin; `MANYTHREADS_MEDIA_PROVIDER` names which one loads (`livekit` by default).

Why not the others, in one line each: a mesh of browser-to-browser calls (WebRTC peer to peer) breaks past about 4 people and cannot be kicked or recorded by the server; a hosted service
(LiveKit Cloud, Twilio) puts the company's meetings on a third party, against the self-hosted promise; Jitsi brings its own web app and accounts, which would be a second sign-in.

## What it takes to run (the shape, from LiveKit's documentation)

| Need | Value | Where it is written |
|---|---|---|
| Signalling and room API | TCP 7880, plain HTTP/WebSocket; TLS is done by the ingress or load balancer in front of the public `wss://` name | compose `livekit` service; chart `media.yaml` Service `manythreads-media` |
| Audio over UDP | a range, default **50000 to 50100** (100 ports); one port carries many people, widen the range only for hundreds | `media.rtcPortStart` / `rtcPortEnd` |
| Audio over TCP | 7881, for networks that block UDP | `media.rtcTcpPort` |
| TURN over TLS on 443 | a relay for networks that allow only HTTPS: LiveKit's TURN on its own name (`media.turn.domain`), TLS ended by the load balancer (`external_tls`), forwarded to `media.turn.tlsPort` (5349). It cannot share the web name's port 443 with the website; it needs its own name or its own address. | `media.turn.*` |
| Node network | the pod runs on the node's network (`hostNetwork`), because a Kubernetes Service cannot carry a UDP port range to one pod efficiently and the server must advertise the node's real address | chart `media.yaml` |
| Health | `GET /` on 7880 answers 200 when the server is up (readiness and liveness probes); `GET /api/meetings/media-status` on manythreads says "set up" or why not | chart, `packages/plugins/meetings` |
| Keys | one API key and secret, generated once into the Secret `manythreads-media-secrets` (kept across upgrades), given to both LiveKit and the manythreads server | chart `media.yaml`, `server.yaml` |
| Webhook | LiveKit calls `POST /api/meetings/media-webhook` with a signed header; the body hash is inside the signature | `packages/plugins/meetings/src/webhook.ts` |

### Tokens

A person's token is a short HS256 token: issuer = API key, subject = the actor id, one room, `canPublish` and `canSubscribe`, **at most 10 minutes** (`MEDIA_TOKEN_MAX_SECONDS = 600`,
clamped again inside the provider). The browser renews it through `POST /api/meetings/:id/token`, which checks that the person is still in the room and still may read the channel.
A bot never gets a token of its own; the one exception planned for P15-18 is the note-taker's server participant, a hidden, listen-only token the meetings plugin mints itself
(`assertTokenRequest` refuses every other bot token, and refuses `listenOnly` for a person).

### Kicking

`channel.member.removed` or `team.member.removed` makes the meetings plugin drop the person from the room and call the media server's `RemoveParticipant`, then the token renew answers 404.
A webhook saying a person joined who is no longer in the room (they held an unexpired token) kicks them again. A once-a-minute sweep catches anything the events missed. Target: 5 seconds
(proved in the test with the fake provider; the real figure includes LiveKit's reaction time, see below).

## Verified here (tests, no network)

- The LiveKit provider builds the right tokens (claims, 10-minute cap, hidden listen-only for the note-taker), signs and checks webhooks (wrong key, wrong body, expired, `alg: none` refused), makes the
  right room-API calls with short admin tokens, and says "not configured" without touching the network: `packages/plugins/media-livekit/test/livekit.test.ts`.
- The meetings plugin end to end against a deterministic fake provider: start, get-or-create, join, leave, end, auto-end after two empty minutes, rate limits, authorisation, bots refused, the 5-second kick
  after removal from a channel or team, the webhook (bad signature answers 401 and changes nothing): `packages/plugins/meetings/test`.
- The schema: forced row-level security, who sees a room, one live room per channel, who may end a room: `packages/plugins/meetings/test/rls`.
- The chart renders with the media server off (nothing changes) and on, `helm lint` passes, and the compose file parses with and without the profile.

## Deferred to the live site (not verified, and why)

1. **A real LiveKit server accepts our tokens and our room-API calls.** Written from LiveKit's published token format and Twirp API; no server was started here. Check: `docker compose ... --profile media up -d livekit`,
   then start a room and join from two browsers. If a field name is wrong the Twirp call answers 400 and the status page says "The media server refused our key."
2. **The real webhook signature.** LiveKit signs the webhook body with a token whose `sha256` claim is the base64 SHA-256 of the raw body. Checked against the documented format only.
3. **UDP and TURN reachability.** Whether the node's firewall and the cloud network let 50000-50100/udp and 7881/tcp through, and whether TURN over TLS works from a network that blocks UDP, can only be tried from outside.
4. **Browser audio**: echo, noise, device pickers, reconnect after a network drop. That is P15-04 (web).
5. **The 5-second kick against the real server** (our side takes milliseconds; LiveKit's `RemoveParticipant` should be immediate).
6. **The content-security policy.** `deploy/docker/nginx.conf` allows `connect-src 'self'` only. The browser must be allowed to open `wss://<media name>` and (for the media SDK's workers) `blob:`; this belongs to P15-04 when the web client first connects.
7. **P15-00 part (b), the live-microphone speech measurement (60 minutes, real-time factor, heat, memory, caption delay).** Needs a person with a microphone and a browser; it belongs with the speech work (P15-05 onward).

## How to turn it on (for the owner, once the live checks above are planned)

- Compose (dev): `docker compose -f deploy/compose/docker-compose.dev.yml --profile media up -d livekit`, then set the `MANYTHREADS_LIVEKIT_*` variables in `deploy/compose/dev.env.example`.
- Chart: `media.enabled=true`, `media.publicUrl=wss://<name>`, open the UDP range on the node, put a TLS-terminating route for `<name>` to the Service `manythreads-media:7880` (the ingress does not carry it by itself yet).
- Both off by default; with them off nothing changes and a voice-room start says "not set up".

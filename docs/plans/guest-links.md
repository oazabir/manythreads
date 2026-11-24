# Guest links and a waiting room (P17-04)

Rows: P17-04 (pulled forward 2026-11-10), the switch of P15-25, "Copy guest link" of P15-26, Invite more of P15-27. Plugin `packages/plugins/meetings`, media
`packages/plugins/media-livekit`, web `clients/web/src/meetings` and a new public page. A **link guest** is someone outside the workspace with no account: not a
workspace guest (role `guest`, P14, a person row with channel grants). A link guest gets one call, never a channel.

## Findings that shape the plan
- `/join/<id>` is taken (`App.tsx`, planned rooms, needs a session): the guest page is `/join/g/<token>`, outside the sign-in check.
- A link kept only as a hash cannot be shown again, and `ctx.secrets` may never be returned by a route: **each member gets a link of their own**.
- Three rules count only `app.meeting_participants` and must count admitted guests: recording's "everyone present said yes" (`recording.ts`), `guestsIn` for
  memory's `hold: 'external'` (`memory.ts`), the room size (`assertRoomHasSpace`, `limits.ts`).
- The media webhook ignores identities that are not uuids (`webhook.ts`): `guest:<uuid>` must be handled (kick if not admitted, mark left).
- The LiveKit token already has `canPublishData: false`; it gains allowed sources and `canUpdateOwnMetadata: false`.
- The CSP (`deploy/docker/nginx.conf`) has `connect-src 'self'`: check how the media server is reached before the guest page relies on it.

## What a member sees
- **Start dialog** (`StartCallDialog.tsx`): "Let people outside the workspace join with a link", off by default; disabled with the server's reason in a DM, when the
  workspace switch is off, for a workspace guest, or with no media server. The start body sends `allowGuests: true`; the first link is made in the same transaction and
  its address returned once; the dialog copies it ("Guest link copied").
- **Call card** (`VoiceRoomCard.tsx`), live with links on, for readers who may post: **Copy guest link** (this member's own link, kept in `sessionStorage` per meeting,
  or a new one). The starter, a lead or an admin also gets **Turn off guest links** (revokes every link of the call). Readers see "+1 guest", never the guest's name.
- **Invite more**: a "Guest link · Copy" row under the checklist.
- **Expiry**: a link works while the call is live, at most 12 h, at most 50 uses; ending the call revokes every link. Revoked, expired, used up and unknown links get
  the same answer.

## The guest's page (`/join/g/<token>`, no account)
1. "Join *Design review* · Acme" (the call title and the workspace name; never the channel or the people before admission), and "This call is being transcribed for
   the team / a note-taker is listening. Your own voice is not written down." when true.
2. **Name** (1–60 characters, `stripHostileText`), a **device check** (microphone meter, camera preview, pickers, mic/camera on or off), **Ask to join**.
3. "Waiting for the host to let you in…" with Cancel; then admitted (the call opens), "The host did not let you in.", "The call has ended.", or after 10 minutes
   "Nobody answered. Try again."
4. In the call: tiles with names, mute, camera, leave; "You were removed from the call." ends it (the credential is dead).
Code in `clients/web/src/guest/` (`GuestJoinPage.tsx`, `guestController.ts`, `api.ts`) inside `AuthFrame`, with `FullPageMessage` and `ExpiredLinkPage` (kind
`guest`); reuses `MediaAdapter`/`loadAdapter`, `AUDIO_DEFAULTS`, `CallStage` (props where a field needs a session), `sounds.ts`; not `controller.ts` or `store.ts`.

## What a guest can and cannot do
- **Can**: publish microphone and camera, hear and see everyone, see the people's display names in the room. Their name shows as "Ana (guest)", set by the server.
- **Cannot**: share a screen (step 1), post or read the call thread or any channel, message or file, send data messages, see transcript, captions, notes or recording,
  see avatars, handles or emails, invite or admit anyone. No session route answers a guest credential.
- **Consent**: step 1 — a guest is never transcribed or recorded: the note-taker's listener subscribes only to consenting actor ids; `recording.ts` counts an
  admitted guest as present with "no", so recording pauses ("Recording paused while a guest is here"). Step 2 — the P15-05 prompt for the guest, on-device only.
- **Memory**: a call with an admitted link guest is held for a lead (`hold: 'external'`).

## Data (`meetings/0012_guest_links.sql`; Zod and mapper in the same diff)
- `meeting_settings.guest_links_allowed boolean DEFAULT true` (workspace switch, `GET/PUT /api/workspace/meetings-settings`); `meetings.allow_guests` exists.
- `app.meeting_guest_links (id, meeting_id cascade, channel_id, team_id, workspace_id, token_hash bytea UNIQUE (sha-256 of 32 random bytes; the address is 43
  base64url characters), created_by, created_at, expires_at, max_uses 1–100 default 50, uses, revoked_at, revoked_by)`; at most 10 live per call. RLS forced; channel
  readers select via `app.visible_channel_ids('read')`; `token_hash` not granted to the app role; writes only through definers `app.meetings_make_guest_link`,
  `app.meetings_revoke_guest_links`, `app.meetings_guest_link_redeem(hash)` (locks, checks live, unexpired, unrevoked, uses left, adds a use).
- `app.meeting_guests` (durable: the record of who was there): `id` (media identity `guest:<id>`), `link_id`, `meeting_id`, `workspace_id`, `display_name`,
  `credential_hash bytea UNIQUE`, `state` (`waiting`, `admitted`, `denied`, `removed`, `left`, `expired`; shared z.enum + ENUM_COLUMNS), `asked_at`, `decided_at`,
  `decided_by`, `joined_at`, `left_at`. No IP stored. Writes only through definers (admit, deny, remove check the caller is in the call).
- `app.meeting_guest_presence` (UNLOGGED: heartbeat); the sweep expires a waiting guest silent 60 s and drops an admitted one silent 3 min.
- A guest is not an actor; participants, segments and presence stay actor-only.

## The token flow
1. `GET /api/guest-links/:token` (public): `{state:'open', workspaceName, title, kind, transcribing, notetaker}` or 404 "This guest link has expired or was turned off".
2. `POST /api/guest-links/:token/knock {displayName}` (public): redeem, a `waiting` row, cookie `mt_guest=<guestId>.<secret>` (HttpOnly, Secure, SameSite=Strict,
   Path=/api/guest, Max-Age = the link's expiry), limited to that one meeting.
3. `GET /api/guest/session`: state, title, kind; polled every 2 s waiting, 10 s in the call (plugin sockets need a session).
4. `POST /api/guest/token` only while `admitted` and live: `media.token({id:'guest:<id>', kind:'guest', displayName:'<name> (guest)'}, meeting.id, {canPublish,
   canSubscribe, sources:['microphone','camera']})`, room = meeting id, TTL ≤ 10 min, renewed by calling again; LiveKit `canPublishSources`, `canPublishData: false`,
   `canUpdateOwnMetadata: false`. `MediaActor.kind` gains `'guest'`, `MediaGrants` gains `sources`; `assertTokenRequest` refuses a guest token that is listen-only,
   has no sources, or includes screen sharing.
5. `POST /api/guest/leave`, `POST /api/guest/heartbeat`.
- Members: `GET /api/meetings/:id/lobby`; `POST /api/meetings/:id/guests/:guestId/admit|deny|remove`; `POST|DELETE /api/meetings/:id/guest-links`. Admit runs
  `assertRoomHasSpace` counting admitted guests (409 "The call is full"); remove kicks `guest:<id>`.
- Webhook: a `guest:<uuid>` that joins without being admitted is kicked; one that leaves is marked `left`. Call end: guests `left`, links revoked. Guests do not keep a
  call alive (`empty_since` counts people only).
- CSRF: guest routes check `Origin` equals `publicUrl`, besides SameSite=Strict.
- Shared: `packages/shared/src/api/meetings/guests.ts`; `allowGuests: z.boolean()`; `guestLinks: {available, reason}`; `MeetingGuest` in `entities/meeting.ts`; the
  meeting summary gains `guests` (id, identity, name) for tile labels.

## Abuse limits
Public routes per address (`rateLimitBy: 'address'`, listed in `ABUSE_ROUTES` and `docs/deploy/rate-limits.md`): peek 30/min, knock 10/min, session 120/min, token
30/min, leave and heartbeat 60/min; 20 refused tokens per address in 15 min lock it out for 15 min (`createLockout`). Per link 20 knocks/min; per call at most 10
waiting and 3 from one address; members: links 10/min, admit/deny/remove 60/min. `packages/server/test/abuse.test.ts` bursts each.

## Audit and events
Events (ids and times only, never a name): `meetings.guest_link.created`, `meetings.guest_link.revoked` (reason person|ended), `meetings.guest.asked`, `.admitted`,
`.denied`, `.removed`, `.left`. Audit mappers for created, revoked, admitted, denied, removed. Contract test in `phase15-meetings-contracts.test.ts`.

## The waiting room in the call
A knock pushes `MEETING_LOBBY_PUSH {meetingId}` to the people present; `store.ts` fetches the lobby; `CallDock` shows "Ana is waiting · Let in · Deny" (a soft knock
sound), or "3 waiting" opening the list; whoever answers first wins. Nobody outside the call is told.

## Web routes and CSP
`App.tsx`: `/join/g/:token` beside `/invite/:token`, outside `RequireSession` and `Shell`, lazy-loaded. `nginx.conf`: `location ^~ /join/g/` serving `index.html` with
the app's CSP plus `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`, no access log (the address carries the secret). After the knock
the page replaces the address with `/join/g/`.

## Phone (390 px)
Guest page one column (16:9 preview, full-width name and Ask to join); in the call a stacked stage and a bottom bar; members see the lobby row first in the call sheet.

## Tests
RLS (hashes unselectable, non-readers see nothing, a workspace guest cannot make a link, anonymous sees nothing, direct writes refused); routes with fake media and an
injected clock (who may make links, switch off, DM, archived; knock, wait, admit, token; deny and remove then refused; cookie replay after deny, remove, end; expiry,
max uses, revoke all the same 404; lobby caps; full room; Origin check and cookie flags; webhook kick); grants (identity, kind, sources, room, TTL ≤ 600, no data;
JWT claims decoded in media-livekit tests; `assertTokenRequest` refusals); rules (recording pauses, listener never lists a guest, memory hold, abuse); web
(`guest-page.test.ts`, `buildStartBody`); e2e `e2e/meetings/guest-link.spec.ts` (two members and a context with no session, desktop and 390: start with the switch,
copy, wait, admit, the "(guest)" tile, the guest's `/api/channels/...` is 401, remove, revoke then 404, end); unpend Lena's L4 step.

## Order of work
1. **Links, waiting room, guest audio and camera**: server (migration, schemas, SDK and LiveKit grants, guest and member routes, webhook, the recording, memory and
   room-size fixes, events, audit, limits), web (dialog switch, Copy and Turn off on the card, Invite more row, the lobby row, `/join/g/:token`, nginx), tests, docs.
   Guests are never transcribed or recorded.
2. **Guest consent and polish**: the P15-05 prompt for guests with on-device transcription (migration: `meeting_segments.guest_id`), transcript lines "Ana (guest)";
   a "Guest links (n)" list with revoke per link; journeys, baselines, live check.

## Decisions taken (recommended defaults; the owner may change them)
1. One link per member, stored as a hash only. 2. No screen sharing for guests in step 1. 3. The guest page shows the call title and the workspace name, never the
channel or who is in the call before admission. 4. Private channels yes, DMs no. 5. Any member present in the call (not a workspace guest) may let a guest in.
6. Turning links off does not drop guests already in; Remove does. 7. The workspace switch is on by default; an admin can turn guest links off.

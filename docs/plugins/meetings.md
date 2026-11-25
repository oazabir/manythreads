# meetings

Voice rooms, their transcripts, notes and note-taker (PLAN P15-01 to P15-24): a person starts a voice room in a channel, others join, and the room ends when someone ends it or two minutes after the last person left.
This page is the backend (rooms, who is in them, the routes, the jobs, the events), how words get into a transcript, where the transcript and the notes live, the note-taker and sharing. Code:
`packages/plugins/meetings`. Schemas: `packages/shared/src/entities/meeting.ts`, `api/meetings`, `events/meetings.*.ts`. The audio itself is carried by a `provider.media` plugin
([media-livekit.md](./media-livekit.md)); words from audio on the server come from [asr.md](./asr.md); decision record: [docs/spikes/voice.md](../spikes/voice.md). `dependsOn` channels, files and bots.
The web part is in `clients/web/src/meetings` (the call bar) and `clients/web/src/screens/meetings` (the meeting page).

## What a person gets

- **Start** in a channel (`POST /api/channels/:channelId/meetings`): whoever may post there. One live room per channel: starting while one is live returns that room (`created: false`) and joins the person to it.
  The title defaults to "Call · #dev · 14:02" in a channel and "Call · 14:02" in a direct message (UTC). The start may also ask people and add the note-taker (see
  [Starting a call and inviting people](#starting-a-call-and-inviting-people-p15-25-p15-27)). A **call thread** is created at the same time, a message in the channel the room points at (`threadRootId`); people in the call reply there with the
  channel's own messages, files and @mentions. That message is the call's **start message** and carries the call card (see [The call card](#the-call-card-p15-26)); if it cannot be written the start fails
  with a plain reason and nothing is left behind. `kind` is `audio` (the default); `video` answers 409 "Video calls are not available yet" until P17-01. A call in a direct message is a room in the DM's
  channel (`teamId` is null; only that conversation sees it).
- **Join** (`POST /api/meetings/:id/join`): a person who can read the channel. The answer holds the media address and a token that lives at most 10 minutes. A room takes 25 people unless an admin changes `room_cap` (2 to 100); the 26th person gets 409 "This voice room is full (25 people)".
- **Renew the token** (`POST /api/meetings/:id/token`): only while the person is in the room and can still read its channel.
- **Leave** (`POST /api/meetings/:id/leave`), **heartbeat** every 30 seconds while in the room (`POST /api/meetings/:id/heartbeat`, optionally `{ speaking }`).
- **End** (`POST /api/meetings/:id/end`): the starter, a lead of the room's team, or a workspace admin. Everyone in the room is dropped. An admin who cannot read a private channel cannot end its room
  (the database function checks that the caller could read it); a call in a DM can be ended only by the person who started it (a DM has no team lead).
- **Cards**: `GET /api/meetings/cards?ids=<id>,<id>` (at most 50, 120 a minute): what the call cards of these calls show (see [The call card](#the-call-card-p15-26)).
- **Look**: `GET /api/meetings/:id`, `GET /api/teams/:slug/meetings?state=live|ended` (a team's live rooms), `GET /api/meetings/live` (the live rooms the caller can see), `GET /api/meetings/media-status`
  (`{ configured, provider, reason }`).
- **Not set up**: with no media server configured, start, join and token answer **409** with "Voice rooms are not set up" and a plain reason, and write nothing. Everything that only reads still works.

A bot cannot start, join, leave or end a room (403); no session is 401. A bot never gets a media token.

## Tables (migration `0001_meetings.sql`, namespace `meetings`)

All forced row-level security with a `rls:` comment; the system role has `FOR ALL` on each.

- `meetings`: team (nullable for a DM call), channel (cascade), title (one line, at most 200), `state` `live`/`ended`, `started_by`, `organizer_id`, `notetaker_bot_id`, `started_at`, `ended_at`, `ended_by`,
  `end_reason` `person`/`empty`, `transcription` `off`/`on_device`/`server`, `recording`, `empty_since`, `thread_root_id`. Migration 0003 adds `notetaker_by` and `recording_by`. A partial unique index allows one `live` room per channel.
  Read: whoever reads the channel. Insert: a person who may post in the channel, as themself; the trigger fixes state, settings and times. A direct `UPDATE` of state is refused by the guard trigger:
  a room ends only through `app.meetings_end(meeting, reason)`.
- `meeting_participants` (PK meeting + actor): who is or was in the room, their name copied at join, `first_joined_at`, `joined_at`, `left_at`, consent to transcribe and to record (`yes`/`no`/`unasked`, the
  person's own answer). Insert: the person themself, people only (a bot is refused by the trigger), into a live room they can read. Update: their own row (leave, come back, consent).
  A trigger keeps `meetings.empty_since`: set when the last person leaves, cleared when anyone is in.
- `meeting_segments`: transcript lines (meeting, speaker, `start_ms`, `end_ms`, text, `final`, `lang`, `source` `device`/`server`, `client_seg_id`, `edited_at`). A person inserts their own `device` lines while present; the server inserts `server` lines (the fallback upload, the note-taker, a voice message in the call thread) as the system. A line is accepted until two minutes after the room ended (`MEETING_LATE_LINE_SECONDS` 120). A line is changed only by its speaker through `app.meetings_correct_segment` (24 hours). One line per `(meeting, speaker, client_seg_id)`. Trigram index on the text, BRIN on `created_at`.
- `meeting_presence` (**UNLOGGED**): the heartbeat, `seen_at` and `speaking`. A person writes and reads only their own row. It may be lost in a crash; the sweep then waits for the next heartbeat.

## The call card (P15-26)

The words used here: a **stamp** is a key in a message's `meta` that only the platform may set; the **start message** is the channel message a call posts when it opens.

- **The stamp.** A new call's start message is `Started a call: <title>`, posted through the `messages` provider with `meta.meeting = { meetingId }` and `skipRefs` (the title links and notifies
  nobody). It is written once and never rewritten: the card reads the title, state and people from the cards route, so the message never changes with the call. The web draws the card in place of
  the text of any message with `meta.meeting`. A person's post takes no `meta`, no bot capability carries it, and a caller cannot change `meta` afterwards (channels 0017), so only the start route
  sets it. The database checks it as well, whoever inserts (`app.messages_meeting_stamp`, migration `0007_call_card.sql`, a trigger that runs as the caller and only for a message whose `meta` has
  the key): the meeting is live, in the message's channel, started by the message's author, has no start message yet, and the message is top-level; anything else is refused with 42501, a value
  that is not exactly `{ "meetingId": "<uuid>" }` with 23514. A unique index (`messages_meeting_card`) keeps one card per call.
- **The thread.** `meetings.thread_root_id` is set by the starter once, from nothing to the message stamped with that meeting (the `meetings_guard` trigger). It may still go back to nothing:
  deleting the message sets it to null through the foreign key. A deleted start message leaves the call running without a card, and the "Missed call" job of a DM call then writes nothing.
- **Order of a start.** Every database write comes first (the started event, the stamped message, the thread, the starter's place, a planned room's "started", the ring of a DM call), and the
  media room is asked for last, just before the token: the media room lives outside the transaction, so a start the database refuses leaves no media room. The join route of a planned room
  (`POST /api/scheduled-meetings/:id/join`) starts through the same code.
- **Old start messages.** Migration 0007 stamped the "Started a voice room:" messages written before it, only where the message is the starter's own top-level message in the call's channel (the
  old guard let a caller point the thread at any message); one message shared by two meetings is stamped for the earlier one. A `meta`-only update keeps no version and sends no event or push.
- **`GET /api/meetings/cards?ids=`** reads the meetings and their people through the caller's own row policies, so a call in a channel the caller cannot read is left out of the answer (never an
  error). Each `CallCard`: `meetingId`, `kind`, `title`, `state`, `startedBy`, `starterName`, `startedAt`, `endedAt`, `durationSeconds` (null while live), `present` (the first five in the call
  now) and `presentCount`, `joinedCount` (everyone who was in it), `invited` (`{ count, names }`; empty until invitations, P15-27), `notetaker` (`{ name, listening }` or null), `you`
  (`joined`: in the call now; `canEnd`: the starter, a lead or an admin, while live; `canInvite`: may post in the channel, while live) and `notesLink` (the meeting page, `/t/<team>/meetings/<id>`
  or `/meetings/<id>`, only when `app.meetings_can_read_notes` says yes and the notes are written). The team's slug, the bot's name and whether the notes are written are read as the system,
  for calls the caller has already read. `meetings.meeting.started` carries the call's `kind`.
- **The web** (`clients/web/src/meetings/VoiceRoomCard.tsx`, `callCards.ts`, `roomCard.ts`). A stamped message draws, in place of its text and without the author's picture and
  name, the call card while the call is live (title; Audio; Live with the running time; "Started by Nadia · 14:02"; up to five faces and "+N"; "Note-taker listening"
  while the bot listens; Join call, which the whole card also does, or "You are in this call"; End call for the starter, asked once) and, once it is over, one muted
  event line: "Omar started a call · 22:14 · 14 min · 3 joined", with Notes when `notesLink` is given. Until its card arrives (or for a call the reader may not
  read) the row draws "Omar started a call · 22:14" in the same one-line slot, so it never changes height. The page asks for the cards of the stamped messages it
  draws, 100 ms of them in one request, and asks again for one call on its `meeting.changed` push, when the socket comes back, and when a call drawn as live leaves
  the live list. A stamped message never joins a run of its author's messages, cannot be edited, copies the card's line as its text, and is drawn the same way at the
  top of its thread. The same muted line is used for other status lines (a to-do list that moved). A start message without a stamp keeps P33's card under its text,
  from the live list, until step S7 of `docs/plans/calls-card.md`.

## Jobs

Queues the plugin registers (all run on the server; the ones marked "detached" do not hold the request that queued them):

| Queue | What it does |
|---|---|
| `meetings.autoend` | two minutes after the last person left: ends the room if it is still empty (database clock) |
| `meetings.sweep` (every minute, detached) | drops people silent for 3 minutes, drops people who can no longer read the channel (`kicked`), ends any room empty for 2 minutes (the net under a lost autoend job) |
| `meetings.ringend` | 30 seconds after a direct-message call started with nobody else in it: a "Missed call" message |
| `meetings.transcript` | 2 min 10 s after the end (and again, debounced 30 s, after a correction): writes `transcript.md` |
| `meetings.notes` | the Scribe's notes for a room without a note-taker, then the memory filing |
| `meetings.notetaker.announce` | the line in the call thread when a note-taker is added or removed (or added as the call starts: "Note-taker takes notes in this call. …") |
| `meetings.listener.start`, `meetings.listener.sweep` | start the note-taker's listener after the change is committed; the sweep starts one for a room that has a note-taker and no listener in this process (after a restart) |
| `meetings.notetaker.notes` | notes of a room that had a note-taker (written into the organizer's Personal folder) |
| `meetings.question` | a question put to the note-taker: the check, then the answer |
| `meetings.recorder.start`, `meetings.recorder.sweep` | recording (see "Recording") |

## Starting a call and inviting people (P15-25, P15-27)

An **invitation** says who is told about a live call: an inbox item and a push from the notifications plugin. It never decides who may join, which stays "whoever can read the channel".

- **The dialog's options** (`GET /api/channels/:channelId/calls/options`, 60 a minute, `invites.ts`): `canStart` (false with a reason for a person who may not post: "Guests cannot start a
  call here" for a guest, "This channel is archived, …", or "You cannot start a call in this channel"; also false with the media server's reason when none is set up), `directMessage`, the
  `defaultTitle`, the `live` call if one is going (the dialog joins it), `people` (the readers of the channel, `app.channel_audience`, named through the caller's own view of `people`, the caller
  first with `you: true` and always there; a guest sees only themself; empty when the caller may not post; at most 200, `peopleTotal` says how many match, and `?q=` narrows them
  on the server to names with a word starting with it or handles, the e-mail address, starting with it), `notetaker` (the eligible bots, the first as `defaultBotId`, and whether one could be added now:
  the media server and the place, that is the workspace and team switches, transcription, a speech model and the server's room for one more, without the room checks; with the reason when not)
  and `guestLinks` (`available: false`, "Guest links are not available yet", until P17-04). Not read-only: the team's TEAM.md is read.
- **The start body** grows, every field optional (`{ title }` still works): `kind`, `inviteeIds` (at most 100), `allowGuests` (only `false`, until P17-04; `true` is a 400) and
  `notetakerBotId`. One transaction, in this order: the call, the started event, the stamped start message, the thread, the starter's place, the invitations
  (`app.meetings_invite`, then `meetings.invite.sent` with `first: true`), the note-taker (`addNotetaker` with `atStart`: the same checks as the add route, no "asked again" consent event,
  since only the starter is there and was never asked), a planned room's `onCreated`, the DM ring, and only then the media room. Any refusal (a person who cannot read the channel, 403 "You cannot
  invite these people to this call." — the database's own words are never forwarded, each known refusal has a fixed sentence; a note-taker that cannot come, 409 or 403 with the reason) undoes the whole start, so no call, card, invitation, event or media room is left.
  The answer's `invited` is how many were asked. Starting while a call is live only joins it: nobody is invited, no note-taker is added, `invited: 0`. In a direct message `inviteeIds` are
  not used: everyone in the conversation is rung, and the ring is the invitation.
- **Invite more** (`POST /api/meetings/:meetingId/invites` `{ personIds }`, 1 to 100, 20 a minute): a live call with a channel, by whoever may post in it (a reader of a private
  channel who is not in it finds no call, 404). `meetings.invite.sent` with `first: false`, then the `meeting.changed` push. 409 in a direct message and for an ended call. Answers the people
  newly asked.
- **`app.meeting_invites`** (migration 0008): one row per call and person asked, with the name copied when asked, who asked and when, and the call's channel (a composite foreign key on
  `meetings (id, channel_id)`, so the row is always in its call's channel). Readable by whoever reads the channel; nobody writes it but `app.meetings_invite` and the system role (a direct
  INSERT is 42501). `app.meetings_invite(meeting, person ids)` is a definer owned by the system role, so it checks the caller by `session_user` and the caller's own rights
  (`app.lookup_channel_can(…, 'post')`), never `app.is_system()`, which is always true inside it. It refuses a call with no channel, in a direct message, or that has ended, more than 100 ids, and the whole
  list when any id is not a reader of the channel now; it leaves out the caller and the people asked before and returns the new ones.
- **On the card** (`GET /api/meetings/cards`): `invited.count` and the first five `invited.names` in the order they were asked, through the caller's row policies; `you.canInvite` is
  "may post in the channel, while live, not a direct message".
- **Audit:** `meetings.invite.sent` becomes `meeting.invited`, "Invited 3 people as the call started" (a count, never who or the title); a direct-message call has no row.

## Ask to share (P17-02)

One screen is shared in a call at a time (P35-08): the page refuses a second share. While someone shares, the share button of everyone else reads **Ask to share**; pressing it asks the
person sharing for a turn. The request goes through the server, so it is checked and recorded; the media itself is unchanged (the media server lets anyone in the call publish a screen,
and the page keeps it to one).

- **`POST /api/meetings/:meetingId/share-requests`** `{ sharerActorId }` (10 a minute, `share-requests.ts`): `app.meetings_ask_to_share` (migration `0011_share_requests.sql`, a definer
  owned by the system role that checks the caller by `session_user` and the request's actor) takes a request only from a person in the live call, to another person in the same call
  (403 for someone not in the call or who left; 409 "They are not in the call any more", "You are the one sharing", "This call has ended"). One request per asker and person asked a
  minute, whatever its answer: asking the same person again sooner is 409 "You asked them less than a minute ago…"; asking someone else replaces the asker's request. Answers
  `{ requestId, expiresAt }` (a minute, `MEETING_SHARE_ASK_SECONDS`); both pages time the request by that `expiresAt`. The push `meeting.share_asked` (the asker's id and name as the
  call knows it, and `expiresAt`) goes to the person asked only. **No event is written when a request is asked.** The server cannot see who is sharing (the media server knows), so a
  request may name someone who is not; only that person's page hears of it, and it ignores a request while it is not sharing. Such a request is never answered and leaves no event
  and no audit row, so made-up requests cannot fill the audit log.
- **`POST /api/meetings/:meetingId/share-requests/:requestId/answer`** `{ answer: 'accept' | 'decline' }` (30 a minute): only the person asked, once, before the minute is up,
  while the call is live and they are in it (`app.meetings_answer_share`; a request that is not theirs, or of another call, is 404; answered, turned down, timed out or ended is
  409). A yes also turns down every other request waiting for the same person (`other`), oldest first, so only one asker is let share and nobody's waiting request blocks them
  from asking the next sharer. Each request answered is one `meetings.share_request.answered` event (`accept`, `decline` or `other`) and one push `meeting.share_answered` to its
  asker only. A request left alone lapses: nothing is written.
- **`app.meeting_share_requests`** (UNLOGGED: a request is worth a minute): one row per call and asker, `state` `pending`, `accepted` or `declined` (`MeetingShareRequestState`),
  read by the asker and the person asked, written only by the two functions and the system role.
- **The web** (`controller.ts` `askToShare`, `answerShare`, `noteShareAsked`, `noteShareAnswered`; `CallDock.tsx`). The person sharing sees the oldest request, "Rafi asks to share
  their screen" with **Stop and let Rafi share** and **Not now** (`call-share-asked`), only while they share; it goes when the server's minute is over, and all of them go when they
  stop sharing. A yes is sent to the server first; only when the server takes it does the page stop the screen (a refusal keeps them sharing and says why; a screen that will not
  stop is said plainly). The asker sees "Waiting for an answer…", then "said not now", "let someone else share first", "did not answer" (a yes that arrives later still counts), or
  "stopped sharing. You can share now" with a **Share screen** button (`call-share-ask`): a browser shares a screen only after a press on the page, so the asker presses it
  themself; it waits while the other screen is still going. If the sharer stops on their own, the asker may share at once; if the screen passes to a third person, the request
  goes and the asker may ask the new sharer.
- **Recording.** A shared screen and its tab sound are never recorded: the recorder and the note-taker's listener take only each person's microphone (`SOURCE_MICROPHONE` in
  `media-livekit/src/listener-worker.ts`), whether recording is on or off; "Ask to share" changes nothing there.
- **Audit:** `meeting.share_answered` ("Stopped sharing to let them share", "Said not now" or "Let someone else share first"), ids only; a direct-message call (no team) has no row.

## Guest links and the waiting room (P17-04, steps 1 and 2)

A **link guest** is someone outside the workspace with no account (not a workspace guest, whose role is `guest`). A link guest gets one call and never a channel. Plan:
`docs/plans/guest-links.md` (its "Decisions taken" hold). Code: `src/guests.ts` (routes, the sweep's part, the webhook's part), migrations `0012_guest_links.sql` and `0014_guest_segments.sql` (step 2), shared
`api/meetings/guests.ts`, web `clients/web/src/guest/` (the guest page) and `meetings/guestLinks.ts` (Copy guest link, the waiting room).

- **Links.** A secret of 32 random bytes in the address `/join/g/<43 characters>`; only its sha-256 is kept (`meeting_guest_links.token_hash`, which the app role may not
  select), and it is found by an equality lookup on the hash. A link cannot be shown again, so each member makes their own: the start dialog's switch "Let people outside the
  workspace join with a link" (off by default; `allowGuests: true`) makes the starter's first link in the same transaction and returns it once (`guestLink`), and the dialog
  copies it ("Guest link copied"). On the call card, **Copy guest link** (a reader who may post, not a workspace guest) copies this person's link, kept in the tab's
  `sessionStorage` per call, or a new one (`POST /api/meetings/:id/guest-links`); Invite more has a "Guest link · Copy" row. **Turn off guest links** (the starter, a lead or an
  admin; `DELETE /api/meetings/:id/guest-links`) stops every link of the call and turns the call's switch off; guests already in stay. A link works while the call is live, for 12
  hours at most and 50 knocks; at most 10 links of a call work at once; ending the call stops them all. Unknown, expired, turned-off and used-up links answer the same 404
  ("This guest link has expired or was turned off"). The workspace switch is `meeting_settings.guest_links_allowed` (`guestLinksAllowed`, on by default). Not in a direct
  message.
- **The guest's side** (public, no session; each route counts per address, `docs/deploy/rate-limits.md`): `POST /api/guest-links/peek {token}` (the call's title, the
  workspace's name, its kind, whether it is transcribed or a note-taker listens: never the channel or who is in it; a title the server wrote, "Call · #dev · 14:02", is shown as
  "Call · 14:02"), `POST /api/guest-links/knock {token, displayName}` (1 to 60 characters, cleaned of control and direction characters), then `GET /api/guest/session`, `POST /api/guest/token`, `/leave`, `/heartbeat`. The knock sets `mt_guest=<guest id>.<secret>` (HttpOnly,
  SameSite=Strict, `Path=/api/guest`, Secure on an https site, as long as the link lasts); only the secret's sha-256 is kept (`meeting_guests.credential_hash`). No session route
  reads that cookie. Every state-changing guest route also checks that `Origin` is the site's public address. 20 refused secrets (well-shaped links or cookies) from one address
  in 15 minutes lock it for 15 minutes; a secret of the wrong shape is never looked up and never counted. The secret travels in a POST body, never in an API address; the
  server's log redacts `/join/g/<secret>` (and any `/api/guest-links/<secret>`), and nginx writes no access log line for either location.
- **The waiting room.** A knock pushes `meeting.lobby` to the people in the call who may let a guest in (not a workspace guest, the rule of
  `app.meetings_decide_guest`); the call bar shows "Ana is waiting · Let in · Deny" with a soft knock, or "3
  waiting" opening the list (`GET /api/meetings/:id/lobby`, someone in the call who is not a workspace guest). `POST /api/meetings/:id/guests/:guestId/admit|deny|remove`: anyone in the call who is not a
  workspace guest; whoever answers first wins (a later answer is 409 "Someone already answered"); letting in counts the room like a join (409 "The call is full"). At most 10
  wait per call (429), 3 waiting from one address per call (counted from the knocks still waiting; a knock the database refused uses up nothing), 20 knocks a minute per
  link. A knock nobody answers lapses after ten minutes (by the database's clock); a page silent for three minutes, waiting or in the call, is counted as gone by the sweep,
  which tells the call (a browser slows a hidden tab's timers, so the page also says it is there when it is shown again). The page's poll (every 2 s waiting, 10 s in the
  call) is its sign of life.
- **In the call.** `POST /api/guest/token` only while let in and live: `media.token({ id: 'guest:<id>', kind: 'guest', displayName: '<name> (guest)' }, meetingId,
  { canPublish, canSubscribe, sources: ['microphone', 'camera'] })`, ten minutes at most; LiveKit gets `canPublishSources`, `canPublishData: false` and
  `canUpdateOwnMetadata: false`. `assertTokenRequest` refuses a guest token that is listen-only, names no sources or a screen, or has a person's identity (and a person's token with
  a guest identity). The guest sees the names in the call (no avatar, handle or address); the members see "Ana (guest)" (`MeetingSummary.guests`) and readers of the card "+1
  guest" (`CallCard.guests`). **Remove** kicks `guest:<id>` from the media room; the cookie is dead from then on. The media webhook kicks a `guest:<uuid>` that joins without
  being let in (or after the end); a guest let in whose media connection drops (a reload, a lost network) stays let in, and the page joins again with a new token and a
  growing pause ("Reconnecting…"). A guest leaves by Leave, by Remove, by the call's end or by the sweep. A guest is never an actor: participants and presence stay people-only,
  a guest's transcript lines carry `guest_id` instead of a speaker (step 2), and a guest does not keep a call alive.
- **Transcription (step 2).** While the call is transcribed, the guest's page asks "Transcribe my voice?" (the members' question, P15-05) under the call's title. Only a yes
  (`POST /api/guest/consent {transcribe}`, kept in `meeting_guests.consent_transcribe`) starts the on-device engine in the guest's browser; it sends only words, to
  `POST /api/guest/segments` (the members' body; 409 until a yes, while transcription is off, or after the end). The lines are stored with `meeting_segments.guest_id`
  (`speaker_id` null; exactly one of the two is set) and read "Ana (guest)" in the transcript, the captions and the transcript file (`MeetingTranscriptLine.guestId`). The
  server never transcribes a guest's sound and the note-taker never listens to a guest, whatever the room's mode. A no stops the engine first (what it heard and had not sent
  is thrown away) and blanks the guest's stored words ("Ana (guest) spoke (not transcribed)"); a guest who does not answer is never written down, and their microphone stays
  as they set it. Turning transcription on again asks the guest again. The insert trigger is the second guard: only the system role writes a guest's line, as a device line,
  of a live, transcribed call, and with words only for a guest let in who said yes. Nobody can correct a guest's line. A guest's lines are not in meeting search (it joins
  people only). Event `meetings.guest.answered` (`yes` or `no`; ids only, not audited, like `asked` and `left`).
- **Never recorded.** The recording rule counts an admitted guest as present with "no" (a yes to transcription is not a yes to recording), so nothing is recorded while one
  is in. A call with an admitted guest is held for a lead before it reaches the team's memory (`hold: 'external'`).
- **Guest links (n) (step 2).** On the call card, the starter, a lead or an admin gets **Guest links (n)** beside Turn off guest links (`CallCard.guests.links`, the links
  that still work, 0 for anyone else). It opens the list (`GET /api/meetings/:id/guest-links`, 403 for anyone else): "Made by Omar at 14:02 · 2 of 50 used · works until
  02:02" (never the address: only its hash is kept), each with **Turn off** (`DELETE /api/meetings/:id/guest-links/:linkId`, definer `app.meetings_revoke_guest_link`;
  `{revoked: false}` for a link that had already stopped). Only that link stops; the call's other links and its switch stay on, and guests already in stay. Event
  `meetings.guest_link.revoked` (`reason: person`, the one link).
- **Events and audit:** `meetings.guest_link.created`, `meetings.guest_link.revoked` (`person` or `ended`), `meetings.guest.asked`, `.admitted`, `.denied`, `.removed`, `.left`
  (`left`, `dropped`, `ended`, `expired`): ids and times only, never a name, an address or a secret. Audit rows for links made and turned off, and guests let in, turned away and
  taken out.
- **The page** (`/join/g/:token`, outside the sign-in check and the app's frame, loaded only when opened): the title and workspace, the transcription line, the name, a device
  check (microphone meter, camera preview, microphone picker, microphone and camera on or off), Ask to join; then "Waiting for the host to let you in…" with Cancel; the call
  (tiles with names, mute, camera, leave), or "The host did not let you in.", "The call has ended.", "You were removed from the call.", "Nobody answered. Try again.". After the
  knock the address becomes `/join/g/` (the secret leaves the address bar). nginx (`location ^~ /join/g/`) and the server's own static serving send the app's policy plus
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex` and write no access log line. The policy is not widened: members reach the media server at
  `wss://<site>/livekit` (`media.ingressPath`), which `connect-src 'self'` already covers, and so do guests. An install whose media server has a name of its own needs that name
  in `connect-src` for members and guests alike.
- **Still to do:** visual baselines of the guest's question and of the links list.

## Meeting series (P17-05, steps 1 and 2)

A **series** is a meeting of a team's schedule that repeats: every week, every 2 weeks or every month (same day of the month, the last day of a shorter month), from its
first meeting, until an optional last day. Plan: `docs/plans/meeting-series.md`. Code: `src/series.ts` (routes and jobs), `src/series-agenda.ts` (the page), migration
`0013_meeting_series.sql` and `0016_series_changes.sql`; web `clients/web/src/screens/schedule` (Repeats in the form, the series line, the agenda and Stop in the panel).

- **Meetings**: each is an appointment (P36-04) with `series_id` and its number `occurrence`, computed in the series' time zone (10:00 stays 10:00 when the clocks change). They
  are planned 92 days ahead; `meetings.series-plan` (every 10 minutes, as the platform) adds the next ones with the people of the latest. All of them share **one meeting space**
  (one chat, one Files folder for the transcripts). Editing one meeting changes that meeting only; its people are the series' (`PATCH …/appointments/:id` with people is 409).
- **Routes**: `POST /api/teams/:slug/meeting-series` (the appointment fields + `frequency`, `untilDate`, `timeZone`; 201 with the series and its first meeting; the people are
  told once), `PATCH /api/meeting-series/:id` (`title`, `inviteeIds`: the meetings to come and the space follow), `POST /api/meeting-series/:id/stop` (the meetings to come are
  cancelled). The maker, a lead of the team or a workspace admin may change or stop one. `Appointment` carries `series` and `agendaPath`.
- **The folder**: `meetings/series/<slug>/` of the team repo, a `README.md` and one `<yyyy-mm-dd>-agenda.md` per meeting, written by the platform (`meetings.series-agenda`):
  the first at once, each later one an hour after the meeting before it ended with its call over, and in any case an hour before it starts. A page has Agenda, Open action
  items from the last meeting, Action items and Notes.
- **Carry-over**: the boxes not ticked under the two action-item headings of the last agenda, and the action items of the written notes of the last call in the space
  (never a note-taker's Personal copy), each once, at most 50. The team repo is read by the whole team, so the form says so before a series is made.
- **Who edits**: a person who may post in the team changes an agenda page that exists, live (`/api/teams/:slug/pages/live` takes `LivePagePath`) or by a commit; making,
  removing or renaming one, and every other file under `meetings/`, stays the platform's (repo writer, `isSeriesAgendaPath`). Bots never write there. People invited from other
  teams read the agenda (not edit it) through the meeting: `GET /api/appointments/:id/agenda` checks they may see the meeting (row-level security, the database rule
  that shows each person only their rows) and the platform then reads the page from the team's files; `Appointment.hasAgenda` says a page is there.
- **Data**: `app.meeting_series` (RLS forced: the team and the people of its space read it; a member makes one for a space they opened; a guard trigger lets a person change
  only its title, agenda line and status, and a stopped series stays stopped). `app.appointments` gains `series_id`, `occurrence`, `agenda_path`, `agenda_written_at`; a guard
  trigger keeps those, the space and the team for the platform, and `app.appointment_place_ok` keeps a space to one appointment or one series.
- **Event**: `meetings.series.changed` v1 (`created`, `changed`, `stopped`; ids only), audited as made, changed, stopped.
- **A new rule or time (step 2)**: `PATCH /api/meeting-series/:id` with `frequency`, `untilDate`, `timeZone`, `startsAt`/`endsAt` (together) and `fromAppointmentId` (the
  next meeting when absent). The meetings to come from that one on are deleted and planned again from the new rule (`app.meeting_series_change_rule`, a definer that checks
  the caller is the maker, a lead or an admin), with the series' people; one moved or cancelled on its own among them is made again too. Their numbers go on after the
  last one kept (`meeting_series.rule_from`). An agenda already written for one of them moves to the first new meeting. One formula for the planner and the change:
  `app.meeting_series_start`, `app.meeting_series_plan`. The answer carries the first new meeting. On the web: Edit of a meeting of a series offers "This meeting" or
  "This and the following meetings" (Repeats and Until then show; Call and Agenda line are for one meeting only).
- **Notes after the agenda (step 2)**: when a call's notes are written after the next agenda (`meetings.notes.written`, and the planner's pass as a backstop), their
  action items not yet on the page are added under "Open action items from the last meeting", once per call (`appointments.agenda_notes_meeting_id`, the platform's):
  an item a person took out is not put back. Not while someone has the page open in the live editor or has unsaved edits there; the next pass tries again. The live
  editor starts from the file when the file changed since its last session (`pages` `loadDocument`).
- **Reminders (step 2)**: the five-minute reminder of a meeting whose agenda is written says "… starts in 5 minutes. The agenda is ready."; opening the reminder (in the
  app or from a browser push) goes to `/schedule?appointment=<id>`, the meeting's panel with Join and its agenda (`GET /api/appointments/:id` reads one meeting).
- **Not built**: telling the invited that the time of a series changed (the calendar shows it; nobody is notified); a series' call kind or agenda line changed for all
  meetings.

## The meeting assistant (P17-06, step 1)

The **assistant** is the help a person in a live call can ask for: **Ask** (a question about the call) and **Catch me up** (what was said before they joined). Plan:
`docs/plans/meeting-assistant.md`. Code: `src/assistant.ts` (routes and the two jobs), the panel path of `src/questions.ts`; web `clients/web/src/meetings/assistant.ts` (the
store) and `AssistantPanel.tsx` (the Ask button in the call bar opens it; a person who came 2 or more minutes late is offered Catch me up in the bar).

- **Who answers**: the room's note-taker when there is one, through its own path and rules (P15-24: the asker must have said yes to "Transcribe my voice"; six a minute; one
  at a time; a typed question skips the model's "is this a question" check). Otherwise the workspace Brain, through the meeting-run door (`MeetingRunsProvider.answer`): one run
  as the asker, the call's last 30 minutes in its prompt (only people who said yes, read as the asker, only while the call is live), its reads held to the channels every person
  present may read (the team's memory and knowledge too, when everyone present is on the team), and the answer posted into the call's thread by Brain inside its run.
  Before it reads, the run is held to the room (gateway-mcp `meeting-runs.ts`, the note-taker's answers too): it is offered only message, file and meeting searches,
  memory and knowledge; its searches answer only the call's own channel (`bot_runs.channel_id`); at most 8 tool calls; stopped after 90 s ("took too long"). The asker's
  tabs get `asking` at once and then the answer or one plain failure. Brain answers in calls
  of a team's public channels and only people of that team; elsewhere the panel says to add a note-taker.
- **Catch me up**: the lines before the person's `joined_at`, read as that person, only of people who said yes and only while the call is live; one `fast` model call
  (`llm.evalComplete`, ledger purpose `meeting_catchup`, charged to Brain or the note-taker); the summary is pushed to that person only and kept nowhere. Three in ten minutes per
  person per call.
- **Routes**: `GET /api/meetings/:id/assistant` (what may be offered, with reasons), `POST /api/meetings/:id/ask` `{question}` (202 `{askId, answerer}`), `POST
  /api/meetings/:id/catch-up` (202 `{requestId, minutesBefore}`). Pushes to the asker only: `meeting.ask`, `meeting.catchup`. Schemas: `packages/shared/src/api/meetings/assistant.ts`.
- **No new table or event** for Ask and Catch me up: an answer is a thread message, a run is a run, a summary is a read.

## Mark action item and the end-of-call review (P17-06, step 2)

A person in a live call presses **Mark action item** (the flag button in the call bar): the final transcript lines that ended in the last 30 seconds are kept as a **mark**
(only the words of people who said yes to "Transcribe my voice", read as the person who pressed it). The bar says what it kept for a few seconds ("Marked for the review at the
end: Nadia: I will send the draft."), or why not ("Nothing was written down in the last 30 seconds…", "Turn on transcription…"). When the call has ended, a **review** opens
for the people who were in it: the notes' action items (the Scribe's notes; a note-taker's notes are the organizer's own copy and stay out) and the marks, the same words
once. Each person gets a notification ("Review 3 action items from Sprint review") that opens the meeting page, where the review sits above the notes: change an item's words
or owner (anyone who was in the call, or a team member the notes named), remove it, then **Confirm before sending: 3 action items**. One person confirms for everyone; only the
confirmed items go into the notes' list (`meeting_notes.items` and the "Action items" section of `notes.md`, the rest of the file as it was) and on to the follow-ups (P17-07).
Code: `src/review.ts`; web `clients/web/src/meetings/review.ts`, `screens/meetings/ReviewPanel.tsx`, the mark in `meetings/assistant.ts` and `CallDock.tsx`.

- **When it opens** (job `meetings.review`): at once for a call with a note-taker; otherwise when the Scribe's notes are written (`meetings.notes.written`) or fail, and ten
  minutes after the end at the latest (then with the marks only). Notes that come after it opened are added to it; after it was confirmed they open it again with the
  confirmed items and the new ones (no second notification), so nothing reaches the notes unconfirmed. A call with nothing marked or found has no review.
- **Who**: a mark is written by a person in the live call, as themself, at most 30 each, and read by the readers of the call's channel (they could read the lines it took). A
  review is read by the people who were in the call while they can still read its channel; another reader of the channel sees none. Confirm checks how many items the person saw
  (a changed review is a 409), that every item is one of the review, and that an owner was in the call (or named by the notes); a second Confirm is a 409 naming who confirmed.
- **Tables** (`0015_meeting_marks.sql`): `meeting_marks` (forced row-level security; the insert trigger copies the call's place, refuses an ended call, someone not in it and a 31st
  mark) and `meeting_reviews` (one row per call; made only by the platform; the guard trigger lets a person change only the status to confirmed, as themself, with items of the
  review).
- **Routes**: `POST /api/meetings/:id/marks` (201 `{mark, count}`; 20 a minute), `GET /api/meetings/:id/review` (`{review}`, null when there is none for the caller),
  `POST /api/meetings/:id/review/confirm` `{items: [{id, text, ownerId}], seen}` (20 a minute). Push `meeting.review` `{meetingId, status}` to the people of the review. Schemas:
  `packages/shared/src/api/meetings/review.ts`.
- **Events**: `meetings.review.opened` (the people, the count; the notifications plugin writes one `meeting_actions` row per person, the same reference as an owner's row, so a
  person who is both gets one) and `meetings.action_items.confirmed` (who confirmed, items kept and removed, the owners' ids; audited as "Confirmed a meeting's action items").
  Ids and counts only, never an item's words.
- **Not yet**: the notes' owners are still told by `meetings.notes.written` when the notes are written, before the review; the follow-ups (P17-07) start from the confirmed event.

## Access loss

`channel.member.removed` and `team.member.removed` are consumed: the person is dropped from every live room they can no longer read (checked with `app.channel_audience`), the media server is told to
remove them, and the next token or join answers 404. Target: within 5 seconds (tested with the fake provider). A webhook saying a person joined who is not in the room kicks them again. The listener
hears a person only while they are present with consent yes, so a removed person's audio stops within the listener's two-second check.

## Events

Emitted here: `meetings.meeting.started`, `meetings.meeting.ended`, `meetings.participant.joined`, `meetings.participant.left`, `meetings.consent.changed`, `meetings.transcript.written`, `meetings.notes.written` (with
`actionOwnerIds`), `meetings.notes.shared`, `meetings.notes.saved`, `meetings.notetaker.added`, `meetings.notetaker.removed`, `meetings.recording.started`, `meetings.recording.stopped`, `meetings.invite.sent` (the people asked to a call: ids, `first`), `meetings.share_request.answered` (Ask to share: a request answered, ids and the answer); also `channel.channel.created`
(the note-taker's first conversation with the organizer). Payloads hold ids and times, never a title or any text. Consumed: `channel.member.removed`, `team.member.removed`, `channel.message.posted` (a voice message of a client from before P32, with its own words, in a
call thread becomes a line; a mention of the note-taker in the thread is a question), `channel.message.transcribed` (a voice message of the current client becomes a line when the server's words, or the author's own, are in it: state `server` or `edited`; `failed` and `none` add no line), `meetings.meeting.ended` (the transcript job) and `meetings.transcript.written` (the notes job). The audit plugin records
started, ended, people invited, consent changed, note-taker added and removed, recording started and stopped, a request to share a screen when it is answered, notes shared and saved (ids only).

## Limits

Per person a minute: starting a room 10, joining 60, token renewals 60 (`docs/deploy/rate-limits.md`); the start dialog's options 60; Invite more 20; Ask to share 10, answering it 30; heartbeat 20; end 30; lines posted 240 (a batch holds at most 20); corrections 60; audio chunks 120. Per room a
minute: 1000 lines (429 after), 6 questions to the note-taker answered a minute and 20 model checks ("is this a question for it?") a minute per room, past which a line that names the note-taker is dropped. The media server's webhook: 120 a minute per address. A line is at most 4000 characters (a longer one is refused with 413); the server strips control
and bidirectional characters before storing it; a transcript file is at most 2 MB and then says "transcript truncated". People in a room: `meeting_settings.room_cap` (25). Note-taker rooms in one server process:
`MANYTHREADS_NOTETAKER_MAX_ROOMS` (10).

## Settings

| Variable | Meaning |
|---|---|
| `MANYTHREADS_MEDIA_PROVIDER` | which `provider.media` plugin to use; default `livekit` |
| `MANYTHREADS_LIVEKIT_URL`, `_API_KEY`, `_API_SECRET`, `_API_URL` | see [media-livekit.md](./media-livekit.md) |
| `MANYTHREADS_NOTETAKER_MAX_ROOMS` | rooms with a note-taker one server process listens to at once, default 10, at most 100 (the chart value is `media.noteTakerMaxRooms`) |
| `MANYTHREADS_RECORDING_MAX_ROOMS` | rooms recorded at once in one server process, default 10 |
| `MANYTHREADS_FAKE_ASR` | `1` is a test stand-in for the speech-to-text server; the server refuses to start with it when `NODE_ENV=production` ([asr.md](./asr.md)) |

Workspace switches (`GET/PUT /api/workspace/meetings-settings`, admin): `transcribeCap` (`off`, `on_device`, `server`; default `on_device`), `roomCap` (default 25), `recordingCap` (`off` by default) and `notetakerAllowed` (default on).
Team switches, in the front matter of the team's `TEAM.md` under `meetings:`: `transcribe` (`off`, `on_device`, `server`), `noteTaker` (`on`, `off`), `autoMemory` (default `true`) and `keepAudioDays` (default 30). A key that is
left out takes its default; a key that is present but not valid takes the closed choice (`off`, `false`), so a typo never opens what a team meant to keep closed.

## Tests

Server, `packages/plugins/meetings/test`: `meetings-api.test.ts` (routes, authorisation, rate limit, auto-end, kick, webhook), `not-configured.test.ts`, `consent.test.ts`, `segments.test.ts`, `captions.test.ts`,
`limits.test.ts`, `hostile-text.test.ts`, `writer.test.ts`, `audio-chunks.test.ts`, `notes.test.ts`, `notes-unit.test.ts`, `notetaker.test.ts`, `listener.test.ts`, `questions.test.ts`, `shares.test.ts`, `save.test.ts`,
`recording.test.ts`, `review.test.ts` and `review-unit.test.ts` (Mark action item and the end-of-call review), and under `rls/`: `meetings-rls.test.ts`, `meetings-bundle-c-rls.test.ts`, `meetings-search-rls.test.ts`, `meetings-review-rls.test.ts` (`pnpm test:rls`). The events: `packages/shared/test/events/phase15-meetings-contracts.test.ts`.
The tests use the `media-fake` test-only plugin (a deterministic provider that records every room, token, kick and listener). The end-to-end specs are `e2e/meetings`, `e2e/api/meetings` and `e2e/visual/meetings`; the
live check is `e2e/screens/task.verify-bundle-c.shots.ts`.

## Consent and transcription (migration `0002_consent.sql`, P15-05)

Transcription is off in a new room. Anyone in the room can turn it on (`PUT /api/meetings/:id/transcription`, mode `on_device` or `server`) when the caps allow it; turning it on resets everyone present to
"not answered" and each person answers yes or no (`POST /api/meetings/:id/consent`). A person who has not said yes is never transcribed: the database trigger blanks the words of any segment whose speaker's
current consent is not yes, so the transcript shows a "spoke (not transcribed)" placeholder with the time and no text, and a later "no" blanks the words already stored. The reader judges by the current answer.
A person joining late is asked before the microphone opens (the web client keeps it closed until the answer is sent).

Caps: the lower of two. The workspace switch (`meeting_settings.transcribe_cap`, default `on_device`, `GET/PUT /api/workspace/meetings-settings`, admin) and the team's `TEAM.md` key `meetings.transcribe`
(`off` | `on_device` | `server`; absent means `on_device`; a value that is present but not valid means `off`). `server` needs both caps to say `server`. A direct message has no team, so only the workspace
switch applies. The web client keeps a personal default ("ask", "yes" or "no") in the browser only.

Pushes to people: `meeting.changed` (a room started, changed or ended; the client asks again) and `meeting.ringing` (a direct-message call, rings 30 seconds). If nobody else joined 30 seconds after a
direct-message call started, `meetings.ringend` writes a "Missed call" message to the conversation.

## The web client (`clients/web/src/meetings`, P15-04)

`controller.ts` is the whole life of one call (start, connect, heartbeat every 30 s, token renewal 90 s before it ends, roster every 30 s, mute / deafen / push-to-talk, devices, rejoin up to six times
with a growing wait, consent before the microphone); `store.ts` holds the live rooms for the sidebar badges and the calls ringing; `media.ts` loads the adapter for the provider named in the join answer:
`livekitAdapter.ts` (the `livekit-client` library, loaded only when a call starts, so the main bundle does not grow) or `fakeAdapter.ts` (in memory, for tests). Echo cancellation, noise suppression and
auto gain are on. Ctrl/Cmd+Shift+Space mutes. At 760px and narrower the bar is a bottom sheet. When the server answers 409 "not set up", the bar shows "Voice rooms are not set up on this server" and
nothing else happens. Words come from `engine.ts` (see "How words get into a transcript"); captions, the note-taker picker and the recording toggle are `Captions.tsx`, `NotetakerPicker.tsx` and `RecordingToggle.tsx` in the same folder. The meeting page is `screens/meetings` (route `/meetings/:meetingId`, `?t=<ms>` jumps to a line).

**Video (P35-08, P17-01).** `CallStage.tsx` is the stage above the call bar while anybody has a camera or a screen on; `layout.ts` decides what it draws. **Grid** shows every tile at the same size; **Speaker** shows
one tile large (the tile the person pinned, else another person's shared screen, else another person speaking, else one's own screen, else whoever spoke last) and the others in a strip. Both layouts are one list of tiles
that CSS places, so a tile keeps its video (and an open floating window) when the layout or the large tile changes. Each tile has a pin button; in Grid a pin marks the tile and moves nothing. At most 16 video tiles are
drawn; past that one "+N" tile stands for the rest. The drawn tiles keep their places: a new tile goes to the end, and a person who is not drawn takes a place only after speaking for 3 seconds, in the place of the drawn
person silent the longest (the pinned one, a screen, one's own camera and anyone speaking are never pushed out). The layout and the picture-in-picture switch are kept with the other call choices in this browser
(`manythreads_call_prefs`; an early build's `manythreads_call_stage` is moved in once and removed); with no choice yet a phone (760px and narrower) opens in Speaker and a wider screen in Grid. Picture-in-picture is the
browser's small floating video window: when the tab is hidden another person's video goes into it (the large one when it is theirs, never one's own camera or screen), and it closes when the tab is back; only where the browser
offers it, and a refusal is silent. **Audio only** (in the call settings) stops receiving other people's video and turns one's own camera off for the rest of the call; a new connection in audio only subscribes to sound
alone from the start. When the media library reports this person's connection as poor or lost, the bar suggests it (Audio only / Not now, laid over the bar so nothing moves) and never switches by itself; "Not now", or turning
audio only off again, ends the suggestion for the call, and a new connection is judged afresh. Simulcast (each camera sent at several qualities, so the media server gives each viewer the copy that fits their connection and
tile) is livekit-client's default; the adapter states `simulcast: true` so a change of default cannot switch it off, and the library picks the smaller copies for the camera's shape.

Tests: `clients/web/test/meetings-layout.test.ts` (the layout rules, the kept choice, picture-in-picture, the audio-only suggestion), `clients/web/test/meetings-model.test.ts`, `meetings-call.test.ts` (the controller against the in-memory media layer), `meetings-live.test.ts`, `meetings-engine.test.ts`, `speech-stream.test.ts`, `meetings-view.test.ts`, `meetings-view-words.test.ts`; server: `test/consent.test.ts`.

### Only a live server shows

Real microphone capture, echo cancellation and noise suppression quality; the device picker with real devices; speaking detection from the media server; the reconnect after a real network drop; the join /
leave / ring sounds on a real speaker; the browser's autoplay rule for remote audio; the bottom sheet on a real phone; the page's content security policy letting the page reach the media server's address
(`connect-src`, see the deploy notes); the ring push on a phone; simulcast layers and the media server's choice of layer; picture-in-picture when the tab is left (browsers may want a press on the page first, Chrome opens it by itself for a call through the media session).

## How words get into a transcript

Every line ends in one function, `takeSegments` (`segments.ts`), whatever its source, so the same rules apply to each:

- **From a device** (`POST /api/meetings/:meetingId/segments`, up to 20 lines): the person's own browser writes out their own microphone with the on-device Whisper model of P14-16 (`clients/web/src/speech/stream.ts`, driven by
  `meetings/engine.ts`) and sends the words, not the audio. A partial line (the engine may still change it) is only ever a caption; a final line is stored. The browser measures how far its clock is from the server's through the
  heartbeat answer (`serverNow`) so a line lands at the right time in the meeting (`startMs` is milliseconds since the room started). A test build (`VITE_MANYTHREADS_FAKE_ASR=1`) has no engine; a spec calls
  `window.__manythreadsSay(text)` to say something.
- **From the server's speech-to-text** for a person who chose `server` and whose room and caps allow it (`POST /api/meetings/:meetingId/audio-chunks`, a 16 kHz mono WAV of at most 30 s and 2 MB; `routes-audio.ts`). The bytes
  go to the `transcribe` door of the LLM gateway ([asr.md](./asr.md)) and are dropped; nothing is written to disk or storage. Refused (403) unless the sender is present, said yes, and the room's mode is `server`.
- **From the note-taker's listener** (see "The note-taker").
- **From a voice message** posted in the call's thread while the room is live (or in the late window), with its transcript: a `device` line for its author, if they said yes. A message of the current client is posted `pending` and is taken when `channel.message.transcribed` says `server` or `edited`, never as the stand-in line "Voice message (0:03)"; one line per message (`voice:<message id>`).

The rules: control and bidirectional characters are stripped; a speaker who has not said yes leaves only the times of their speaking (the database trigger blanks the words); a final line that repeats what another device of the
same speaker already sent (same words, the times overlapping by half or more of the shorter) is dropped; the same `clientSegId` twice is stored once; the speaker may correct their own line for 24 hours
(`PATCH /api/meetings/:meetingId/segments/:segId`), which writes the transcript file again 30 seconds later.

**Captions.** The server pushes `meeting.caption` to the people present, collected per room into one push at most every 250 ms (four a second however many people speak). The collecting is in the memory of one server process;
with two replicas each collects for itself, which is acceptable because the live site runs one. A backlog of more than 60 seconds of audio shows "catching up".

**Late lines and the clock.** A line is accepted until two minutes after the room ended. The transcript job runs at two minutes ten seconds.

## Where a transcript and its notes live

| Kind of meeting | Transcript and notes |
|---|---|
| A public channel's room | the team repository, `meetings/YYYY/MM/DD-HHMM-slug/{transcript,notes}.md`, one commit made by the platform, the speakers as `Co-authored-by` |
| A private channel's or a direct message's room | the channel's Files folder, `channels/<name>/meetings/<same>/` (`dms/<id>/…` for a direct message), readable by exactly the people who can read the room |
| A room with a note-taker | the **organizer's Personal files**, `Meetings/YYYY-MM-DD-HHMM-slug/{transcript,notes}.md`; the room's own transcript job does not write a second copy |

`meetings/` in a team repository is guarded: only the platform writes there. Nobody can commit it directly, no proposal can change it, and the Files tree shows it read-only. The transcript starts with a small front matter
(`type: Meeting Transcript`, title, date, start, duration, channel, participants, language, `source`) and has one line per stretch of speech, `[00:12:04] **Nadia:** words`. What was said is escaped, so it cannot become a
heading, link or tag. A person who did not say yes shows as "<name> spoke (not transcribed)" with the time. `meeting_notes.transcript_path` holds the path of the transcript for **every** kind of meeting (for a
note-taker meeting it is the Personal path, which only the organizer can open directly; others read it through the meetings routes after a share, below).

## The Scribe and the notes (P15-10 to P15-12)

After a room's transcript is written (no note-taker in it), the `meetings.notes` job asks the team's Scribe for the notes. The Scribe is an ordinary team bot (`templates/*/bots/scribe`, trigger `meeting_ended`,
holds `meetings.read`, `memory.recall` and `meetings.write_notes`, hidden from the mention picker because nobody can address it; `meetings.read` opens only a room of the run's team without a note-taker whose notes are still pending, never a Personal transcript). `runtime-hermes` registers the `meeting.runs` provider; its `notes` method runs the
Scribe synchronously with the transcript in the prompt (`@<ms> | <clock> | <speaker>: <words>`, between markers, as data) and reads one JSON object back. An answer that is not an object is asked for once more.

* The platform checks the answer: an item whose time is not inside a transcribed line is dropped; an owner is a team member by exact display name, else only the name is kept; an owner who did not say yes to being
  transcribed becomes "no owner". The model never writes a file: the platform renders `notes.md` beside the transcript.
* `meetings.notes.written` carries ids only, including `actionOwnerIds`. The notifications plugin turns it into one `meeting_actions` notification for each owner ("2 action items from Sprint review"), which opens `/meetings/<id>`.
  On the meeting page each action item has "Add to board": the web calls the existing task-card route as the person.
* A public channel's meeting is filed into the team's memory inbox by itself (origin `meeting`, the consenting speakers as droppers; a room with somebody outside the team is held for a lead; `autoMemory: false` turns it
  off). A private channel, a direct message, or a team without the switch is filed only by `POST /api/meetings/:meetingId/send-to-memory` after the person sees the warning and confirms. The concept's `sources` point at the
  inbox original; the transcript path and the `[hh:mm:ss]` line times are inside that text.
* A run that fails (or answers twice without an object) sets `meeting_notes.status = 'failed'` and the thread says "The notes could not be written", with the transcript path and a link to the meeting. A budget that
  says "later" is tried again after 15 minutes, up to six times.
* The thread line is written by the Scribe's own actor in a transaction of its own after the notes are saved.
* People edit the notes through `PUT /api/meetings/:meetingId/notes` (the plugin writes the file, the person is the author).

## The note-taker (P15-18 to P15-24)

A note-taker is a team bot whose `BOT.md` has the trigger `{ type: meeting }`; the Engineering, Customer support, Product design, Research and Marketing templates ship one (`templates/*/bots/note-taker`, capabilities
`meetings.read`, `meetings.search`, `messages.search`, `memory.recall`, `meetings.write_notes`; its runs are started by the platform on `meeting_ended` and `meeting_question`). A team that already exists does not get a template
change by itself: add `bots/note-taker/BOT.md` through the repository.

**Adding it** (`PUT /api/meetings/:meetingId/notetaker`, anyone in the room; removing it, `DELETE`, the organizer, the person who added it or a team lead; `GET …/notetakers` lists who can be added and says why "Add note-taker"
is disabled). It is refused, with a plain reason, when the media server cannot host a listener, the workspace has `notetakerAllowed` off or the team has `meetings.noteTaker: off`, transcription is off by a cap, the
`transcribe` alias is not bound, the room already has one, or this server process already listens to `MANYTHREADS_NOTETAKER_MAX_ROOMS` rooms (409 "The note-taker is busy, try again in a minute."). Adding it moves the
room to server transcription, sets everyone's answer back to "not asked" and posts a line in the call thread ("<name> added Note-taker. It listens on the server and writes notes for <name>.").

**The listener** (`listener.ts`, and `media-livekit/src/listener*.ts`, see [media-livekit.md](./media-livekit.md)). It joins the room as a hidden, subscribe-only participant `notetaker:<meetingId>` (never an actor id, because the
media webhook would drop an unknown actor id from the room). The list of people it hears is the people present with consent yes; it is checked against the database every two seconds, so a withdrawn yes, a leave or a kick
stops that person's audio well inside five seconds, and what was buffered for them is thrown away. The audio is cut at pauses (600 ms of silence, at most 30 s per chunk, `sdk/src/audio/vad.ts`), each chunk checked once more,
sent to `transcribe` and stored as a `server` line by `takeSegments`; captions are pushed. Every 30 seconds the new lines are appended to the organizer's Personal transcript (`personal.files` as the system, the bot as author).
The bot never publishes audio, and a bot never receives a media token: only the plugin mints the listener's token. Over `MANYTHREADS_NOTETAKER_MAX_ROOMS` it answers 409. One server process is assumed: with two, both would join.

**After the call** the `meetings.notetaker.notes` job asks the note-taker's run for the notes (the same JSON and checks as the Scribe), writes `notes.md` beside the Personal transcript and posts, through the
`meeting.runs.say` provider method (a bot may post only inside a run opened for that channel, so `say` opens one), a message from the note-taker to the organizer in their conversation with it: title, that the notes are in
their Personal files, and `meta.meetingNotes { meetingId }` so the page draws Share and Save-to-team buttons. The call thread gets "Notes are with <organizer>." If the run fails, `meeting_notes.status = 'failed'` and the
same message says the transcript is there.

**A removed note-taker.** If the note-taker is removed before the room ends, its listener leaves at once and stops hearing anyone; lines already written stay in the database and in the organizer's Personal
`transcript.md` (the listener appends every 30 seconds and once more when it closes). When the room then ends, the room's own transcript job (`writer.ts`, `writeTranscript`) decides by the file that exists:
if the note-taker already created the Personal transcript (`meeting_notes.location = 'personal'`), the job writes nothing and the Personal copy stays the only copy, because the people in the call were told
a private note-taker was listening and the organizer has not chosen to publish it (they can use Save to team); lines spoken after the removal (from devices or the server fallback) are in the database and the
meeting page but not in that file. If the note-taker was removed before it wrote anything (no Personal file yet), the job writes the normal repository or channel Files copy and the Scribe makes the notes.

**Questions in the call** (P15-22, `questions.ts`). Final lines of people who said yes are scanned (NFKC and lower case, one linear pass, whole words only) for the bot's name, its slug or "note-taker"; a hit queues
`meetings.question`. One `fast` model call over the last 60 seconds decides whether the newest line is a question for the note-taker. A message in the call thread that **@mentions** the note-taker (the text `@note-taker`
or the real mention) skips that check. Then the note-taker's `answer` run may read only the channels **every person in the call** may read (each person's own visible set, taken as that person), no Personal files; an answer
that used anything else is thrown away. The answer is posted in the thread and shown as a caption that names the asker. One question at a time, six a minute per room, a question older than two minutes is dropped, and a
line of someone who did not say yes is never taken as a question.

**Share and save** (P15-23). The organizer shares the notes with a person or a channel (`GET/POST …/shares`, `DELETE …/shares/:shareId`, audit rows); a reader then gets the notes through `GET …/notes` and the transcript through
`GET …/transcript?copy=organizer`. The meetings plugin serves them from the Personal file after `app.meetings_can_read_notes` says yes (the organizer, a person with an unrevoked share who is still in the team, or a member
of a shared channel); Files rules are not changed, so the Personal folder stays closed to everyone else. A shared reader who has left the team gets 404. The room's own `GET …/transcript` follows the same rule once a note-taker room has ended and until the notes are saved to the team: only the organizer, a share or the team's copy opens it (404 for anyone else, including people who were in the call); while the room is live everyone in it reads as before. The organizer reaches the notes written for the team only while they can still read the place of the call (migration 0004); their own Personal copy stays theirs. **Save to team**
(`POST /api/meetings/:meetingId/save-to-team`, the organizer, once: 409 after) copies both files into the team repository's `meetings/` folder with the organizer as author and, with the box ticked, files the notes into
team memory as above. The meeting page (`GET …/summary`, `GET /api/meetings/by-path` from a file in the Files tree) shows people, length, links, decisions, action items and whether it is filed to memory.

## Search and Brain

`meeting_segments.text` and `meeting_notes.notes_md` have trigram indexes; the search plugin's function `app.search_meetings` reads them through the normal policies, keeps only the words of a speaker whose answer is yes and leaves out a
note-taker's transcript while it is still the organizer's own. Search scope `meetings`; the capability `meetings.search` gives a bot the same answer the person would get. An answer citation of kind `meeting` opens
`/meetings/<id>?t=<ms>` at the line.

## Live checks

`e2e/screens/task.verify-bundle-c.shots.ts` runs against the live site from the devbox with two real Chromium contexts and two real read-aloud clips (`e2e/fixtures/speech/nadia.wav` and `rafi.wav`, LibriSpeech, CC BY 4.0).
A line is judged by "contains one of the reference words" (`references.json`), never by an exact text. A step whose prerequisite is missing (no media server, no `transcribe` binding, no Hermes pod) records
"SKIPPED: reason".

## Bundle C contracts (the routes and where they live)

"Provider" here means a service one plugin registers and another reads through the SDK (`ctx.providers`); "capability" means a named action the bot broker checks before a bot may do it. Zod shapes are in
`packages/shared/src/api/meetings/`, handlers in `packages/plugins/meetings/src/`.

### Routes

| Route | Shared constant | Handler file |
|---|---|---|
| `POST /api/meetings/:meetingId/segments` (up to 20 final lines; partial lines become captions only) | `postMeetingSegmentsRoute` | `routes-transcript.ts` |
| `PATCH /api/meetings/:meetingId/segments/:segId` (correct your own line for 24 hours) | `patchMeetingSegmentRoute` | `routes-transcript.ts` |
| `POST /api/meetings/:meetingId/audio-chunks` (WAV body, server fallback) | `postMeetingAudioChunkRoute` | `routes-audio.ts` |
| `GET /api/meetings/:meetingId/summary` | `getMeetingOverviewRoute` | `routes-notes.ts` |
| `GET /api/meetings/by-path` | `getMeetingByPathRoute` | `routes-notes.ts` |
| `GET` / `PUT /api/meetings/:meetingId/notes` | `getMeetingNotesRoute`, `putMeetingNotesRoute` | `routes-notes.ts` |
| `GET /api/meetings/:meetingId/transcript` (`?copy=organizer` for a shared reader) | `getMeetingTranscriptRoute` | `routes-consent.ts` |
| `POST /api/meetings/:meetingId/save-to-team` | `saveMeetingToTeamRoute` | `routes-notes.ts` |
| `POST /api/meetings/:meetingId/send-to-memory` | `sendMeetingToMemoryRoute` | `memory.ts` |
| `GET` / `POST /api/meetings/:meetingId/shares`, `DELETE …/shares/:shareId` | `listMeetingSharesRoute`, `createMeetingShareRoute`, `deleteMeetingShareRoute` | `shares.ts` |
| `GET …/notetakers`, `PUT` / `DELETE …/notetaker` | `listMeetingNotetakersRoute`, `setMeetingNotetakerRoute`, `removeMeetingNotetakerRoute` | `notetaker.ts` |
| `GET` / `PUT …/recording`, `POST …/record-consent` | `getMeetingRecordingRoute`, `setMeetingRecordingRoute`, `meetingRecordConsentRoute` | `recording.ts` |
| `POST /api/test/media/speak` (test servers only; says a line as a person the listener hears) | `fakeMediaSpeakRoute` | `media-fake` plugin |

The heartbeat answer is `{ ok: true, serverNow }`. `MeetingTranscriptLine` carries `segmentId` and `editable`.

### Events

New in this bundle: `meetings.notetaker.added`, `meetings.notetaker.removed`, `meetings.recording.started`, `meetings.recording.stopped`, `meetings.notes.shared`, `meetings.notes.saved`; `meetings.notes.written` gains
`actionOwnerIds`. Bot run triggers gain `meeting_ended` and `meeting_question`; BOT.md triggers gain `{ type: meeting }` and `{ type: meeting_ended }`. Notification kind `meeting_actions`; inbox origin `meeting`; answer citation
kind `meeting`.

### Capabilities, providers, extension points

Capabilities declared by the manifest: `meetings.read`, `meetings.write_notes`, `meetings.search` (none destructive). (A capability name has one dot: `namespace.verb`.)
Providers: `meeting.runs` (registered by `runtime-hermes`; methods `notes`, `answer` and `say`) and `inbox.dropper` (registered by `memory-inbox`; files a meeting into a team's inbox), with extension points
`provider.meeting.runs` and `provider.inbox.dropper`. `MediaProvider.listen?` is optional so a provider without a listener still works; the LiveKit adapter and the fake provider both implement it. The SDK holds
`LlmTranscriber` (the `transcribe` door of gateway-llm), the WAV helpers (`audio/wav.ts`) and the voice-activity segmenter (`audio/vad.ts`).

### Migrations

`meetings/0003_transcripts_notes.sql` (late-line window, `client_seg_id`, `edited_at`, BRIN and trigram indexes, `app.meetings_correct_segment`, the tables `meeting_notes`, `meeting_shares`, `meeting_recordings`,
`app.meetings_set_notetaker`, `app.meetings_set_recording`, `app.meetings_can_read_notes`, settings columns `room_cap`, `recording_cap`, `notetaker_allowed`) · `meetings/0004_organizer_leaves.sql` (the organizer's right to the team's copy ends with their right to the place) · `bots/0030_meeting_triggers.sql` · `memory-inbox/0005_meeting_origin.sql` ·
`notifications/0006_meeting_actions.sql` · `search/0007_meetings.sql` · `answer/0009_meeting_citations.sql` · `retention/0002_meeting_audio.sql`. · `meetings/0015_meeting_marks.sql` (P17-06 step 2: `meeting_marks`, `meeting_reviews`).

## Recording (`recording.ts`, P15-15)

Off until an admin sets the workspace switch `recordingCap` to `on`. A person in the room turns recording on for that room (`PUT …/recording`); that sets everyone present back to "not asked" and every person
answers for themselves (`POST …/record-consent`). A hidden listen-only participant, `recorder:<meetingId>`, joins the room; it publishes nothing. It hears a person only while **everyone present** has said yes, so
one "no", or a newcomer who has not answered, stops every file at once (within about two seconds, and half a second at the chunk level) and the call thread gets one plain line. A yes counts only if it was given after
the person last joined the room: a yes left over from before leaving and coming back is taken back to "not asked". Each consenting person gets one 16 kHz mono WAV, stored as the system actor in the channel's Files
at `channels/<name>/meetings/<dd>-<hhmm>-<slug>/audio/<person>.wav` (`dms/<id>/…` for a direct message), with the recorded person as uploader. Audio never goes to git. Stop reasons: `turned_off`, `left`, `ended`,
`consent_withdrawn`, `joined_without_yes`, `failed`. Events carry ids only. Limits: three hours per person per file, `MANYTHREADS_RECORDING_MAX_ROOMS` rooms at once (default 10), one server process. Files expire per
[retention](./retention.md) (default 30 days, `meetings.keepAudioDays` in `TEAM.md`). Exports for other packages: `audioFolder()`, `audioSlug()`, `isRecording()`, `recordingNow()`, `RECORDER_START_QUEUE`.

## Bundle D contracts (P16-05, planned rooms)

A plan is not a room. `app.scheduled_meetings` and `app.scheduled_meeting_attendees` (`meetings/0005_scheduled.sql`) hold a voice room planned ahead in a channel; the room itself is made when someone presses
Start at the time, or opens the join link `/join/<id>`, and that room remembers its plan (`meetings.scheduled_meeting_id`, set by the trigger `meetings_mark_scheduled_started`). The organizer's own calendar
(Google or Microsoft, through the `connections` calendar provider) carries the event; outside guests are only a count, their addresses are never kept. Enums: `ScheduledMeetingStatus` (`scheduled`, `cancelled`,
`started`), `ScheduledMeetingProvider` (`google`, `microsoft`).

Routes (shared `api/meetings/scheduled.ts`): `POST|GET /api/channels/:channelId/scheduled-meetings`, `GET|PATCH|DELETE /api/scheduled-meetings/:scheduledMeetingId` (the GET answers with a `gate`, the state of
the plan that someone who may not read the channel is told, and the plan itself only for a reader), `POST /api/scheduled-meetings/:scheduledMeetingId/join`. Limits: 100 waiting plans per channel, 50 invited,
120-character title, 8000-character agenda, at most 366 days ahead and 24 hours long. Events (ids and counts only): `meetings.scheduled.created|changed|cancelled|starting_soon`. The reminder is the notification
kind `meeting_soon` (`notifications/0007_meeting_soon.sql`, ref type `scheduled_meeting`), sent five minutes ahead by the queue `meetings.scheduled-reminders`; the queue `meetings.scheduled-sync` reads the
calendar for moved or deleted events. The definer functions `app.meetings_schedule`, `app.meetings_cancel_scheduled` and `app.meetings_scheduled_gate` do the writes and the gate under the caller's rights; `app.meetings_organizer_name` (`meetings/0006_organizer_name.sql`) answers the organizer's name to any member of the workspace, because a person can read only their own row of `actors`.

### How it works (P16-05, built)

- **Planning** (`scheduled.ts`, `createScheduled`). The organizer's click is the consent; there is no approval card. Order of work: check the right to post and that the channel is not archived; check the time is not
  more than two minutes in the past; pick the calendar (`calendarProvider`, else the first connected service); make the event at the organizer's own calendar through the provider `connector.calendar` (looked up at
  call time, never in `register`) with the join link in both its description (after the agenda) and its location; then call `app.meetings_schedule`. If that fails the event is cancelled again. Last, the event
  `meetings.scheduled.created` and the push `scheduled_meeting.changed` (`created`).
- **Who is invited.** Picked people and typed addresses that belong to an active workspace person who can read the channel become attendees (rows with person ids). Every other typed address is an outside guest:
  invited by address at the calendar, counted in `outside_count`, never stored. A picked person who cannot read the channel is not given the link and is counted with the outside guests.
- **Changing and cancelling.** Only the organizer, only while the plan is `scheduled`. A change goes to the calendar first (`updateEvent`), then to the row, written as the system role in its own transaction (there
  is no update definer); a changed time clears `reminded_at`. A cancel runs `app.meetings_cancel_scheduled` first and then removes the event, best effort: the plan stays cancelled even if the calendar is down. A
  cancel of a cancelled plan is the same answer.
- **Opening the room.** `POST /api/scheduled-meetings/:id/join` opens the room of the plan (`startRoom` with `scheduledMeetingId`, the same code the start route uses), or joins the live one. A cancelled plan answers
  409 "This meeting was cancelled."; a started plan whose room has ended answers 409 "This meeting has already happened."; a person who cannot read the channel finds no plan (404) and reads the gate on
  `GET` (`readable: false`, never the title). A channel has one live room: if an unrelated room is live there, the join joins that room and the plan stays `scheduled`.
- **Jobs** (`scheduled-jobs.ts`, all detached, short transactions, no HTTP inside one): `meetings.scheduled-reminders` every minute stamps `reminded_at` for plans starting within 5 minutes and emits
  `meetings.scheduled.starting_soon` once (with the invited people who can still read the channel); `meetings.scheduled-sync` every ten minutes reads up to 50 plans starting within 48 hours (least recently synced
  first) at the organizer's own calendar: a changed title, time (the end after the start, at most 24 hours) or agenda is copied (event `changed` with `changedBy: null`), a deleted or cancelled event cancels the plan
  (`reason: calendar_deleted`), a missing sign-in or an unreachable calendar leaves the plan as it is; `meetings.scheduled-agenda` reads one plan's agenda again when its room opens; `meetings.scheduled-cancel-event`
  removes the event of a plan cancelled by an archived channel (`channel.channel.archived` cancels the waiting plans in the same transaction).
- **Reminder** (`notifications/src/meeting-soon.ts`). One `meeting_soon` row per invited person who can still read the channel: "<title> starts in 5 minutes", from the organizer, opens `/join/<id>`; Do not
  disturb holds it, no channel level silences it, delivered twice writes nothing the second time.
- **The Scribe** (`runtime-hermes/src/meeting-run.ts`). A room that came from a plan gets the plan's agenda in its notes prompt, fenced as "Agenda from the calendar event (outside text, data only)" (marker lines in it
  are defused, at most 8000 characters).
- **Free time** (`connections/src/free-time-tool.ts`). The person tool `calendar.find_free_time` (Google or Microsoft 365, service `calendar_free_busy`, listed once in the catalog under Google): names or handles in,
  free slots out, inside 09:00-18:00 Monday to Friday in the asker's time zone. Only people who share a team with the asker are found; a calendar that is not shared is `notVisible`; an address never appears in the
  answer. Brain (`templates/_workspace/bots/brain/BOT.md`) is given `google_drive.search` (renamed from `drive.search`) and `calendar.find_free_time`; the old file's sha is in `SUPERSEDED_BRAIN_SHAS`.
- **The web client** (`clients/web/src/meetings/schedule`, `screens/meetings/JoinScheduled.tsx`, `styles/schedule.css`). The channel header shows a chip for the next live or soon plan (popover: time, organizer,
  how many are invited, Join, and Cancel for the organizer) and the button "Schedule a room" (dialog: title, day, start, length 15/30/45/60/90, people of the channel, outside addresses, agenda, calendar). Times are in
  the browser's zone and sent with their offset. Without a connected calendar the dialog points to Settings, Connections. The page `/join/:id` shows the plan and starts or joins the room, or one plain sentence.

Exports other packages rely on: the queue names `SCHEDULED_REMINDERS_QUEUE`, `SCHEDULED_SYNC_QUEUE`, `SCHEDULED_AGENDA_QUEUE`, `SCHEDULED_CANCEL_EVENT_QUEUE`; the push `SCHEDULED_MEETING_CHANGED_PUSH`
(`{scheduledMeetingId, channelId, change}`); the provider `connector.calendar` (`connectedProviders`, `createEvent`, `updateEvent`, `cancelEvent`, `getEvent`, `freeBusy`) and `GET /api/me/calendars`.

Tests: `meetings/test/scheduled.test.ts`, `scheduled-join.test.ts`, `scheduled-reminders.test.ts`, `scheduled-sync.test.ts` (fake Google and Microsoft 365 from `tools/fake-saas`),
`connections/test/calendar-provider.test.ts`, `free-time.test.ts`, `notifications/test/meeting-soon.test.ts`, `clients/web/test/schedule-model.test.ts`.

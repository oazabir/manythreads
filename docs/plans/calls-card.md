# Calls the way the owner asked, with event rows (Next ten item 6)

Covers PLAN.md P15-25 (start dialog), P15-26 (call card), P15-27 (invitations), P15-28 (tests) and P34-02 (event and status rows), with
`docs/plans/everyday-screens.md` findings 5–6, correction 10 and owner decision b (2026-11-19: the voice caption only when unusual, the played dot replaced).
Code read at `a77c907e`. Written by a planning agent, saved 2026-11-20; an independent review follows (S0) before building.

Words: **the outbox** = the queue of events written in the same transaction as the change (`ctx.audit.emit`). **RLS** = Postgres row policies. **The start
message** = the channel message a call posts when it opens, root of the call's chat thread (`meetings.thread_root_id`). **A stamp** = a key in a message's
`meta` only the platform may set.

## What exists and is reused
- **Starting a call:** `startRoom` (`packages/plugins/meetings/src/routes.ts:104-176`): get-or-create of the one live room per channel (`:118-130`), media room
  (`:134-142`), `meetings.meeting.started` (`:144-156`), plain-text start message `Started a voice room: <title>` in a savepoint (`:162`), `thread_root_id`
  (`:164`), caller joined (`:172`), DM ring (`:174`). No `meta`: the client matches a message to its room by `threadRootId` only.
- **P33's voice room card** (`clients/web/src/meetings/VoiceRoomCard.tsx`): live only (`:17-21`, `useRoomOfMessage` `store.ts:314-319`, `roomOfMessage`
  `roomCard.ts:9-11`); Join, "You are in this room", End room for the starter with one confirm (`EndRoomConfirm.tsx`); mounted under the text
  (`channels/MessageRow.tsx:491-492`); no ended state. **It becomes the call card; nothing is built beside it.**
- **Header voice icon** `VoiceButton.tsx` (start / scroll / join, `roomCard.ts:51-56` `voiceIconAction`; feeds the phone menu via `useHeaderItem`, `:47`).
- **Live updates:** every join, leave, end and note-taker change pushes `meeting.changed` (ids only) to readers (`live.ts:26-30`, `announceRoom`); the web
  re-reads the live list (`store.ts:165-171`). The card uses this push only.
- **Joined count** is kept: `meeting_participants` (`0001_meetings.sql:56-79`); `endRoom` counts into `participantCount` (`service.ts:117-140`).
- **Stamping:** `MessagePostInput.meta` (`packages/sdk/src/messages.ts:17-25`) checked by `ProviderMeta` (`packages/plugins/channels/src/capabilities.ts:130-147`),
  which already carries `meetingNotes`. A person's post takes no `meta` (`PostMessageRequest` strict, `packages/shared/src/api/messages/post-message.ts:4-24`);
  a caller's `meta` update is refused by `app.messages_before_update` (`channels/migrations/0017_voice_message_transcript.sql:7-35`). Shared `Message.meta` is a
  non-strict object that drops unknown keys (`packages/shared/src/entities/message.ts:73-102`): a new key must be added there.
- **Invited people pattern:** `scheduled_meeting_attendees` via a definer function keeping only `app.channel_audience(channel)` (`0005_scheduled.sql:48-60,
  157-160, 240-248`); notification `registerMeetingSoon` (`packages/plugins/notifications/src/meeting-soon.ts:25-81`; DND via `quietPeople`, `hold.ts:33-37`).
- **Note-taker:** `notetakerAvailability` (`notetaker.ts:156-178`) needs a live room with the caller in it; the add route (`:232-277`).
- **Dialog shell** `components/Dialog.tsx:14-61` (focus trap, Esc, `sheet`); the schedule dialog's member checklist (`meetings/schedule/ScheduleRoomDialog.tsx:131-145`)
  is extracted, not copied.
- **Meeting page data** `MeetingOverview` (`entities/meeting.ts:328-351`); `app.meetings_can_read_notes` (`0004_organizer_leaves.sql:17`).

## Data
### `packages/plugins/meetings/migrations/0007_call_card.sql` (forward-only)
1. `meetings.kind text NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio','video'))`; video refused with 409 "Video calls are not available yet" until P17-01;
   fixed after insert by the 0001 guard (`:144-159`); `MeetingKind` / `Meeting.kind` in shared (`schema-enums.test.ts` compares).
2. **`meta.meeting` stamp** = exactly `{ "meetingId": "<uuid>" }` (title, state and counts come from the card route; the message never changes with the call).
   Not settable by a person's post (no `meta`), a bot (no capability carries `meta`) or a caller's update (0017). Only the `messages` provider:
   `ProviderMeta.meeting: z.strictObject({ meetingId: z.uuid() }).optional()`. The database checks it whoever inserts: a `BEFORE INSERT` trigger
   `messages_meeting_stamp` (definer, owned by `manythreads_system`, fires after `messages_before_insert` by name order): for a non-system insert with
   `NEW.meta ? 'meeting'` the meeting must be in the same channel, `started_by = NEW.author_id`, `state = 'live'`, `thread_root_id IS NULL`, and the new message
   top-level; else `insufficient_privilege` (bad uuid: `check_violation`). One card per call:
   `CREATE UNIQUE INDEX messages_meeting_card ON app.messages ((meta->'meeting'->>'meetingId')) WHERE meta ? 'meeting'`. Declare `record`, not
   `app.meetings%ROWTYPE` (MISTAKES P15-13).
3. Tighten `app.meetings_guard`: a non-system change of `thread_root_id` only from NULL to a message whose `meta->'meeting'->>'meetingId' = NEW.id::text`.
4. Backfill in a `-- legacy-begin` / `-- legacy-end` block as the system role (pattern `approvals/migrations/0003_had_run.sql:24-31`): set
   `meta = meta || {meeting:{meetingId}}` on each meeting's top-level `thread_root_id` message not yet stamped. A `meta`-only update records no version, event or
   push (the AFTER UPDATE triggers fire only on body/deleted_at/body_plain). A test seeds legacy rows and runs the block (`approvals/test/rls/never-gated.test.ts:82`).

### `packages/plugins/meetings/migrations/0008_meeting_invites.sql`
`app.meeting_invites (meeting_id FK cascade, person_id FK cascade, display_name copied at insert, invited_by FK actors, invited_at, channel_id, team_id,
workspace_id)`, PK `(meeting_id, person_id)`, every FK indexed, `rls: team` comment, RLS enabled and forced; SELECT for system or
`channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])`; writes system only. Rows only through `app.meetings_invite(p_meeting_id, p_person_ids)
RETURNS uuid[]` (definer, like `meetings_schedule` `0005:128-176`): caller may post in the channel and the meeting is live; **the whole call is refused
(`insufficient_privilege`) when any id is not in `app.channel_audience(channel)`**; drops the caller and those already invited; at most 100 per call; returns the
new ones. No `allow_guests` column until P17-04.

### `packages/plugins/notifications/migrations/0008_meeting_invite.sql`
Kind `meeting_invite` and reference type `meeting_invite` (like `0007_meeting_soon.sql:8-11`); not `meeting`, which `meeting_actions` uses and would collide on the
`(person_id, ref_type, ref_id)` unique key (`0001_notifications.sql:30`).

### Shared
`Message.meta.meeting: z.object({ meetingId: MeetingId }).optional().catch(undefined)` (replaces P15-26's "message kind `call`"; correction 10 binds the
stamp). `MeetingKind`, `Meeting.kind`, `CallCard`, `CallInvitee`. `StartMeetingRequest` = `{ title?, kind?, inviteeIds? (≤100), allowGuests?: false,
notetakerBotId?: BotId|null }` strict, every field optional (the previous web sends `{ title }`); `StartMeetingResponse.invited`; new
`CallStartOptionsResponse`, `InviteToMeetingRequest/Response`, `ListCallCardsQuery/Response`. Typecheck every package after (MISTAKES P15-08).

## Events
`meetings.meeting.started` gains optional `kind` (additive in v1). New `meetings.invite.sent` v1 `{ workspaceId, teamId|null, channelId, meetingId, invitedBy,
personIds (1..100), first, at }` — ids only. Registry, meetings manifest `emits`, notifications `consumes`, audit `MAPPERS` entry beside
`meetings.meeting.started` (`packages/plugins/audit/src/spec.ts:836`), content-blind ("invited 3 people").

## Routes (meetings)
1. `GET /api/channels/:channelId/calls/options` (60/min): `canStart` (+reason, e.g. "Guests cannot start a call here"), `live`, `people` (channel audience, the
   caller first and locked; in a DM its people), `notetaker {bots, defaultBotId, available, reason}` (split `notetakerAvailability` into a place check and the
   room check), `guestLinks {available:false, reason}`. A person who cannot post gets `canStart:false` and no people.
2. `POST /api/channels/:channelId/meetings` (existing limit). One transaction: check kind/allowGuests/note-taker place availability (409 with the reason,
   nothing written)/invitees readers — **before `createRoom`** (the media room is made outside the transaction); get-or-create (when a call was live: only join,
   `invited:0`, the dialog says "A call was already going: you joined it"); post the start message with `meta.meeting`, `skipRefs: true`, body
   `Started a call: <title>` (written once, never rewritten); remove the savepoint (`routes.ts:159-168`) so a failed card fails the start with a plain reason;
   set `thread_root_id`, join, `app.meetings_invite` + `meetings.invite.sent`, note-taker through an `addNotetaker(ctx, tx, m, caller, botId)` taken out of the
   add route (`notetaker.ts:246-276`), ring (DM). Default title `Call · #dev · 14:02` / `Call · 14:02`.
3. `POST /api/meetings/:meetingId/invites` `{ personIds }` (20/min): live call, caller may post; `app.meetings_invite` decides; emits with `first:false`;
   `announceRoom`.
4. `GET /api/meetings/cards?ids=<≤50>` (120/min), through the caller's RLS (an unreadable call is not returned). `CallCard`: `meetingId, kind, title, state,
   startedBy, starterName, startedAt, endedAt, durationSeconds|null, present (5) + presentCount, joinedCount, invited {count, names (5)}, notetaker {name,
   listening}|null, you {joined, canEnd, canInvite}, notesLink|null` (only when `app.meetings_can_read_notes` and notes exist). Chosen over
   `listTeamMeetingsRoute?state=ended` (correction 10) because that route is per team (no DM calls, `routes.ts:315-323`) and stops at the newest 100.

## Web
- **Start dialog** `meetings/StartCallDialog.tsx` (P15-25): `VoiceButton` becomes "Audio call" (`data-testid="call-start"` kept); nothing live → dialog; live →
  P33's show/join, "Join call". No Video button until P17-01. `Dialog` with `sheet` on the phone. Title (prefilled, ≤120, autofocus); `PeopleChecklist`
  extracted from `ScheduleRoomDialog.tsx:131-145` and used by both (filter, "4 of 12 match" in a `role="status"` line, starter ticked and disabled, Select all
  for the shown); guest switch disabled "Guest links are not available yet"; note-taker on by default naming the bot (or a select), off with the server's reason,
  with "Everyone is asked before their voice is written down"; Start call / Cancel; a 409 shown in the dialog (a note-taker refusal turns the switch off). In a
  DM: "Everyone in this conversation is rung" instead of the list.
- **Call card** (P15-26) = `VoiceRoomCard.tsx` grown: a message with `m.meta.meeting` draws the card in place of the text (branch chain with `meetingNotes`,
  `todoRef`, `MessageRow.tsx:466-486`); the P33 mount below the text goes. Keeps Join, "You are in this call", End with `EndRoomConfirm` and P33's focus rules;
  adds Audio chip, "Started by Nadia · 14:02", Live chip with running time, faces (5, "+3"), invited names, "Note-taker listening", **Invite more**
  (`PeopleChecklist` in a small dialog), whole card joins. Ended: the event row below with the notes link. DM: "Missed call" for a reader who never joined. One
  column at 390. Data: `meetings/callCards.ts` batches stamped ids in view (100 ms), drops cards not returned, re-asks one id on `meeting.changed`
  (next to `onRoomChanged`, `store.ts:165-171`). Unstamped fallback keeps `useRoomOfMessage` until S7. `roomCard.ts` gains `callCardFacts` and `eventLine`.
  Classes keep the `room-card-*` prefix; selectors with a parent (MISTAKES P33).
- **Event rows** (P34-02, findings 5 and 9): a stamped message never joins a run (`standsAlone`, `channels/runs.ts:10-11`), no avatar block. Ended call = one
  muted line with the headset icon "Omar started a call · 22:14 · 14 min · 3 joined" (+ "Notes" when `notesLink`, + replies). Before its card loads, the same
  one-line start at the same height (no jump; MISTAKES P34-04). **Fold:** a `callRun` list item for two or more stamped messages in a row on one day, decided
  from `meta` only ("2 calls · Show", expands in place; a live one drawn outside the fold — only one live per channel, `0001:42`). The to-do "moved" line
  (`todo-card/TodoMessage.tsx:16-21`) takes the event-line class. Finding 9: `.rcEnd` (`styles/run-card.css:573`) at the text column on the phone.
- **Voice caption** (decision b, finding 6): in `channels/voice/VoicePlayer.tsx:166-178` the `server`/`edited` captions only when partial ("of the first
  20 seconds"); "Transcript" and "Transcript (edited)" go; failed and missing keep their lines (`:180-190`); the device note stays. The played dot `vp-heard`
  (`VoicePlayer.tsx:105-110`, `voice-player.css:116-124`) goes: the length turns from faint to normal once played, `title="Played"` and an aria-label.

## Notifications (P15-27)
New consumer `packages/plugins/notifications/src/meeting-invite.ts` on `meetings.invite.sent`, following `meeting-soon.ts:25-81`: title and starter name from
the meeting, skip an ended call, keep only people still in the audience, `held_at` for DND, kind/ref `meeting_invite`, preview "Nadia invited you to Design
review", announce the rest; no channel level silences it (`notification-level.ts:39`, `prefs.ts:26`). Push (`push.ts:17,47,61`): "You are invited to a call"
("…in #dev" only for an open channel), address `/open?channel=<id>&message=<threadRootId>`. Web inbox label with Join (`notifications/store.ts:69-70`).
**The DM ring stays the DM's invitation** (no second inbox item; `live.ts:39-62`, "Missed call" job `:69-90`); the web keeps the ring card but makes no sound
or system notification while the person's own DND is on (`store.ts:191-198`). An invitation decides who is told, not who may join.

## Bots that must wait for a person
None: the note-taker only listens (consent prompt P15-05 per person); invitations and the ring involve no bot; "Missed call" is a timed job. No approval filed.

## Tests (P15-28)
Contract (`meta.meeting` round trip and a bad value dropped; `CallCard`, `StartMeetingRequest`, `meetings.invite.sent`; schema-compat). RLS
(`meetings/test/rls/meetings-calls-rls.test.ts`, pattern `meetings-bundle-d-rls.test.ts:95-174`): forged stamps refused (another's call, another channel, ended,
already stamped), one card per call, `thread_root_id` only to a stamped message, invites unreadable to non-readers and direct INSERT 42501, `meetings_invite`
refuses a list with one non-reader and caps at 100, the backfill stamps legacy start messages only. Plugin: one transaction for start with invitees and
note-taker; 409 writes nothing; start while live invites nobody; the card is the same message after join and end; cards route omits unreadable channels;
`notesLink` only when readable; video 409; `relaxedRateLimiter()` (MISTAKES P15-21). Notifications (`meeting-invite.test.ts`). Web unit (`callCardFacts`,
`eventLine`, `voiceIconAction`, `PeopleChecklist`, dialog rules, fold, `standsAlone`, caption rule). e2e with the fake media server (`MANYTHREADS_STACK_MEETINGS=1`).
Specs and journeys to change: `e2e/meetings/support.ts:76-108` `enterRoom` (and every spec using it), name checks in `room.spec.ts`, `mobile-web.spec.ts`,
`channel-header.spec.ts`, `header-pictures.spec.ts`, picture tools (`visual/meetings`, `task.verify-bundle-c/d.shots.ts`), journeys
(`lena/L4-rooms-and-groups`, `nadia/N8-schedule-room`), captions `docs/journeys/captions.yaml:41, 329-330`. Baselines at 1440 and 390, light and dark.

## Order of work (each step deploys alone)
| Step | What | Side |
|---|---|---|
| S0 | This plan, an independent review | doc |
| S1 | Meetings 0007 (kind, stamp trigger and index, guard, backfill); `ProviderMeta.meeting`; shared `meta.meeting`; start posts the stamp with `skipRefs`; `GET /api/meetings/cards`; tests | server |
| S2 | `CallCard` on `VoiceRoomCard` (live, ended), `callCards` store, event row, `standsAlone`, fold; P33 specs | web |
| S3 | P34-02 web-only: status line look, `.rcEnd` on the phone, voice caption rule b, played dot | web |
| S4 | Meetings 0008 invites and `app.meetings_invite`; `meetings.invite.sent` + audit; start body; options and invites routes; `addNotetaker` | server |
| S5 | Notifications 0008 and the consumer; push words; inbox label | server, web |
| S6 | `StartCallDialog`, `PeopleChecklist`, "Audio call"/"Join call", Invite more, quiet ring in DND; `enterRoom` and the listed specs, journeys, captions | web |
| S7 | Fake-media e2e; baselines and journey pictures; fallback removed; docs (`meetings.md`, `notifications.md`); PLAN/STATUS | tests, docs |
| S8 | Deploy and live check as Omar at 1440 and 390 in a scratch channel | live |

## Risks
Media room outside the transaction (check before `createRoom`; an empty LiveKit room closes itself). The card now fails a start where the room used to open
(intended; the error names the cause). A trigger on another plugin's table (comes with the meetings migration; `record`). Row height (one-line placeholder;
only the newest card per channel can be live). Wording: P33's "End room"/"voice room" become "call" (the owner's word in P15-25..27; strings only if the owner
prefers otherwise). Search keeps old "Started a voice room" bodies (no body rewrite). Deviations from PLAN.md, stated: the cards route instead of the team list;
no `allow_guests` until P17-04; the event name `meetings.invite.sent`; the body not kept live; no separate DM inbox item.

## Done
The dialog starts a call (title, readers-only filterable checklist, note-taker on by default or off with a reason, guest switch disabled) in one transaction
with one stamped card, invitations and the note-taker; invitees get a push and an inbox item held by DND; a DM rings 30 s (silent in DND) and leaves "Missed
call"; the card follows the call in place; ended, it is one event row with Notes only for readers; consecutive calls fold; old start messages show the same
row; forged stamps and invites to non-readers refused (RLS tests); status lines share the event look; the run row aligns on the phone; the voice caption only
when partial, missing or failed; the played dot gone; gates green; specs, journeys, captions and baselines updated; S8 live check done.

## Corrections after the independent review (2026-11-20, binding; they override the text above where they differ)
1. **The stamp trigger's caller check.** Inside a definer function owned by `manythreads_system`, `app.is_system()` is always true (it reads `current_user`,
   `kernel/migrations/0003_system_role.sql:60-62`; MISTAKES.md records this three times). The trigger is an **invoker** function (the caller can read its own
   channel's meeting), so `is_system()` means what it says. It is declared `WHEN (NEW.meta ? 'meeting')` so ordinary posts never run it. An RLS test shows a
   plain person's direct INSERT of a stamp failing with 42501.
2. **The guard still lets `thread_root_id` go to NULL** (the `ON DELETE SET NULL` cascade runs as the table owner, `meetings/0001:36`). Only the change from
   NULL to a message must point at a message stamped with this meeting.
3. **The backfill stamps only real start messages:** `msg.author_id = m.started_by`, `msg.channel_id = m.channel_id`, `msg.thread_root_id IS NULL` and
   `msg.body LIKE 'Started a voice room:%'` (the old guard let a caller point `thread_root_id` at any message).
4. **No folding in this item.** Each ended call is already one muted event line, which answers finding 5. A collapsed fold would hide message keys that
   `scrollToKey`, the `[data-key]` lookup, `messageShown` and the unread divider look for (ChannelView.tsx:215, 306, 419-420; listItems.ts:26), and the
   invitation's `/open?message=` target. If it is still wanted after S8, it comes back as its own task with those cases.
5. **Order inside the start route:** every database write first (stamped message, `thread_root_id`, join, invites, note-taker), `createRoom` last before the
   token, so a refused start leaves no media room. The note-taker's listener is a job after commit (`notetaker.ts:271`). `addNotetaker` at start skips the
   consent reset (one person in the room).
6. **The scheduled join route also calls `startRoom`** (`routes-scheduled.ts:112`): it gets the stamp and "a failed card fails the start" too; tested.
7. **The stamped message:** Edit is hidden for it in the web; copy text reads the card (`plainText`, MessageRow.tsx:173). If its author or a lead deletes it, the
   call keeps running without a card; the "Missed call" job skips (no reply to a deleted root) instead of failing and retrying (`live.ts:83`).
8. **The thread pane** shows the call's root as the card (live) or the event line (ended), never the bare start text.
9. **`meeting_invites`** gets the attendees' composite FK `(meeting_id, channel_id)` (needs a unique key on `meetings (id, channel_id)`); `meetings_invite`
   refuses a room with no channel; the policy wraps `(SELECT app.is_system())` (MISTAKES.md:27).
10. **The unique index** is built without CONCURRENTLY (a migration runs in a transaction): it blocks writes on `app.messages` for the build, fine at the current size.
11. **More to update:** `e2e/meetings/call-thread.spec.ts`, `e2e/channels/room-voice-message.spec.ts`, `e2e/api/meetings/guards.spec.ts`;
    `clients/web/test/phone-header-menu.test.ts:105,131`, `meetings-call.test.ts`, `meetings-live.test.ts`, `meetings-model.test.ts`, `channel-header.test.ts`;
    PLAN.md:930 and `docs/plans/channel-header.md` wording.

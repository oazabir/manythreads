import {
  HttpError,
  conflict,
  forbidden,
  json,
  notFound,
  requireTeam,
  route,
  type MediaProvider,
  type MessageProvider,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import {
  EndMeetingResponse,
  GetMeetingResponse,
  JoinMeetingResponse,
  LeaveMeetingResponse,
  ListMeetingsQuery,
  ListMeetingsResponse,
  ListTeamMeetingsPathParams,
  MeetingHeartbeatRequest,
  MeetingHeartbeatResponse,
  MeetingPathParams,
  MeetingsMeetingStartedEvent,
  MeetingsParticipantLeftEvent,
  MediaStatusResponse,
  RenewMeetingTokenResponse,
  StartMeetingPathParams,
  StartMeetingRequest,
  StartMeetingResponse,
  abuseLimit,
  endMeetingRoute,
  getMeetingRoute,
  heartbeatMeetingRoute,
  joinMeetingRoute,
  leaveMeetingRoute,
  listMyLiveMeetingsRoute,
  listTeamMeetingsRoute,
  mediaStatusRoute,
  renewMeetingTokenRoute,
  startMeetingRoute,
  type GuestLinkMade,
  type MeetingJoin,
} from '@manythreads/shared';
import { mediaFailure, mediaStatus, requireMedia, bestEffort } from './media.ts';
import { MEETING_COLUMNS, loadMeeting, summaries, toMeeting, type MeetingRow } from './rows.ts';
import { announceRoom, ringDirectMessage } from './live.ts';
import { MEETING_SERVICE_SEATS, assertRoomHasSpace, roomCap } from './limits.ts';
import { emitJoined, endRoom, scheduleAutoEnd } from './service.ts';
import { channelFacts, inviteToCall } from './invites.ts';
import { addNotetaker } from './notetaker.ts';
import { makeGuestLink } from './guests.ts';

// The routes of voice rooms (docs/plugins/meetings.md). Every route but the media server's webhook runs as the caller, so the row-level security of the tables
// decides who sees a room: whoever can read the channel. Starting needs the right to post there. Nothing here hands a media token to a bot.

export interface Caller {
  actorId: string;
  personId: string;
}

/** The signed-in person; voice rooms are for people, so a bot is refused. */
export async function callerPerson(tx: PluginTx): Promise<Caller> {
  const row = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
  if (!row?.person || !row.actor) throw forbidden('Voice rooms are for people');
  return { actorId: row.actor, personId: row.person };
}

/**
 * The title of a call whose starter wrote none (the time in UTC): "Call · #dev · 14:02" in a channel, "Call · 14:02" in a direct message or any other conversation, whose
 * name is no title.
 */
export function defaultTitle(now: Date, channel: { kind: string; name: string } | null): string {
  const time = now.toISOString().slice(11, 16);
  const name = channel?.kind === 'channel' ? [...channel.name.replace(/^#/, '')].slice(0, 80).join('') : '';
  return name === '' ? `Call · ${time}` : `Call · #${name} · ${time}`;
}

/**
 * Puts the caller in the room (or leaves them in it): the database half of a join. Returns the name the person is in the room by, for their media token. Nothing here asks
 * the media server, so a start can make every database write before the media room exists.
 */
async function enterRoom(ctx: PluginContext, tx: PluginTx, m: MeetingRow, caller: Caller): Promise<string> {
  if (m.state !== 'live') throw conflict('This voice room has ended');
  const existing = (
    await tx.query<{ left_at: Date | null }>('SELECT left_at FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid', [m.id, caller.actorId])
  ).rows[0];
  const present = existing !== undefined && existing.left_at === null;
  if (!present) {
    await assertRoomHasSpace(tx, m.id);
  }
  const row = (
    await tx.query<{ display_name: string }>(
      `INSERT INTO app.meeting_participants (meeting_id, actor_id) VALUES ($1::uuid, $2::uuid)
       ON CONFLICT (meeting_id, actor_id) DO UPDATE SET left_at = NULL
       RETURNING display_name`,
      [m.id, caller.actorId],
    )
  ).rows[0]!;
  if (!present) {
    await emitJoined(ctx, tx, m, caller.actorId, existing !== undefined);
    await announceRoom(ctx, tx, m);
  }
  return row.display_name;
}

/** The caller's media token for the room: the one step a join takes on the media server. */
async function mediaToken(media: MediaProvider, m: MeetingRow, caller: Caller, displayName: string): Promise<MeetingJoin> {
  let token;
  try {
    token = await media.token({ id: caller.actorId, kind: 'person', displayName }, m.id, { canPublish: true, canSubscribe: true });
  } catch (err) {
    throw mediaFailure(err);
  }
  return { provider: token.provider, url: token.url, token: token.token, identity: token.identity as MeetingJoin['identity'], roomName: token.roomName, expiresAt: token.expiresAt.toISOString() };
}

/** Puts the caller in the room (or leaves them in it) and makes their token. The media server is asked only after the database accepted the person. */
export async function joinAndToken(ctx: PluginContext, tx: PluginTx, media: MediaProvider, m: MeetingRow, caller: Caller): Promise<MeetingJoin> {
  const name = await enterRoom(ctx, tx, m, caller);
  return mediaToken(media, m, caller, name);
}

/** The words of a call's start message, written once and never rewritten (the card shows the live title and state). */
export function startMessageBody(title: string): string {
  return `Started a call: ${title}`;
}

/**
 * Gets or makes the one live room of a channel and puts the caller in it. Used by the start route and by the join route of a planned room (`scheduledMeetingId`: the new room remembers
 * its plan, and the database marks the plan `started`). A second start in the same moment, or while a room is live, comes back with the room that is there (`created: false`).
 *
 * A new room makes every database write first (the started event, the start message stamped with `meta.meeting`, the thread, the starter's place, the invitations, the
 * note-taker, `onCreated`, the ring of a direct message) and asks the media server for the room last, just before the token: the media room lives outside the transaction, so a
 * start the database refuses leaves no media room behind (review correction 5). The start message is the call card; when it cannot be written the start fails with the reason
 * instead of opening a call without one. Joining a call that was already live invites nobody and adds no note-taker (`invited: 0`).
 *
 * `inviteeIds` are asked to a new call in a channel (P15-27); in a direct message everyone is rung instead, so they are not used there. `notetakerBotId` is added as the call
 * opens, through the same checks as the add route; a refusal fails the whole start with the reason.
 */
export async function startRoom(
  ctx: PluginContext,
  tx: PluginTx,
  input: {
    channelId: string;
    title: string | undefined;
    caller: Caller;
    scheduledMeetingId?: string;
    inviteeIds?: readonly string[];
    notetakerBotId?: string | null;
    /** A video call (P36-02); audio when absent. A start while a call is live joins that call, whichever kind it is: one call per channel in total. */
    kind?: 'audio' | 'video';
    onCreated?: (m: MeetingRow) => Promise<void>;
  },
): Promise<{ m: MeetingRow; created: boolean; join: MeetingJoin; invited: number }> {
  const { channelId, caller } = input;
  const media = requireMedia(ctx);
  // Whoever may post in the channel may start a room there; a channel the caller cannot read looks the same as one they cannot post in.
  const can = (await tx.query<{ ok: boolean | null }>("SELECT app.lookup_channel_can($1::uuid, 'post') AS ok", [channelId])).rows[0]?.ok;
  if (can !== true) throw forbidden('You cannot start a voice room in this channel');
  const now = ctx.runtime.now();
  const channel = (await channelFacts(tx, channelId)) ?? null;
  const ids = (await tx.query<{ id: string; workspace_id: string }>('SELECT uuidv7() AS id, app.workspace_id() AS workspace_id')).rows[0]!;
  // One live room per channel: a second start in the same moment, or while a room is live, comes back with the room that is there.
  const row = await ctx.db.getOneOrCreate<{ id: string }>(tx, {
    table: 'app.meetings',
    values: {
      id: ids.id,
      workspace_id: ids.workspace_id,
      channel_id: channelId,
      title: input.title ?? defaultTitle(now, channel),
      started_by: caller.actorId,
      organizer_id: caller.actorId,
      kind: input.kind ?? 'audio',
      ...(input.scheduledMeetingId ? { scheduled_meeting_id: input.scheduledMeetingId } : {}),
    },
    conflict: ['channel_id'],
    conflictWhere: "state = 'live' AND channel_id IS NOT NULL",
    returning: ['id'],
  });
  const created = row.id === ids.id;
  const m = await loadMeeting(tx, row.id);
  if (!m) throw notFound('That voice room is not available');
  if (!created) return { m, created, join: await joinAndToken(ctx, tx, media, m, caller), invited: 0 };

  await ctx.audit.emit(
    tx,
    MeetingsMeetingStartedEvent.parse({
      type: 'meetings.meeting.started',
      schemaVersion: 1,
      workspaceId: m.workspace_id,
      teamId: m.team_id,
      channelId: m.channel_id,
      meetingId: m.id,
      startedBy: caller.actorId,
      kind: m.kind,
      at: m.started_at.toISOString(),
    }),
  );
  // The call card: a top-level message in the channel, stamped with the meeting (the database checks the stamp), that people reply to. It names nobody, so it links and
  // notifies nobody (`skipRefs`), whatever the title says.
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) throw conflict('Calls cannot start: messages are not available on this server.');
  let root;
  try {
    root = await messages.post(tx, { channelId, body: startMessageBody(m.title), meta: { meeting: { meetingId: m.id } }, skipRefs: true });
  } catch (err) {
    // a refusal of the channel (archived, read-only, not yours) keeps its own plain words; anything else is said once, plainly, and the whole start is undone
    if (err instanceof HttpError) throw err;
    // a serialization failure, a deadlock or a lost connection keeps its code, so the request is retried as any other would be
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && (code === '40001' || code === '40P01' || code.startsWith('08'))) throw err;
    throw conflict('The call could not start: its message could not be posted in this channel.');
  }
  await tx.query('UPDATE app.meetings SET thread_root_id = $2::uuid WHERE id = $1::uuid', [m.id, root.id]);
  m.thread_root_id = root.id;
  const name = await enterRoom(ctx, tx, m, caller);
  // the people asked to the call (the database refuses the whole list if one of them cannot read the channel), then the note-taker
  const invited = channel?.kind === 'dm' ? [] : await inviteToCall(ctx, tx, m, caller, input.inviteeIds ?? [], true);
  if (input.notetakerBotId) await addNotetaker(ctx, tx, m, caller, input.notetakerBotId, { atStart: true });
  // no second push for the invitations: the join above already told the readers, and a push is delivered at the commit, when the invitations are there to read
  if (input.onCreated) await input.onCreated(m);
  // a new call in a direct message rings the other people for thirty seconds (a job writes "Missed call" if nobody picks up)
  await ringDirectMessage(ctx, tx, m, { actorId: caller.actorId, personId: caller.personId });
  try {
    // The media server enforces the workspace's room size too (a client that skips our join route still cannot get past it), plus the seats of the two hidden
    // service members (the note-taker's listener and the recorder). The size is the one in force when the room opens; the join route reads the live setting.
    await media.createRoom({ name: m.id, maxParticipants: (await roomCap(tx)) + MEETING_SERVICE_SEATS });
  } catch (err) {
    throw mediaFailure(err);
  }
  return { m, created, join: await mediaToken(media, m, caller, name), invited: invited.length };
}

export function registerMeetingRoutes(ctx: PluginContext): void {
  // ---- media status -------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...mediaStatusRoute,
    schema: { response: MediaStatusResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: () => json(MediaStatusResponse.parse(mediaStatus(ctx))),
  });

  // ---- start (get or create) ----------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...startMeetingRoute,
    schema: { body: StartMeetingRequest, response: StartMeetingResponse },
    rateLimit: abuseLimit('POST', startMeetingRoute.path),
    handler: route(async (req, tx) => {
      const { channelId } = StartMeetingPathParams.parse(req.params);
      const body = StartMeetingRequest.parse(req.body ?? {});
      const caller = await callerPerson(tx);
      // guest links on (P17-04): the starter's first link is made as the call opens, in the same transaction, so a refusal (a direct message, the workspace switch
      // off, a workspace guest) undoes the whole start with its reason; joining a call that was already live makes no link
      let guestLink: GuestLinkMade | null = null;
      const { m, created, join, invited } = await startRoom(ctx, tx, {
        channelId,
        title: body.title,
        caller,
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.inviteeIds ? { inviteeIds: body.inviteeIds } : {}),
        ...(body.notetakerBotId ? { notetakerBotId: body.notetakerBotId } : {}),
        ...(body.allowGuests === true
          ? {
              onCreated: async (room: MeetingRow) => {
                guestLink = await makeGuestLink(ctx, tx, room, caller, true);
              },
            }
          : {}),
      });
      // the note-taker or the guest link may have changed the call: the answer shows it as it is now
      const fresh = created && (body.notetakerBotId || guestLink) ? ((await loadMeeting(tx, m.id)) ?? m) : m;
      return json(StartMeetingResponse.parse({ meeting: toMeeting(fresh), created, join, invited, guestLink }), 200);
    }),
  });

  // ---- join / renew the token ---------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...joinMeetingRoute,
    schema: { response: JoinMeetingResponse },
    rateLimit: abuseLimit('POST', joinMeetingRoute.path),
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const media = requireMedia(ctx);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const join = await joinAndToken(ctx, tx, media, m, caller);
      return json(JoinMeetingResponse.parse({ meeting: toMeeting(m), join }));
    }),
  });

  ctx.http.route({
    ...renewMeetingTokenRoute,
    schema: { response: RenewMeetingTokenResponse },
    rateLimit: abuseLimit('POST', renewMeetingTokenRoute.path),
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const media = requireMedia(ctx);
      const caller = await callerPerson(tx);
      // Reading the room is the test: a person removed from the channel finds no room here, and gets no new token.
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      if (m.state !== 'live') throw conflict('This voice room has ended');
      const me = (
        await tx.query<{ display_name: string }>('SELECT display_name FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid AND left_at IS NULL', [m.id, caller.actorId])
      ).rows[0];
      if (!me) throw conflict('You are not in this voice room. Join it first.');
      let token;
      try {
        token = await media.token({ id: caller.actorId, kind: 'person', displayName: me.display_name }, m.id, { canPublish: true, canSubscribe: true });
      } catch (err) {
        throw mediaFailure(err);
      }
      const join: MeetingJoin = { provider: token.provider, url: token.url, token: token.token, identity: token.identity as MeetingJoin['identity'], roomName: token.roomName, expiresAt: token.expiresAt.toISOString() };
      return json(RenewMeetingTokenResponse.parse({ join }));
    }),
  });

  // ---- leave --------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...leaveMeetingRoute,
    schema: { response: LeaveMeetingResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const gone = await tx.query(
        'UPDATE app.meeting_participants SET left_at = now() WHERE meeting_id = $1::uuid AND actor_id = $2::uuid AND left_at IS NULL RETURNING actor_id',
        [m.id, caller.actorId],
      );
      if (gone.rows.length > 0) {
        await tx.query('DELETE FROM app.meeting_presence WHERE meeting_id = $1::uuid AND actor_id = $2::uuid', [m.id, caller.actorId]);
        await ctx.audit.emit(
          tx,
          MeetingsParticipantLeftEvent.parse({
            type: 'meetings.participant.left',
            schemaVersion: 1,
            workspaceId: m.workspace_id,
            teamId: m.team_id,
            channelId: m.channel_id,
            meetingId: m.id,
            actorId: caller.actorId,
            how: 'left',
            at: ctx.runtime.now().toISOString(),
          }),
        );
        await scheduleAutoEnd(ctx, tx, m.id, m.workspace_id);
        await announceRoom(ctx, tx, m);
        const media = ctx.providers.get<MediaProvider>('media');
        if (media && media.status().configured) await bestEffort(undefined, 'dropping a participant', () => media.kick(m.id, caller.actorId));
      }
      return json(LeaveMeetingResponse.parse({ meeting: toMeeting((await loadMeeting(tx, m.id)) ?? m) }));
    }),
  });

  // ---- end ----------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...endMeetingRoute,
    schema: { response: EndMeetingResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      // The database checks who may end it (the starter, a lead of the team, a workspace admin) and refuses anyone else with 403.
      await endRoom(ctx, tx, m.id, 'person');
      return json(EndMeetingResponse.parse({ meeting: toMeeting((await loadMeeting(tx, m.id)) ?? m) }));
    }),
  });

  // ---- read ---------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...getMeetingRoute,
    schema: { response: GetMeetingResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const [summary] = await summaries(tx, [m]);
      return json(GetMeetingResponse.parse(summary));
    }),
  });

  ctx.http.route({
    ...listTeamMeetingsRoute,
    schema: { query: ListMeetingsQuery, response: ListMeetingsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { slug } = ListTeamMeetingsPathParams.parse(req.params);
      const { state, limit } = ListMeetingsQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      const rows = await tx.query<MeetingRow & Record<string, unknown>>(
        `SELECT ${MEETING_COLUMNS} FROM app.meetings m WHERE m.team_id = $1::uuid AND m.state = $2 ORDER BY m.started_at DESC, m.id DESC LIMIT $3`,
        [team.id, state, limit],
      );
      return json(ListMeetingsResponse.parse({ meetings: await summaries(tx, rows.rows) }));
    }),
  });

  ctx.http.route({
    ...listMyLiveMeetingsRoute,
    schema: { response: ListMeetingsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (_req, tx) => {
      const rows = await tx.query<MeetingRow & Record<string, unknown>>(
        `SELECT ${MEETING_COLUMNS} FROM app.meetings m WHERE m.state = 'live' ORDER BY m.started_at DESC, m.id DESC LIMIT 100`,
      );
      return json(ListMeetingsResponse.parse({ meetings: await summaries(tx, rows.rows) }));
    }),
  });

  // ---- heartbeat ----------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...heartbeatMeetingRoute,
    schema: { body: MeetingHeartbeatRequest, response: MeetingHeartbeatResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const body = MeetingHeartbeatRequest.parse(req.body ?? {});
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      if (m.state !== 'live') throw conflict('This voice room has ended');
      const here = await tx.query('SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid AND left_at IS NULL', [m.id, caller.actorId]);
      if (here.rows.length === 0) throw conflict('You are not in this voice room. Join it first.');
      await tx.query(
        `INSERT INTO app.meeting_presence (meeting_id, actor_id, seen_at, speaking) VALUES ($1::uuid, $2::uuid, now(), $3)
         ON CONFLICT (meeting_id, actor_id) DO UPDATE SET seen_at = now(), speaking = EXCLUDED.speaking`,
        [m.id, caller.actorId, body.speaking],
      );
      // the server's clock, so the device can place its lines on the meeting clock (`startMs`) whatever its own clock says
      return json({ ok: true, serverNow: ctx.runtime.now().toISOString() });
    }),
  });
}

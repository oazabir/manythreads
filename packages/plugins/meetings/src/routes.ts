import {
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
  MEETING_MAX_PARTICIPANTS,
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
  type MeetingJoin,
} from '@manythreads/shared';
import { mediaFailure, mediaStatus, requireMedia, bestEffort } from './media.ts';
import { MEETING_COLUMNS, loadMeeting, summaries, toMeeting, type MeetingRow } from './rows.ts';
import { announceRoom, ringDirectMessage } from './live.ts';
import { emitJoined, endRoom, scheduleAutoEnd } from './service.ts';

// The routes of voice rooms (docs/plugins/meetings.md). Every route but the media server's webhook runs as the caller, so the row-level security of the tables
// decides who sees a room: whoever can read the channel. Starting needs the right to post there. Nothing here hands a media token to a bot.

interface Caller {
  actorId: string;
  personId: string;
}

/** The signed-in person; voice rooms are for people, so a bot is refused. */
async function callerPerson(tx: PluginTx): Promise<Caller> {
  const row = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
  if (!row?.person || !row.actor) throw forbidden('Voice rooms are for people');
  return { actorId: row.actor, personId: row.person };
}

/** "Voice room · 14:02" (UTC): the title of a room whose starter wrote none. */
export function defaultTitle(now: Date): string {
  return `Voice room · ${now.toISOString().slice(11, 16)}`;
}

/** Puts the caller in the room (or leaves them in it) and makes their token. The media server is asked only after the database accepted the person. */
async function joinAndToken(ctx: PluginContext, tx: PluginTx, media: MediaProvider, m: MeetingRow, caller: Caller): Promise<MeetingJoin> {
  if (m.state !== 'live') throw conflict('This voice room has ended');
  const existing = (
    await tx.query<{ left_at: Date | null }>('SELECT left_at FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid', [m.id, caller.actorId])
  ).rows[0];
  const present = existing !== undefined && existing.left_at === null;
  if (!present) {
    const people = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.meeting_participants WHERE meeting_id = $1::uuid AND left_at IS NULL', [m.id])).rows[0]!.n;
    if (people >= MEETING_MAX_PARTICIPANTS) throw conflict(`This voice room is full (${MEETING_MAX_PARTICIPANTS} people)`);
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
  let token;
  try {
    token = await media.token({ id: caller.actorId, kind: 'person', displayName: row.display_name }, m.id, { canPublish: true, canSubscribe: true });
  } catch (err) {
    throw mediaFailure(err);
  }
  return { provider: token.provider, url: token.url, token: token.token, identity: token.identity as MeetingJoin['identity'], roomName: token.roomName, expiresAt: token.expiresAt.toISOString() };
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
      const media = requireMedia(ctx);
      const caller = await callerPerson(tx);
      // Whoever may post in the channel may start a room there; a channel the caller cannot read looks the same as one they cannot post in.
      const can = (await tx.query<{ ok: boolean | null }>("SELECT app.lookup_channel_can($1::uuid, 'post') AS ok", [channelId])).rows[0]?.ok;
      if (can !== true) throw forbidden('You cannot start a voice room in this channel');
      const now = ctx.runtime.now();
      const ids = (await tx.query<{ id: string; workspace_id: string }>('SELECT uuidv7() AS id, app.workspace_id() AS workspace_id')).rows[0]!;
      // One live room per channel: a second start in the same moment, or while a room is live, comes back with the room that is there.
      const row = await ctx.db.getOneOrCreate<{ id: string }>(tx, {
        table: 'app.meetings',
        values: {
          id: ids.id,
          workspace_id: ids.workspace_id,
          channel_id: channelId,
          title: body.title ?? defaultTitle(now),
          started_by: caller.actorId,
          organizer_id: caller.actorId,
        },
        conflict: ['channel_id'],
        conflictWhere: "state = 'live' AND channel_id IS NOT NULL",
        returning: ['id'],
      });
      const created = row.id === ids.id;
      const m = await loadMeeting(tx, row.id);
      if (!m) throw notFound('That voice room is not available');
      if (created) {
        try {
          await media.createRoom({ name: m.id, maxParticipants: MEETING_MAX_PARTICIPANTS });
        } catch (err) {
          throw mediaFailure(err);
        }
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
            at: m.started_at.toISOString(),
          }),
        );
        // The call's chat thread: a message in the channel that people reply to. If it cannot be written, the room still opens.
        const messages = ctx.providers.get<MessageProvider>('messages');
        if (messages) {
          await tx.query('SAVEPOINT meeting_thread');
          try {
            const root = await messages.post(tx, { channelId, body: `Started a voice room: ${m.title}` });
            await tx.query('RELEASE SAVEPOINT meeting_thread');
            await tx.query('UPDATE app.meetings SET thread_root_id = $2::uuid WHERE id = $1::uuid', [m.id, root.id]);
            m.thread_root_id = root.id;
          } catch {
            await tx.query('ROLLBACK TO SAVEPOINT meeting_thread');
            await tx.query('RELEASE SAVEPOINT meeting_thread');
          }
        }
      }
      const join = await joinAndToken(ctx, tx, media, m, caller);
      // a new call in a direct message rings the other people for thirty seconds (a job writes "Missed call" if nobody picks up)
      if (created) await ringDirectMessage(ctx, tx, m, { actorId: caller.actorId, personId: caller.personId });
      return json(StartMeetingResponse.parse({ meeting: toMeeting(m), created, join }), 200);
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

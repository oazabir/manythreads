import { json, notFound, conflict, route, type PluginContext } from '@manythreads/sdk';
import {
  CancelScheduledMeetingResponse,
  CreateScheduledMeetingRequest,
  CreateScheduledMeetingResponse,
  GetScheduledMeetingResponse,
  JoinScheduledMeetingResponse,
  ListScheduledMeetingsQuery,
  ListScheduledMeetingsResponse,
  ScheduledMeetingPathParams,
  ScheduledMeetingsChannelParams,
  UpdateScheduledMeetingRequest,
  UpdateScheduledMeetingResponse,
  abuseLimit,
  cancelScheduledMeetingRoute,
  createScheduledMeetingRoute,
  getScheduledMeetingRoute,
  joinScheduledMeetingRoute,
  listScheduledMeetingsRoute,
  updateScheduledMeetingRoute,
} from '@manythreads/shared';
import { requireMedia } from './media.ts';
import { callerPerson, joinAndToken, startRoom } from './routes.ts';
import { loadMeeting, toMeeting } from './rows.ts';
import { afterRoomOpened, cancelScheduled, createScheduled, listScheduled, liveRoomOf, loadScheduled, scheduledGate, toScheduled, updateScheduled } from './scheduled.ts';

// The routes of planned rooms. Readers of the channel read the plan (row-level security); only its organizer changes or cancels it; the join route opens the room of the plan (or joins
// the live one) and mints the media token the way `POST /api/meetings/:id/join` does. Bots are refused: planning and joining a room is for people.
export function registerScheduledRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...createScheduledMeetingRoute,
    schema: { body: CreateScheduledMeetingRequest, response: CreateScheduledMeetingResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = ScheduledMeetingsChannelParams.parse(req.params);
      const body = CreateScheduledMeetingRequest.parse(req.body ?? {});
      const caller = await callerPerson(tx);
      const row = await createScheduled(ctx, tx, caller, channelId, body);
      return json(CreateScheduledMeetingResponse.parse({ scheduledMeeting: toScheduled(row) }), 201);
    }),
  });
  ctx.http.route({
    ...listScheduledMeetingsRoute,
    schema: { query: ListScheduledMeetingsQuery, response: ListScheduledMeetingsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { channelId } = ScheduledMeetingsChannelParams.parse(req.params);
      const query = ListScheduledMeetingsQuery.parse(req.query);
      const rows = await listScheduled(tx, channelId, { upcoming: query.upcoming === '1', limit: query.limit });
      return json(ListScheduledMeetingsResponse.parse({ scheduledMeetings: rows.map(toScheduled) }));
    }),
  });
  ctx.http.route({
    ...getScheduledMeetingRoute,
    schema: { response: GetScheduledMeetingResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { scheduledMeetingId } = ScheduledMeetingPathParams.parse(req.params);
      await callerPerson(tx);
      const gate = await scheduledGate(tx, scheduledMeetingId);
      if (!gate) throw notFound('That planned room is not available');
      // the plan itself only for someone who can read its channel (the row-level security says the same); the others get the sentence data
      const row = gate.readable ? await loadScheduled(tx, scheduledMeetingId) : null;
      return json(GetScheduledMeetingResponse.parse({ gate, scheduledMeeting: row ? toScheduled(row) : null }));
    }),
  });
  ctx.http.route({
    ...updateScheduledMeetingRoute,
    schema: { body: UpdateScheduledMeetingRequest, response: UpdateScheduledMeetingResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { scheduledMeetingId } = ScheduledMeetingPathParams.parse(req.params);
      const body = UpdateScheduledMeetingRequest.parse(req.body ?? {});
      const caller = await callerPerson(tx);
      const row = await updateScheduled(ctx, tx, caller, scheduledMeetingId, body);
      return json(UpdateScheduledMeetingResponse.parse({ scheduledMeeting: toScheduled(row) }));
    }),
  });
  ctx.http.route({
    ...cancelScheduledMeetingRoute,
    schema: { response: CancelScheduledMeetingResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { scheduledMeetingId } = ScheduledMeetingPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      const row = await cancelScheduled(ctx, tx, caller, scheduledMeetingId);
      return json(CancelScheduledMeetingResponse.parse({ scheduledMeeting: toScheduled(row) }));
    }),
  });
  ctx.http.route({
    ...joinScheduledMeetingRoute,
    schema: { response: JoinScheduledMeetingResponse },
    rateLimit: abuseLimit('POST', joinScheduledMeetingRoute.path),
    handler: route(async (req, tx) => {
      const { scheduledMeetingId } = ScheduledMeetingPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      // a person who cannot read the channel finds no plan here (the gate on GET says why)
      const plan = await loadScheduled(tx, scheduledMeetingId);
      if (!plan) throw notFound('That planned room is not available');
      if (plan.status === 'cancelled') throw conflict('This meeting was cancelled.');
      if (plan.status === 'started') {
        const live = await liveRoomOf(tx, plan.id);
        if (live === null) throw conflict('This meeting has already happened.');
        const room = await loadMeeting(tx, live);
        if (!room) throw notFound('That voice room is not available');
        const join = await joinAndToken(ctx, tx, requireMedia(ctx), room, caller);
        return json(JoinScheduledMeetingResponse.parse({ meeting: toMeeting(room), created: false, join }));
      }
      // Whoever may post in the channel may open the room; the database marks the plan started, and one live room per plan keeps two presses of Start in one room.
      const { m, created, join } = await startRoom(ctx, tx, { channelId: plan.channel_id, title: plan.title, caller, scheduledMeetingId: plan.id });
      if (created) await afterRoomOpened(ctx, tx, plan);
      return json(JoinScheduledMeetingResponse.parse({ meeting: toMeeting(m), created, join }));
    }),
  });
}

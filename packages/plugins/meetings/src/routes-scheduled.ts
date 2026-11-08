import { route, type PluginContext } from '@manythreads/sdk';
import {
  CancelScheduledMeetingResponse,
  CreateScheduledMeetingRequest,
  CreateScheduledMeetingResponse,
  GetScheduledMeetingResponse,
  JoinScheduledMeetingResponse,
  ListScheduledMeetingsQuery,
  ListScheduledMeetingsResponse,
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
import { notBuilt } from './not-built.ts';

// Work package C (P16-05): the routes of planned rooms. Readers of the channel read the plan; only its organizer changes or cancels it; the join route opens the room of the plan
// (or joins the live one) and mints the media token the way `POST /api/meetings/:id/join` does. STUBS: 501 until C fills them in.
export function registerScheduledRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...createScheduledMeetingRoute,
    schema: { body: CreateScheduledMeetingRequest, response: CreateScheduledMeetingResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...listScheduledMeetingsRoute,
    schema: { query: ListScheduledMeetingsQuery, response: ListScheduledMeetingsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...getScheduledMeetingRoute,
    schema: { response: GetScheduledMeetingResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...updateScheduledMeetingRoute,
    schema: { body: UpdateScheduledMeetingRequest, response: UpdateScheduledMeetingResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...cancelScheduledMeetingRoute,
    schema: { response: CancelScheduledMeetingResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...joinScheduledMeetingRoute,
    schema: { response: JoinScheduledMeetingResponse },
    rateLimit: abuseLimit('POST', joinScheduledMeetingRoute.path),
    handler: route(async () => notBuilt()),
  });
}

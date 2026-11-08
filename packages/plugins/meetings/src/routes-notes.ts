import { route, type PluginContext } from '@manythreads/sdk';
import {
  GetMeetingByPathQuery,
  GetMeetingByPathResponse,
  GetMeetingNotesResponse,
  GetMeetingOverviewResponse,
  PutMeetingNotesRequest,
  PutMeetingNotesResponse,
  SaveMeetingToTeamRequest,
  SaveMeetingToTeamResponse,
  getMeetingByPathRoute,
  getMeetingNotesRoute,
  getMeetingOverviewRoute,
  putMeetingNotesRoute,
  saveMeetingToTeamRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package S5 (P15-20, P15-22, P15-23): reading and editing a meeting's notes, the meeting view's summary, the lookup from a file to its meeting, and "Save to team".
// STUBS: 501 until S5.
export function registerNotesRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...getMeetingOverviewRoute,
    schema: { response: GetMeetingOverviewResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...getMeetingByPathRoute,
    schema: { query: GetMeetingByPathQuery, response: GetMeetingByPathResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...getMeetingNotesRoute,
    schema: { response: GetMeetingNotesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...putMeetingNotesRoute,
    schema: { body: PutMeetingNotesRequest, response: PutMeetingNotesResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...saveMeetingToTeamRoute,
    schema: { body: SaveMeetingToTeamRequest, response: SaveMeetingToTeamResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}

import { route, type PluginContext } from '@manythreads/sdk';
import {
  CreateMeetingShareRequest,
  CreateMeetingShareResponse,
  DeleteMeetingShareResponse,
  ListMeetingSharesResponse,
  createMeetingShareRoute,
  deleteMeetingShareRoute,
  listMeetingSharesRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package S5 (P15-22): the organizer shares a meeting's notes with a person or a channel, and takes the share back. Readers go through
// `app.meetings_can_read_notes`. STUBS: 501 until S5.
export function registerShares(ctx: PluginContext): void {
  ctx.http.route({
    ...listMeetingSharesRoute,
    schema: { response: ListMeetingSharesResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...createMeetingShareRoute,
    schema: { body: CreateMeetingShareRequest, response: CreateMeetingShareResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...deleteMeetingShareRoute,
    schema: { response: DeleteMeetingShareResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}

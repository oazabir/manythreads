import { route, type PluginContext } from '@manythreads/sdk';
import {
  ListMeetingNotetakersResponse,
  RemoveMeetingNotetakerResponse,
  SetMeetingNotetakerRequest,
  SetMeetingNotetakerResponse,
  listMeetingNotetakersRoute,
  removeMeetingNotetakerRoute,
  setMeetingNotetakerRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package S4 (P15-18): adding and removing a room's note-taker (the SQL function `app.meetings_set_notetaker` decides who may), the announcement in the call thread,
// the consent reset, and the listen-only token. STUBS: 501 until S4.
export function registerNotetaker(ctx: PluginContext): void {
  ctx.http.route({
    ...listMeetingNotetakersRoute,
    schema: { response: ListMeetingNotetakersResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...setMeetingNotetakerRoute,
    schema: { body: SetMeetingNotetakerRequest, response: SetMeetingNotetakerResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...removeMeetingNotetakerRoute,
    schema: { response: RemoveMeetingNotetakerResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}

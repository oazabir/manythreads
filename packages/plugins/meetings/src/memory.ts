import { route, type PluginContext } from '@manythreads/sdk';
import { SendMeetingToMemoryRequest, SendMeetingToMemoryResponse, sendMeetingToMemoryRoute } from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package S2 (P15-11): filing a finished room's notes and transcript into the team's memory inbox. A public channel's room is filed by itself (through the
// `inbox.dropper` provider); a private channel's or a direct message's only when a participant presses "Send to memory". STUB: 501 until S2.
export function registerMemory(ctx: PluginContext): void {
  ctx.http.route({
    ...sendMeetingToMemoryRoute,
    schema: { body: SendMeetingToMemoryRequest, response: SendMeetingToMemoryResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}

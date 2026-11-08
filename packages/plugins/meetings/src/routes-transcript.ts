import { route, type PluginContext } from '@manythreads/sdk';
import {
  MEETING_SEGMENTS_PER_MINUTE,
  PatchMeetingSegmentRequest,
  PatchMeetingSegmentResponse,
  PostMeetingSegmentsRequest,
  PostMeetingSegmentsResponse,
  patchMeetingSegmentRoute,
  postMeetingSegmentsRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package S1 (P15-08, P15-14): the two routes that put words into a transcript. STUBS: the handlers answer 501 until S1 fills them in.
export function registerTranscriptRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...postMeetingSegmentsRoute,
    schema: { body: PostMeetingSegmentsRequest, response: PostMeetingSegmentsResponse },
    rateLimit: { limit: MEETING_SEGMENTS_PER_MINUTE, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...patchMeetingSegmentRoute,
    schema: { body: PatchMeetingSegmentRequest, response: PatchMeetingSegmentResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}

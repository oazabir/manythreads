import { route, type PluginContext } from '@manythreads/sdk';
import { MEETING_AUDIO_CHUNKS_PER_MINUTE, PostMeetingAudioChunkQuery, PostMeetingAudioChunkResponse, postMeetingAudioChunkRoute } from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package S3 (P15-07): the server fallback for a device too weak to transcribe. The body is one WAV, read as a stream with a 2 MiB cap. STUB: 501 until S3.
export function registerAudioRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...postMeetingAudioChunkRoute,
    rawBody: true,
    schema: { query: PostMeetingAudioChunkQuery, response: PostMeetingAudioChunkResponse },
    rateLimit: { limit: MEETING_AUDIO_CHUNKS_PER_MINUTE, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}

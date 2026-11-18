import { RetryVoiceTranscriptResponse, VoiceTranscribePathParams, retryVoiceTranscriptRoute } from '@manythreads/shared';
import { json, route } from './http.ts';
import type { Deps } from './service.ts';
import { retryVoiceTranscript } from './voice.ts';

/** `POST /api/messages/:messageId/voice/transcribe`: the author asks for the transcript of a voice message again (P32-04). The rules are in `retryVoiceTranscript`. */
export function registerVoiceRoutes(deps: Deps): void {
  deps.ctx.http.route({
    ...retryVoiceTranscriptRoute,
    schema: { response: RetryVoiceTranscriptResponse },
    // the per-message limit (3 an hour) is in process memory inside the handler; this is the wider net per person
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { messageId } = VoiceTranscribePathParams.parse(req.params);
      return json(RetryVoiceTranscriptResponse.parse(await retryVoiceTranscript(deps, tx, messageId)));
    }),
  });
}

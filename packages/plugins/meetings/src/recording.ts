import { route, type PluginContext } from '@manythreads/sdk';
import {
  MeetingRecordConsentRequest,
  MeetingRecordConsentResponse,
  MeetingRecordingState,
  SetMeetingRecordingRequest,
  SetMeetingRecordingResponse,
  getMeetingRecordingRoute,
  meetingRecordConsentRoute,
  setMeetingRecordingRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package S6 (P15-15): recording a room's audio, one file per person who said yes, only while everyone present has. The SQL function `app.meetings_set_recording`
// decides who may turn it on or off. STUBS: 501 until S6.
export function registerRecording(ctx: PluginContext): void {
  ctx.http.route({
    ...getMeetingRecordingRoute,
    schema: { response: MeetingRecordingState },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...setMeetingRecordingRoute,
    schema: { body: SetMeetingRecordingRequest, response: SetMeetingRecordingResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...meetingRecordConsentRoute,
    schema: { body: MeetingRecordConsentRequest, response: MeetingRecordConsentResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}

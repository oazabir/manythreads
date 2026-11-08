import { z } from 'zod';
import { MEETING_AUDIO_CHUNK_MAX_MS } from '../../entities/meeting.ts';
import type { ApiRoute } from '../client/route.ts';

// The server fallback for a device too weak to transcribe (PLAN P15-07): the page sends its own person's microphone in short WAV chunks; the server turns each into text
// and stores it as a line of that person. Only a person who is present, has said yes, and whose room is set to server transcription may send; the workspace switch and the
// team's `TEAM.md` must both allow it. The bytes are read and thrown away: audio is never stored by this route.

/** The query of `POST /api/meetings/:meetingId/audio-chunks`; the body is one 16 kHz mono 16-bit WAV (`content-type: audio/wav`), at most 2 MiB and 30 s. */
export const PostMeetingAudioChunkQuery = z.object({
  clientSegId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  /** Milliseconds on the meeting clock at which the chunk starts. */
  startMs: z.coerce.number().int().min(0),
  durationMs: z.coerce.number().int().min(1).max(MEETING_AUDIO_CHUNK_MAX_MS),
  lang: z.string().min(2).max(16).optional(),
});
export type PostMeetingAudioChunkQuery = z.infer<typeof PostMeetingAudioChunkQuery>;
export const PostMeetingAudioChunkResponse = z.object({
  /** The text the server heard; empty for silence (nothing is stored then). */
  text: z.string(),
  stored: z.boolean(),
});
export type PostMeetingAudioChunkResponse = z.infer<typeof PostMeetingAudioChunkResponse>;
export const postMeetingAudioChunkRoute = { method: 'POST', path: '/api/meetings/:meetingId/audio-chunks' } as const satisfies ApiRoute;

// ---- Test-only door of the fake media server (plugin `media-fake`, loaded by test servers only) ------------------------------------------------------------------
/**
 * `POST /api/test/media/speak`: make a person "say" something in a room that has a fake listener. The fake delivers a WAV whose data carries `FAKEASR:<text>` as the person's
 * next chunk; the answer says whether the listener was subscribed to that person (a person who did not say yes never is, so `delivered` is false). Needs the test auth token.
 */
export const FakeMediaSpeakRequest = z.strictObject({
  meetingId: z.uuid(),
  actorId: z.uuid(),
  text: z.string().min(1).max(4000),
  durationMs: z.number().int().min(100).max(MEETING_AUDIO_CHUNK_MAX_MS).default(1500),
});
export type FakeMediaSpeakRequest = z.infer<typeof FakeMediaSpeakRequest>;
export const FakeMediaSpeakResponse = z.object({ delivered: z.boolean() });
export type FakeMediaSpeakResponse = z.infer<typeof FakeMediaSpeakResponse>;
export const fakeMediaSpeakRoute = { method: 'POST', path: '/api/test/media/speak' } as const satisfies ApiRoute;

/**
 * `GET /api/test/media/state?meetingId=`: what the fake media server of a test stack recorded for one room - every token it signed (claims only), everything anyone published
 * (a listener never publishes), the open listeners with the people each is subscribed to, and who was removed. It is how a browser or API spec checks "no bot has a track in
 * the room" and "a declined person is not subscribed" from outside the server process. Test servers only; needs the test auth token.
 */
export const FakeMediaStateQuery = z.strictObject({ meetingId: z.uuid() });
export type FakeMediaStateQuery = z.infer<typeof FakeMediaStateQuery>;
export const FakeMediaStateResponse = z.object({
  tokens: z.array(z.object({ identity: z.string(), kind: z.enum(['person', 'bot']), canPublish: z.boolean(), canSubscribe: z.boolean(), listenOnly: z.boolean() })),
  published: z.array(z.string()),
  listeners: z.array(z.object({ identity: z.string(), subscriptions: z.array(z.string()) })),
  kicked: z.array(z.string()),
});
export type FakeMediaStateResponse = z.infer<typeof FakeMediaStateResponse>;
export const fakeMediaStateRoute = { method: 'GET', path: '/api/test/media/state' } as const satisfies ApiRoute;

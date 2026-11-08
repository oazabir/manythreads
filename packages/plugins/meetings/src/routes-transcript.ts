import { HttpError, conflict, forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { z } from 'zod';
import {
  MEETING_CORRECTION_DEBOUNCE_SECONDS,
  MEETING_LATE_LINE_SECONDS,
  MEETING_SEGMENTS_PER_MINUTE,
  MEETING_SEGMENT_BATCH_MAX,
  MEETING_SEGMENT_TEXT_MAX,
  MEETING_TRANSCRIPT_DELAY_SECONDS,
  MeetingPathParams,
  MeetingSegmentPathParams,
  PatchMeetingSegmentRequest,
  PatchMeetingSegmentResponse,
  PostMeetingSegmentsRequest,
  PostMeetingSegmentsResponse,
  patchMeetingSegmentRoute,
  postMeetingSegmentsRoute,
  type MeetingConsent,
} from '@manythreads/shared';
import { stripHostileText, takeRoomLines } from './limits.ts';
import { loadMeeting } from './rows.ts';
import { takeSegments } from './segments.ts';
import { TRANSCRIPT_QUEUE } from './writer.ts';

// Work package S1 (P15-08, P15-14, P15-16): the two routes that put words into a transcript, and the one that corrects them. The speaker's own device sends the lines; the
// words are cleaned and counted here, and the database decides again (the insert policy, the consent blank and the late window are triggers, not code).

/**
 * The body as the route's schema sees it: a list of lines, each anything. The real shape is checked in the handler, so a line that is too long can be answered with 413
 * ("too large") rather than 400, and the lines are counted before any one of them is read.
 */
const Envelope = z.object({ segments: z.array(z.unknown()).min(1).max(MEETING_SEGMENT_BATCH_MAX) }).loose();

async function callerPerson(tx: PluginTx): Promise<{ actorId: string; personId: string }> {
  const row = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
  if (!row?.person || !row.actor) throw forbidden('Voice rooms are for people');
  return { actorId: row.actor, personId: row.person };
}

export function registerTranscriptRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...postMeetingSegmentsRoute,
    schema: { body: Envelope, response: PostMeetingSegmentsResponse },
    rateLimit: { limit: MEETING_SEGMENTS_PER_MINUTE, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const raw = Envelope.parse(req.body).segments;
      for (const s of raw) {
        const text = (s as { text?: unknown } | null)?.text;
        if (typeof text === 'string' && text.length > MEETING_SEGMENT_TEXT_MAX) {
          throw new HttpError(413, 'validation_failed', `A line is at most ${MEETING_SEGMENT_TEXT_MAX} characters`);
        }
      }
      const body = PostMeetingSegmentsRequest.parse({ segments: raw });
      const who = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const now = ctx.runtime.now().getTime();
      if (m.state !== 'live' && (m.ended_at === null || now > m.ended_at.getTime() + MEETING_LATE_LINE_SECONDS * 1000)) throw conflict('This voice room has ended');
      if (m.transcription === 'off') throw conflict('Transcription is not on in this voice room');
      const here = (
        await tx.query<{ display_name: string; consent_transcribe: MeetingConsent; left_at: Date | null }>(
          'SELECT display_name, consent_transcribe, left_at FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid',
          [m.id, who.actorId],
        )
      ).rows[0];
      if (!here || (here.left_at !== null && now > here.left_at.getTime() + MEETING_LATE_LINE_SECONDS * 1000)) throw forbidden('You are not in this voice room');
      takeRoomLines(m.id, who.actorId, body.segments.length, now);
      const done = await takeSegments(
        ctx,
        tx,
        { id: m.id, workspaceId: m.workspace_id },
        { actorId: who.actorId, displayName: here.display_name, consent: here.consent_transcribe },
        body.segments,
        'device',
      );
      return json(PostMeetingSegmentsResponse.parse(done));
    }),
  });

  ctx.http.route({
    ...patchMeetingSegmentRoute,
    schema: { body: PatchMeetingSegmentRequest, response: PatchMeetingSegmentResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId, segId } = MeetingSegmentPathParams.parse(req.params);
      const body = PatchMeetingSegmentRequest.parse(req.body);
      const who = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const text = stripHostileText(body.text);
      if (text === '') throw invalid('Write the corrected words');
      const line = (
        await tx.query<{ speaker_id: string; start_ms: number; end_ms: number; display_name: string | null }>(
          `SELECT s.speaker_id, s.start_ms, s.end_ms, p.display_name
             FROM app.meeting_segments s LEFT JOIN app.meeting_participants p ON p.meeting_id = s.meeting_id AND p.actor_id = s.speaker_id
            WHERE s.id = $1::uuid AND s.meeting_id = $2::uuid`,
          [segId, m.id],
        )
      ).rows[0];
      if (!line || line.speaker_id !== who.actorId) throw notFound('That is not a line of yours');
      // false: not corrected (no words kept for this line, or the speaker no longer says yes); a line over 24 hours old raises, which `route` turns into 409
      const ok = (await tx.query<{ done: boolean }>('SELECT app.meetings_correct_segment($1::uuid, $2) AS done', [segId, text])).rows[0]?.done === true;
      if (!ok) throw notFound('That is not a line of yours that can be corrected');
      if (m.state === 'ended' && m.ended_at) {
        const now = ctx.runtime.now().getTime();
        const runAt = new Date(Math.max(now + MEETING_CORRECTION_DEBOUNCE_SECONDS * 1000, m.ended_at.getTime() + MEETING_TRANSCRIPT_DELAY_SECONDS * 1000));
        await ctx.jobs.enqueue(tx, TRANSCRIPT_QUEUE, { meetingId: m.id, workspaceId: m.workspace_id, reason: 'corrected' }, { runAt, dedupeKey: `transcript-rewrite:${m.id}:${Math.floor(runAt.getTime() / (MEETING_CORRECTION_DEBOUNCE_SECONDS * 1000))}` });
      }
      return json(
        PatchMeetingSegmentResponse.parse({
          line: {
            segmentId: segId,
            speakerId: line.speaker_id,
            speakerName: line.display_name ?? 'Someone',
            startMs: line.start_ms,
            endMs: line.end_ms,
            text,
            transcribed: true,
            editable: true,
          },
        }),
      );
    }),
  });
}

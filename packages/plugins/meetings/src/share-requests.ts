import { HttpError, conflict, forbidden, json, notFound, route, type PluginContext } from '@manythreads/sdk';
import {
  AnswerShareRequest,
  AnswerShareResponse,
  AskToShareRequest,
  AskToShareResponse,
  MEETING_SHARE_ANSWERED_PUSH,
  MEETING_SHARE_ASKED_PUSH,
  MeetingPathParams,
  MeetingShareAnsweredPush,
  MeetingShareAskedPush,
  MeetingShareRequestPathParams,
  MeetingsShareRequestAnsweredEvent,
  answerShareRoute,
  askToShareRoute,
} from '@manythreads/shared';
import { callerPerson } from './routes.ts';
import { loadMeeting } from './rows.ts';

// "Ask to share" (PLAN P17-02; docs/plugins/meetings.md "Ask to share"). One screen is shared in a call at a time; while someone shares, another person in the call
// asks them for a turn. The database decides (`app.meetings_ask_to_share`, `app.meetings_answer_share`, migration 0011): the asker and the person asked are both in the
// live call, one request per asker, a minute to answer, and only the person asked answers. The push goes to that one person, and the answer to the asker only.
// The sharer's page asks the server first and stops its screen only after a yes is accepted here; the asker is told they may share now and presses Share themself
// (a browser only shares after a press). Saying yes turns down the other requests waiting for the same person (`other`), so only one asker is let share.
//
// The server cannot see who is sharing, so a request may name someone who is not: only that person's page hears of it, and ignores it. That is why a request is
// recorded only when it is answered (`meetings.share_request.answered`, one per request answered, ids only): an unanswered request leaves no event and no audit
// row. The database allows one request per asker and person asked a minute, and the route 10 a minute.

/** The database's refusals, matched on the start of its message (never forwarded), and what each answers with. */
const ASK_REFUSALS: readonly (readonly [string, number, string])[] = [
  ['This call has ended', 409, 'This call has ended.'],
  ['You cannot ask yourself', 409, 'You are the one sharing.'],
  ['That person is not in the call now', 409, 'They are not in the call any more.'],
  ['You already asked', 409, 'You asked them less than a minute ago. Wait for an answer, or try again in a minute.'],
];
const ANSWER_REFUSALS: readonly (readonly [string, number, string])[] = [
  ['You already answered', 409, 'You already answered this request.'],
  ['The request has timed out', 409, 'This request has timed out.'],
  ['This call has ended', 409, 'This call has ended.'],
  ['You are not in the call now', 409, 'You are not in the call any more.'],
];

function refusal(err: unknown, known: readonly (readonly [string, number, string])[], gone: string, denied: string): never {
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === 'P0002') throw notFound(gone);
  if (code === '42501') throw forbidden(denied);
  if (code === '23514' || code === '23505') {
    const hit = known.find(([start]) => typeof message === 'string' && message.startsWith(start));
    throw new HttpError(hit?.[1] ?? 409, 'conflict', hit?.[2] ?? 'This cannot be done now.');
  }
  throw err;
}

export function registerShareRequestRoutes(ctx: PluginContext): void {
  // ---- ask --------------------------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...askToShareRoute,
    schema: { body: AskToShareRequest, response: AskToShareResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const { sharerActorId } = AskToShareRequest.parse(req.body);
      const caller = await callerPerson(tx);
      let row: { request_id: string; expires_at: Date; asker_name: string; sharer_person_id: string } | undefined;
      try {
        row = (
          await tx.query<{ request_id: string; expires_at: Date; asker_name: string; sharer_person_id: string }>(
            'SELECT request_id, expires_at, asker_name, sharer_person_id FROM app.meetings_ask_to_share($1::uuid, $2::uuid)',
            [meetingId, sharerActorId],
          )
        ).rows[0];
      } catch (err) {
        refusal(err, ASK_REFUSALS, 'That call is not available', 'Only someone in the call can ask to share.');
      }
      if (!row) throw notFound('That call is not available');
      // no event here: a request is recorded when it is answered (see the top of this file)
      const expiresAt = row.expires_at.toISOString();
      await ctx.realtime.pushToPerson(
        tx,
        row.sharer_person_id,
        MEETING_SHARE_ASKED_PUSH,
        MeetingShareAskedPush.parse({ meetingId, requestId: row.request_id, askerActorId: caller.actorId, askerName: row.asker_name, expiresAt }),
      );
      return json(AskToShareResponse.parse({ requestId: row.request_id, expiresAt }), 201);
    }),
  });

  // ---- answer -----------------------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...answerShareRoute,
    schema: { body: AnswerShareRequest, response: AnswerShareResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId, requestId } = MeetingShareRequestPathParams.parse(req.params);
      const { answer } = AnswerShareRequest.parse(req.body);
      const caller = await callerPerson(tx);
      // a request of another call (or nobody's) is "not there", like one that was never sent to the caller
      const mine = (await tx.query<{ id: string }>('SELECT id FROM app.meeting_share_requests WHERE id = $1::uuid AND meeting_id = $2::uuid', [requestId, meetingId])).rows[0];
      if (!mine) throw notFound('That request is not there any more');
      let rows: { request_id: string; asker_id: string; asker_person_id: string | null; outcome: 'accept' | 'decline' | 'other' }[];
      try {
        rows = (
          await tx.query<{ request_id: string; asker_id: string; asker_person_id: string | null; outcome: 'accept' | 'decline' | 'other' }>(
            'SELECT request_id, asker_id, asker_person_id, outcome FROM app.meetings_answer_share($1::uuid, $2::boolean)',
            [requestId, answer === 'accept'],
          )
        ).rows;
      } catch (err) {
        refusal(err, ANSWER_REFUSALS, 'That request is not there any more', 'Only the person asked can answer.');
      }
      if (rows.length === 0) throw notFound('That request is not there any more');
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw conflict('This call has ended.');
      const at = ctx.runtime.now().toISOString();
      // the request answered, then (after a yes) every other request turned down with it
      for (const row of rows) {
        await ctx.audit.emit(
          tx,
          MeetingsShareRequestAnsweredEvent.parse({
            type: 'meetings.share_request.answered',
            schemaVersion: 1,
            workspaceId: m.workspace_id,
            teamId: m.team_id,
            channelId: m.channel_id,
            meetingId: m.id,
            requestId: row.request_id,
            answeredBy: caller.actorId,
            askedBy: row.asker_id,
            answer: row.outcome,
            at,
          }),
        );
        if (row.asker_person_id) {
          await ctx.realtime.pushToPerson(tx, row.asker_person_id, MEETING_SHARE_ANSWERED_PUSH, MeetingShareAnsweredPush.parse({ meetingId: m.id, requestId: row.request_id, sharerActorId: caller.actorId, answer: row.outcome }));
        }
      }
      return json(AnswerShareResponse.parse({ answer }));
    }),
  });
}

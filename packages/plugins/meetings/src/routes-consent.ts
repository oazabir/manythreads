import { forbidden, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  GetMeetingTranscriptQuery,
  GetMeetingTranscriptResponse,
  MeetingConsentRequest,
  MeetingConsentResponse,
  MeetingPathParams,
  MeetingsConsentChangedEvent,
  MeetingsSettings,
  MeetingsSettingsUpdate,
  MeetingTranscriptionState,
  SetMeetingTranscriptionRequest,
  getMeetingTranscriptRoute,
  getMeetingTranscriptionRoute,
  getMeetingsSettingsRoute,
  meetingConsentRoute,
  putMeetingsSettingsRoute,
  setMeetingTranscriptionRoute,
} from '@manythreads/shared';
import { loadMeetingsSettings, transcribeLimits } from './config.ts';
import { announceRoom } from './live.ts';
import { PARTICIPANT_COLUMNS, loadMeeting, toParticipant, type MeetingRow, type ParticipantRow } from './rows.ts';
import { renderTranscript, type SpeakerFacts } from './transcript.ts';

// Consent and the transcription switch (PLAN P15-05, docs/plugins/meetings.md): who turned transcription on, each person's answer, the transcript as a reader may
// see it, and the workspace switch. The database decides who may do what (app.meetings_set_transcription, app.meetings_set_consent); this file adds the caps that
// live outside the database (the workspace switch and the team's TEAM.md) and the live push.

async function callerPerson(tx: PluginTx): Promise<{ actorId: string; personId: string }> {
  const row = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
  if (!row?.person || !row.actor) throw forbidden('Voice rooms are for people');
  return { actorId: row.actor, personId: row.person };
}

/** The room's transcription as everyone in it sees it. */
export async function transcriptionState(ctx: PluginContext, tx: PluginTx, m: MeetingRow): Promise<MeetingTranscriptionState> {
  const by = (
    await tx.query<{ transcription_by: string | null; display_name: string | null }>(
      `SELECT m.transcription_by, p.display_name
         FROM app.meetings m LEFT JOIN app.meeting_participants p ON p.meeting_id = m.id AND p.actor_id = m.transcription_by
        WHERE m.id = $1::uuid`,
      [m.id],
    )
  ).rows[0];
  const limits = await transcribeLimits(ctx, tx, m.team_id);
  return MeetingTranscriptionState.parse({
    meetingId: m.id,
    mode: m.transcription,
    turnedOnBy: m.transcription !== 'off' && by?.transcription_by ? { actorId: by.transcription_by, displayName: by.display_name ?? 'Someone' } : null,
    allowed: limits.allowed,
    reason: limits.reason,
  });
}

async function emitRoomChange(ctx: PluginContext, tx: PluginTx, m: MeetingRow, actorId: string, subject: 'transcribe' | 'room_transcription', value: 'yes' | 'no'): Promise<void> {
  await ctx.audit.emit(
    tx,
    MeetingsConsentChangedEvent.parse({
      type: 'meetings.consent.changed',
      schemaVersion: 1,
      workspaceId: m.workspace_id,
      teamId: m.team_id,
      channelId: m.channel_id,
      meetingId: m.id,
      actorId,
      subject,
      value,
      at: ctx.runtime.now().toISOString(),
    }),
  );
}

export function registerConsentRoutes(ctx: PluginContext): void {
  // ---- the room's transcription ---------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...getMeetingTranscriptionRoute,
    schema: { response: MeetingTranscriptionState },
    rateLimit: { limit: 120, windowMs: 60_000 },
    // not read-only on purpose: reading the team's TEAM.md may make the team's repository on first use, which writes
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      return json(MeetingTranscriptionState.parse(await transcriptionState(ctx, tx, m)));
    }),
  });

  ctx.http.route({
    ...setMeetingTranscriptionRoute,
    schema: { body: SetMeetingTranscriptionRequest, response: MeetingTranscriptionState },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const { mode } = SetMeetingTranscriptionRequest.parse(req.body);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      if (mode !== 'off') {
        // the caps live outside the database (the workspace switch, the team's TEAM.md): checked first, so a forbidden room never changes
        const limits = await transcribeLimits(ctx, tx, m.team_id);
        if (!limits.allowed.includes(mode)) throw forbidden(limits.reason ?? 'Transcription is not allowed here.');
      }
      const changed = (await tx.query<{ changed: boolean }>('SELECT app.meetings_set_transcription($1::uuid, $2) AS changed', [m.id, mode])).rows[0]?.changed === true;
      const after = (await loadMeeting(tx, m.id)) ?? m;
      if (changed) {
        await emitRoomChange(ctx, tx, after, caller.actorId, 'room_transcription', mode === 'off' ? 'no' : 'yes');
        await announceRoom(ctx, tx, after);
      }
      return json(MeetingTranscriptionState.parse(await transcriptionState(ctx, tx, after)));
    }),
  });

  // ---- a person's answer ----------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...meetingConsentRoute,
    schema: { body: MeetingConsentRequest, response: MeetingConsentResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const body = MeetingConsentRequest.parse(req.body);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      await tx.query('SELECT app.meetings_set_consent($1::uuid, $2)', [m.id, body.transcribe]);
      const row = (
        await tx.query<ParticipantRow & Record<string, unknown>>(`SELECT ${PARTICIPANT_COLUMNS} FROM app.meeting_participants p WHERE p.meeting_id = $1::uuid AND p.actor_id = $2::uuid`, [m.id, caller.actorId])
      ).rows[0];
      if (!row) throw notFound('You are not in this voice room.');
      await emitRoomChange(ctx, tx, m, caller.actorId, 'transcribe', body.transcribe);
      await announceRoom(ctx, tx, m);
      return json(MeetingConsentResponse.parse({ participant: toParticipant(row) }));
    }),
  });

  // ---- the transcript as a reader may see it --------------------------------------------------------------------------------------
  ctx.http.route({
    ...getMeetingTranscriptRoute,
    schema: { query: GetMeetingTranscriptQuery, response: GetMeetingTranscriptResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const query = GetMeetingTranscriptQuery.parse(req.query ?? {});
      // `?copy=organizer` (P15-22): the organizer's own copy of a note-taker meeting, for a person it was shared with (or the readers of the place once it was saved to the team).
      // Their way in is the notes rule, not the room's: the database function says yes or no, and the same lines are then read as the system. The answer is the same
      // lines every reader of the room sees, only without an "editable" mark (it is a copy, not the speaker's own view).
      if (query.copy === 'organizer') {
        const can = (await tx.query<{ ok: boolean | null }>('SELECT app.meetings_can_read_notes($1::uuid) AS ok', [meetingId])).rows[0]?.ok === true;
        if (!can) throw notFound('That voice room is not available');
        const lines = await ctx.db.system(
          async (sys) => {
            const people = await sys.query<{ actor_id: string; display_name: string; consent_transcribe: 'yes' | 'no' | 'unasked' }>(
              'SELECT actor_id, display_name, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1::uuid',
              [meetingId],
            );
            const speakers = new Map<string, SpeakerFacts>(people.rows.map((r) => [r.actor_id, { displayName: r.display_name, consent: r.consent_transcribe }]));
            const segs = await sys.query<{ id: string; speaker_id: string; start_ms: number; end_ms: number; text: string; final: boolean }>(
              'SELECT id, speaker_id, start_ms, end_ms, text, final FROM app.meeting_segments WHERE meeting_id = $1::uuid ORDER BY start_ms, id LIMIT 20000',
              [meetingId],
            );
            return renderTranscript(
              segs.rows.map((s) => ({ id: s.id, speakerId: s.speaker_id, startMs: s.start_ms, endMs: s.end_ms, text: s.text, final: s.final })),
              speakers,
            );
          },
          { workspaceId: tx.actor.workspaceId },
        );
        return json(GetMeetingTranscriptResponse.parse({ lines }));
      }
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const people = await tx.query<{ actor_id: string; display_name: string; consent_transcribe: 'yes' | 'no' | 'unasked' }>(
        'SELECT actor_id, display_name, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1::uuid',
        [m.id],
      );
      const speakers = new Map<string, SpeakerFacts>(people.rows.map((r) => [r.actor_id, { displayName: r.display_name, consent: r.consent_transcribe }]));
      const segs = await tx.query<{ id: string; speaker_id: string; start_ms: number; end_ms: number; text: string; final: boolean; created_at: Date }>(
        'SELECT id, speaker_id, start_ms, end_ms, text, final, created_at FROM app.meeting_segments WHERE meeting_id = $1::uuid ORDER BY start_ms, id LIMIT 20000',
        [m.id],
      );
      const lines = renderTranscript(
        segs.rows.map((s) => ({ id: s.id, speakerId: s.speaker_id, startMs: s.start_ms, endMs: s.end_ms, text: s.text, final: s.final, createdAt: s.created_at })),
        speakers,
        { viewerActorId: tx.actor.id, now: ctx.runtime.now() },
      );
      return json(GetMeetingTranscriptResponse.parse({ lines }));
    }),
  });

  // ---- the workspace switch -------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...getMeetingsSettingsRoute,
    schema: { response: MeetingsSettings },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (_req, tx) => json(MeetingsSettings.parse(await loadMeetingsSettings(tx)))),
  });

  ctx.http.route({
    ...putMeetingsSettingsRoute,
    schema: { body: MeetingsSettingsUpdate, response: MeetingsSettings },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const body = MeetingsSettingsUpdate.parse(req.body);
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') throw forbidden('Only a workspace admin can change this');
      const actor = (await tx.query<{ actor: string | null }>('SELECT app.actor() AS actor')).rows[0]?.actor ?? null;
      // only what was sent changes; a row made here starts from the defaults for the rest
      await tx.query(
        `INSERT INTO app.meeting_settings (workspace_id, transcribe_cap, room_cap, recording_cap, notetaker_allowed, updated_by, updated_at)
         VALUES (app.workspace_id(), coalesce($1, 'on_device'), coalesce($2::int, 25), coalesce($3, 'off'), coalesce($4::boolean, true), $5::uuid, now())
         ON CONFLICT (workspace_id) DO UPDATE SET
           transcribe_cap = coalesce($1, app.meeting_settings.transcribe_cap), room_cap = coalesce($2::int, app.meeting_settings.room_cap),
           recording_cap = coalesce($3, app.meeting_settings.recording_cap), notetaker_allowed = coalesce($4::boolean, app.meeting_settings.notetaker_allowed),
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [body.transcribeCap ?? null, body.roomCap ?? null, body.recordingCap ?? null, body.notetakerAllowed ?? null, actor],
      );
      return json(MeetingsSettings.parse(await loadMeetingsSettings(tx)));
    }),
  });
}

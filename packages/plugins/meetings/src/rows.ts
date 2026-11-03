import type { Meeting, MeetingParticipant, MeetingSummary } from '@manythreads/shared';
import type { PluginTx } from '@manythreads/sdk';

// Rows of `meetings` and `meeting_participants` as the routes return them. Always read through the caller's own transaction, so the row-level
// security decides who sees what; nothing here widens that.

export const MEETING_COLUMNS = `m.id, m.workspace_id, m.team_id, m.channel_id, m.title, m.state, m.started_by, m.organizer_id, m.notetaker_bot_id, m.started_at,
  m.ended_at, m.end_reason, m.transcription, m.recording, m.transcript_path, m.transcript_file_id, m.thread_root_id`;

export interface MeetingRow {
  id: string;
  workspace_id: string;
  team_id: string | null;
  channel_id: string | null;
  title: string;
  state: 'live' | 'ended';
  started_by: string;
  organizer_id: string;
  notetaker_bot_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  end_reason: 'person' | 'empty' | null;
  transcription: 'on_device' | 'server' | 'off';
  recording: boolean;
  transcript_path: string | null;
  transcript_file_id: string | null;
  thread_root_id: string | null;
}

export interface ParticipantRow {
  meeting_id: string;
  actor_id: string;
  person_id: string;
  display_name: string;
  joined_at: Date;
  left_at: Date | null;
  consent_transcribe: 'yes' | 'no' | 'unasked';
  consent_record: 'yes' | 'no' | 'unasked';
}

export const PARTICIPANT_COLUMNS = 'p.meeting_id, p.actor_id, p.person_id, p.display_name, p.joined_at, p.left_at, p.consent_transcribe, p.consent_record';

export function toMeeting(r: MeetingRow): Meeting {
  return {
    id: r.id as Meeting['id'],
    workspaceId: r.workspace_id as Meeting['workspaceId'],
    teamId: r.team_id as Meeting['teamId'],
    channelId: r.channel_id as Meeting['channelId'],
    title: r.title,
    state: r.state,
    startedBy: r.started_by as Meeting['startedBy'],
    organizerId: r.organizer_id as Meeting['organizerId'],
    notetakerBotId: r.notetaker_bot_id as Meeting['notetakerBotId'],
    startedAt: r.started_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
    endReason: r.end_reason,
    transcription: r.transcription,
    recording: r.recording,
    transcriptPath: r.transcript_path,
    transcriptFileId: r.transcript_file_id as Meeting['transcriptFileId'],
    threadRootId: r.thread_root_id as Meeting['threadRootId'],
  };
}

export function toParticipant(r: ParticipantRow): MeetingParticipant {
  return {
    meetingId: r.meeting_id as MeetingParticipant['meetingId'],
    actorId: r.actor_id as MeetingParticipant['actorId'],
    personId: r.person_id as MeetingParticipant['personId'],
    displayName: r.display_name,
    joinedAt: r.joined_at.toISOString(),
    leftAt: r.left_at ? r.left_at.toISOString() : null,
    consentTranscribe: r.consent_transcribe,
    consentRecord: r.consent_record,
  };
}

/** The meeting with this id as the caller sees it, or undefined (no such room, or one the caller cannot read: the same answer). */
export async function loadMeeting(tx: PluginTx, id: string): Promise<MeetingRow | undefined> {
  return (await tx.query<MeetingRow & Record<string, unknown>>(`SELECT ${MEETING_COLUMNS} FROM app.meetings m WHERE m.id = $1::uuid`, [id])).rows[0];
}

/** Who is in each room right now, oldest first. */
export async function loadPresent(tx: PluginTx, meetingIds: readonly string[]): Promise<Map<string, MeetingParticipant[]>> {
  const out = new Map<string, MeetingParticipant[]>();
  if (meetingIds.length === 0) return out;
  const res = await tx.query<ParticipantRow & Record<string, unknown>>(
    `SELECT ${PARTICIPANT_COLUMNS} FROM app.meeting_participants p WHERE p.meeting_id = ANY ($1::uuid[]) AND p.left_at IS NULL ORDER BY p.joined_at, p.actor_id`,
    [meetingIds],
  );
  for (const r of res.rows) {
    const list = out.get(r.meeting_id) ?? [];
    list.push(toParticipant(r));
    out.set(r.meeting_id, list);
  }
  return out;
}

export async function summaries(tx: PluginTx, rows: readonly MeetingRow[]): Promise<MeetingSummary[]> {
  const present = await loadPresent(tx, rows.map((r) => r.id));
  return rows.map((r) => ({ meeting: toMeeting(r), present: present.get(r.id) ?? [] }));
}

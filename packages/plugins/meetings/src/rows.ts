import type { Meeting, MeetingGuest, MeetingParticipant, MeetingSummary } from '@manythreads/shared';
import type { PluginTx } from '@manythreads/sdk';
import type { SpeakerFacts } from './transcript.ts';

// Rows of `meetings` and `meeting_participants` as the routes return them. Always read through the caller's own transaction, so the row-level
// security decides who sees what; nothing here widens that.

export const MEETING_COLUMNS = `m.id, m.workspace_id, m.team_id, m.channel_id, m.title, m.state, m.kind, m.started_by, m.organizer_id, m.notetaker_bot_id, m.started_at,
  m.ended_at, m.end_reason, m.transcription, m.recording, m.transcript_path, m.transcript_file_id, m.thread_root_id, m.allow_guests`;

export interface MeetingRow {
  id: string;
  workspace_id: string;
  team_id: string | null;
  channel_id: string | null;
  title: string;
  state: 'live' | 'ended';
  kind: 'audio' | 'video';
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
  allow_guests: boolean;
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
    kind: r.kind,
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
    allowGuests: r.allow_guests === true,
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
  const ids = rows.map((r) => r.id);
  const present = await loadPresent(tx, ids);
  const guests = await admittedGuests(tx, ids);
  return rows.map((r) => ({ meeting: toMeeting(r), present: present.get(r.id) ?? [], guests: guests.get(r.id) ?? [] }));
}

/** A link guest's media identity (P17-04): never an actor id. */
export const guestIdentity = (guestId: string): string => `guest:${guestId}`;

/** The link guests let in and still there, by call, for the tiles (read through the caller's row policies). */
export async function admittedGuests(tx: PluginTx, meetingIds: readonly string[]): Promise<Map<string, MeetingGuest[]>> {
  const out = new Map<string, MeetingGuest[]>();
  if (meetingIds.length === 0) return out;
  const rows = (
    await tx.query<{ id: string; meeting_id: string; display_name: string }>(
      "SELECT id::text, meeting_id::text, display_name FROM app.meeting_guests WHERE meeting_id = ANY ($1::uuid[]) AND state = 'admitted' ORDER BY decided_at, id",
      [meetingIds],
    )
  ).rows;
  for (const r of rows) {
    const list = out.get(r.meeting_id) ?? [];
    list.push({ id: r.id as MeetingGuest['id'], identity: guestIdentity(r.id), displayName: r.display_name });
    out.set(r.meeting_id, list);
  }
  return out;
}


/**
 * The speaker of a stored line, for `renderTranscript`: the person's actor id, or for a link guest's line (P17-04, `guest_id`, no speaker) the guest's id, which
 * `withGuestSpeakers` puts in the speakers' map.
 */
export const SEGMENT_SPEAKER = 'coalesce(speaker_id, guest_id) AS speaker_id';

/**
 * Adds the link guests of a call to a map of its speakers (read through `tx`, so the row policies decide): each by their id, named "Ana (guest)", with their own
 * answer to "Transcribe my voice?". A guest who never answered yes is shown only as "spoke (not transcribed)", like a person.
 */
export async function withGuestSpeakers(tx: PluginTx, meetingId: string, speakers: Map<string, SpeakerFacts>): Promise<Map<string, SpeakerFacts>> {
  const rows = (
    await tx.query<{ id: string; display_name: string; consent_transcribe: SpeakerFacts['consent'] }>(
      'SELECT id::text, display_name, consent_transcribe FROM app.meeting_guests WHERE meeting_id = $1::uuid',
      [meetingId],
    )
  ).rows;
  for (const g of rows) speakers.set(g.id, { displayName: guestSpeakerName(g.display_name), consent: g.consent_transcribe, guest: true });
  return speakers;
}

/** How a link guest is named in the transcript and the captions. */
export const guestSpeakerName = (name: string): string => `${name} (guest)`;

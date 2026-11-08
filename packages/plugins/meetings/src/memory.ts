import { conflict, forbidden, json, notFound, route, type InboxDropper, type PluginContext, type PluginTx, type RepoProvider } from '@manythreads/sdk';
import {
  type MeetingConsent,
  type MeetingTranscriptLine,
  MeetingPathParams,
  SendMeetingToMemoryRequest,
  SendMeetingToMemoryResponse,
  TeamMeetingsBundleConfig,
  sendMeetingToMemoryRoute,
} from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { stripHostileText } from './limits.ts';
import { loadMeeting, type MeetingRow } from './rows.ts';
import { renderTranscript, type SegmentFacts, type SpeakerFacts } from './transcript.ts';
import { clock } from './writer.ts';

// Work package S2 (P15-11, decision C8): filing a finished room's notes and transcript into the team's memory inbox, as one markdown item (origin `meeting`) that the team's
// Archivist turns into concepts like any other drop.
//  * A public channel's room is filed by itself once its notes are written (`shouldFileAutomatically`), unless the team's `TEAM.md` says `meetings: { autoMemory: false }`.
//  * A private channel's room is never filed by itself: a participant presses "Send to memory", reads what it does first (the first answer carries the warning), and confirms.
//  * A direct-message call belongs to the people in it and has no team, so it cannot be filed (the same rule as a single message).
//  * A guest in the room (anyone who is neither on the team nor a workspace admin) makes the item wait for a lead (`hold: 'external'`), whichever way it was filed.
//  * Only the words of people who said yes are in it; the item names them (and no one else) as the people it came from.

export interface PersonFacts {
  actorId: string;
  displayName: string;
  consent: MeetingConsent;
}

export interface LoadedTranscript {
  lines: MeetingTranscriptLine[];
  people: PersonFacts[];
}

/** The meeting's lines as every reader sees them (only the words of people who said yes) and who was in the room. Works under any transaction that may read the meeting. */
export async function loadTranscript(tx: PluginTx, meetingId: string): Promise<LoadedTranscript> {
  const people = (
    await tx.query<{ actor_id: string; display_name: string; consent_transcribe: MeetingConsent }>(
      'SELECT actor_id, display_name, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1::uuid ORDER BY joined_at',
      [meetingId],
    )
  ).rows.map((r) => ({ actorId: r.actor_id, displayName: r.display_name, consent: r.consent_transcribe }));
  const speakers = new Map<string, SpeakerFacts>(people.map((p) => [p.actorId, { displayName: p.displayName, consent: p.consent }]));
  const segs = await tx.query<{ id: string; speaker_id: string; start_ms: number; end_ms: number; text: string; final: boolean }>(
    'SELECT id, speaker_id, start_ms, end_ms, text, final FROM app.meeting_segments WHERE meeting_id = $1::uuid ORDER BY start_ms, id LIMIT 20000',
    [meetingId],
  );
  const facts: SegmentFacts[] = segs.rows.map((s) => ({ id: s.id, speakerId: s.speaker_id, startMs: s.start_ms, endMs: s.end_ms, text: s.text, final: s.final }));
  return { lines: renderTranscript(facts, speakers), people };
}

/** The most characters of transcript put into the item; the file in the repo or Files keeps the whole of it. */
const MEMORY_TRANSCRIPT_MAX_CHARS = 300_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `meetings.autoMemory` from the text of `TEAM.md`. No file, no front matter or no key: true. Present but not readable: false (a typo never opens what the team meant to keep closed). */
export function readAutoMemory(teamMd: string | null): boolean {
  if (teamMd === null) return true;
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(teamMd)?.[1];
  if (block === undefined) return true;
  let doc: unknown;
  try {
    doc = parseYaml(block, { maxAliasCount: 20 });
  } catch {
    return false;
  }
  if (doc === null || doc === undefined) return true;
  if (!isRecord(doc)) return false;
  const meetings = doc['meetings'];
  if (meetings === undefined || meetings === null) return true;
  if (!isRecord(meetings)) return false;
  if (meetings['autoMemory'] === undefined) return true;
  const parsed = TeamMeetingsBundleConfig.shape.autoMemory.safeParse(meetings['autoMemory']);
  return parsed.success ? parsed.data : false;
}

/** The team's switch from the `TEAM.md` at the head of its repository (read as the transaction's actor). */
export async function loadAutoMemory(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<boolean> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return true;
  try {
    const blob = await repo.blob(tx, teamId, 'TEAM.md', 'main', 256 * 1024);
    return readAutoMemory(new TextDecoder().decode(blob.content));
  } catch (err) {
    if ((err as { status?: unknown }).status === 404) return true;
    return false;
  }
}

/** Is this meeting filed into memory without anyone asking? A team's public channel, with the team's switch not turned off. */
export async function shouldFileAutomatically(ctx: PluginContext, tx: PluginTx, m: Pick<MeetingRow, 'team_id' | 'channel_id'>): Promise<boolean> {
  if (m.team_id === null || m.channel_id === null) return false;
  const channel = (await tx.query<{ kind: string; private: boolean }>('SELECT kind, private FROM app.channels WHERE id = $1::uuid', [m.channel_id])).rows[0];
  if (!channel || channel.kind !== 'channel' || channel.private) return false;
  return loadAutoMemory(ctx, tx, m.team_id);
}

/** People in the room who are neither on the team nor workspace owners or admins. */
async function guestsIn(tx: PluginTx, m: Pick<MeetingRow, 'id' | 'team_id' | 'workspace_id'>): Promise<string[]> {
  if (m.team_id === null) return [];
  return (
    await tx.query<{ display_name: string }>(
      `SELECT p.display_name FROM app.meeting_participants p
        WHERE p.meeting_id = $1::uuid
          AND NOT EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = $2::uuid AND tm.actor_id = p.actor_id)
          AND NOT EXISTS (SELECT 1 FROM app.workspace_members wm WHERE wm.workspace_id = $3::uuid AND wm.person_id = p.person_id AND wm.role IN ('owner', 'admin'))`,
      [m.id, m.team_id, m.workspace_id],
    )
  ).rows.map((r) => r.display_name);
}

/** The notes text without its front matter. */
const bodyOf = (notesMd: string): string => notesMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

/** The one markdown item: where the originals are, the notes, then the transcript with its times. Pure, so the tests can read it. */
export function renderMemoryItem(input: {
  title: string;
  date: string;
  speakers: readonly string[];
  transcriptPath: string | null;
  notesPath: string | null;
  notesMd: string;
  lines: readonly { startMs: number; speakerName: string; text: string }[];
}): string {
  const out = [
    `# ${stripHostileText(input.title).slice(0, 200)}`,
    '',
    `A voice meeting held on ${input.date}. Only people who agreed to be transcribed are quoted: ${input.speakers.length > 0 ? input.speakers.join(', ') : 'nobody'}.`,
    ...(input.transcriptPath ? [`The full transcript is kept at \`${input.transcriptPath}\`; the times below ([hh:mm:ss]) are lines of that file.`] : []),
    ...(input.notesPath ? [`The notes are kept at \`${input.notesPath}\`.`] : []),
    '',
    '## Notes',
    '',
    bodyOf(input.notesMd) || '*No notes were written.*',
    '',
    '## Transcript',
    '',
  ];
  let used = 0;
  let cut = false;
  for (const l of input.lines) {
    const row = `[${clock(l.startMs)}] ${l.speakerName}: ${l.text}`;
    if (used + row.length > MEMORY_TRANSCRIPT_MAX_CHARS) {
      cut = true;
      break;
    }
    out.push(row);
    used += row.length + 1;
  }
  if (cut) out.push('', '(The rest of the transcript is in the transcript file.)');
  out.push('');
  return out.join('\n');
}

export interface FiledMeeting {
  itemId: string;
  state: string;
  /** True when this call dropped it; false when the meeting had been filed before and the earlier item is returned. */
  created: boolean;
}

/**
 * Drops the meeting's notes and transcript into its team's memory inbox. Returns null when there is nothing to file (no notes yet, nobody who said yes, no team). Run it in a system
 * transaction. The meeting's notes row is locked, so two presses of the button file it once.
 */
export async function fileMeetingIntoMemory(
  ctx: PluginContext,
  tx: PluginTx,
  meetingId: string,
  options: {
    automatic: boolean;
    sentBy?: string;
    /**
     * "Save to team" (P15-23) files a note-taker meeting, whose own copies live in the organizer's Personal space: the team's memory is given the team copy's paths, and a
     * direct-message call (which has no team of its own) is filed to the team the organizer chose.
     */
    teamCopy?: { teamId: string; transcriptPath: string; notesPath: string };
  },
): Promise<FiledMeeting | null> {
  const m = await loadMeeting(tx, meetingId);
  const teamId = options.teamCopy?.teamId ?? m?.team_id ?? null;
  if (!m || teamId === null || m.state !== 'ended') return null;
  const note = (
    await tx.query<{ status: string; transcript_path: string | null; notes_path: string | null; notes_md: string; memory_item_id: string | null }>(
      'SELECT status, transcript_path, notes_path, notes_md, memory_item_id FROM app.meeting_notes WHERE meeting_id = $1::uuid FOR UPDATE',
      [m.id],
    )
  ).rows[0];
  if (!note || note.status !== 'written') return null;
  if (note.memory_item_id !== null) {
    const earlier = (await tx.query<{ state: string }>('SELECT state FROM app.memory_inbox_items WHERE id = $1::uuid', [note.memory_item_id])).rows[0];
    return { itemId: note.memory_item_id, state: earlier?.state ?? 'queued', created: false };
  }
  const dropper = ctx.providers.get<InboxDropper>('inbox.dropper');
  if (!dropper) return null;

  const { lines, people } = await loadTranscript(tx, m.id);
  const saying: PersonFacts[] = people.filter((p) => p.consent === 'yes');
  if (saying.length === 0) return null;
  // The person who pressed the button first, then the organizer, then the others in the order they joined.
  const order = [options.sentBy, m.organizer_id].filter((id): id is string => id !== undefined);
  const dropperIds = [...order.filter((id) => people.some((p) => p.actorId === id)), ...saying.map((p) => p.actorId)].filter((id, i, all) => all.indexOf(id) === i);
  const guests = await guestsIn(tx, { ...m, team_id: teamId });
  const transcriptPath = options.teamCopy?.transcriptPath ?? note.transcript_path;
  const notesPath = options.teamCopy?.notesPath ?? note.notes_path;
  const text = renderMemoryItem({
    title: m.title,
    date: m.started_at.toISOString().slice(0, 10),
    speakers: saying.map((p) => stripHostileText(p.displayName).slice(0, 80)),
    transcriptPath,
    notesPath,
    notesMd: note.notes_md,
    lines: lines.filter((l) => l.transcribed),
  });
  const name = `${stripHostileText(m.title).slice(0, 150)} · ${m.started_at.toISOString().slice(0, 10)}`;
  const done = await dropper.drop(tx, {
    teamId,
    name,
    markdown: text,
    origin: 'meeting',
    dropperIds,
    ...(guests.length > 0 ? { hold: 'external' as const } : {}),
    ...(transcriptPath ? { sourcePath: transcriptPath } : {}),
  });
  await tx.query('UPDATE app.meeting_notes SET memory_item_id = $2::uuid, updated_at = now() WHERE meeting_id = $1::uuid', [m.id, done.itemId]);
  void options.automatic;
  return { itemId: done.itemId, state: done.state, created: true };
}

/** What pressing "Send to memory" does, in plain words, for the person to read first. */
export function sendWarning(teamName: string, isPrivate: boolean, guestPresent: boolean): string {
  return [
    isPrivate
      ? `This call was in a private channel, but everyone in ${teamName} will see what is sent to the team’s memory.`
      : `This puts the call’s notes and transcript into ${teamName}’s memory.`,
    'The notes and the words of the people who agreed to be transcribed go to the team’s memory inbox, where the Archivist turns them into memory concepts.',
    ...(guestPresent ? ['A guest was in the call, so a team lead has to approve it before anything is filed.'] : []),
    'Nobody else’s words are included.',
  ].join(' ');
}

export function registerMemory(ctx: PluginContext): void {
  ctx.http.route({
    ...sendMeetingToMemoryRoute,
    schema: { body: SendMeetingToMemoryRequest, response: SendMeetingToMemoryResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const body = SendMeetingToMemoryRequest.parse(req.body);
      const who = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
      if (!who?.person || !who.actor) throw forbidden('Voice rooms are for people');
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const here = await tx.query('SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid', [m.id, who.actor]);
      if (here.rows.length === 0) throw forbidden('Only people who were in the call can send it to memory');
      if (m.state !== 'ended') throw conflict('The call has not ended yet');
      if (m.team_id === null) throw conflict('A direct-message call belongs to the people in it, so it cannot be sent to a team’s memory.');
      const team = (await tx.query<{ name: string; archived_at: Date | null }>('SELECT name, archived_at FROM app.teams WHERE id = $1::uuid', [m.team_id])).rows[0];
      if (!team) throw forbidden('You cannot see this team');
      if (team.archived_at) throw conflict('This team is archived');
      const canDrop = (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'post') AS ok", [m.team_id])).rows[0]?.ok === true;
      if (!canDrop) throw forbidden('Only people on this team can send things to its memory.');
      const note = (await tx.query<{ status: string; memory_item_id: string | null }>('SELECT status, memory_item_id FROM app.meeting_notes WHERE meeting_id = $1::uuid', [m.id])).rows[0];
      if (!note || note.status !== 'written') throw conflict('The notes are not written yet, so there is nothing to send.');
      const channel = m.channel_id === null ? undefined : (await tx.query<{ private: boolean }>('SELECT private FROM app.channels WHERE id = $1::uuid', [m.channel_id])).rows[0];
      const guests = await ctx.db.system((sys) => guestsIn(sys, m));
      const warning = sendWarning(team.name, channel?.private === true, guests.length > 0);
      if (note.memory_item_id !== null) return json(SendMeetingToMemoryResponse.parse({ warning, sent: true, memoryItemId: note.memory_item_id }));
      if (!body.confirmed) return json(SendMeetingToMemoryResponse.parse({ warning, sent: false, memoryItemId: null }));
      const filed = await ctx.db.system((sys) => fileMeetingIntoMemory(ctx, sys, m.id, { automatic: false, sentBy: who.actor! }), { workspaceId: m.workspace_id });
      if (!filed) throw conflict('Nobody in this call agreed to be transcribed, so there is nothing to send.');
      return json(SendMeetingToMemoryResponse.parse({ warning, sent: true, memoryItemId: filed.itemId }));
    }),
  });
}

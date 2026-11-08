import { Readable } from 'node:stream';
import type { BlobStorage, PluginContext, PluginEvent, PluginTx, RepoProvider } from '@manythreads/sdk';
import {
  MEETING_TRANSCRIPT_DELAY_SECONDS,
  MEETING_TRANSCRIPT_MAX_BYTES,
  MeetingsMeetingEndedEvent,
  MeetingsTranscriptWrittenEvent,
  REPO_MAX_FILE_BYTES,
  meetingFolderName,
  meetingRepoDir,
  type MeetingConsent,
  type MeetingTranscriptLine,
} from '@manythreads/shared';
import { z } from 'zod';
import { stripHostileText } from './limits.ts';
import { loadMeeting, type MeetingRow } from './rows.ts';
import { renderTranscript, type SegmentFacts, type SpeakerFacts } from './transcript.ts';

// Work package S1 (P15-09, decisions C4, C5, C6): the transcript file. Two minutes ten seconds after a room ended (the speakers' devices have had two minutes to send what they
// still held) the words are written as `transcript.md`: into the team's repo for a public channel, or into the channel's Files folder for a private channel or a direct
// message, so the file is readable by exactly the people who can read the room. A speaker's correction writes it again a little later (debounced). Nothing is written for a
// room a note-taker bot owns (its own transcript is the note-taker's) nor for a room where nobody's words were kept.

export const TRANSCRIPT_QUEUE = 'meetings.transcript';

const Payload = z.object({ meetingId: z.uuid(), workspaceId: z.uuid(), reason: z.enum(['ended', 'corrected']).default('ended') });

/** The file as plain markdown, and how many lines of the transcript it holds. */
export interface RenderedTranscript {
  markdown: string;
  lineCount: number;
  truncated: boolean;
}

/** Characters that mean something in markdown, escaped so what somebody said cannot become a heading, a link, a tag or a table. */
function escapeMarkdown(text: string): string {
  let out = text.startsWith('#') ? '\\#' : '';
  for (const ch of out === '' ? text : text.slice(1)) out += '\\`*_[]<>~|'.includes(ch) ? `\\${ch}` : ch;
  return out;
}

export function clock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(Math.floor(total / 3600))}:${p2(Math.floor((total % 3600) / 60))}:${p2(total % 60)}`;
}

export interface TranscriptHeader {
  title: string;
  startedAt: Date;
  endedAt: Date;
  channelLabel: string;
  participants: string[];
  language: string | null;
  source: 'on-device' | 'server' | 'mixed';
}

/**
 * The file: a small front matter (every string quoted as JSON, which is also valid YAML), the title, and one line per stretch of speech. A line that would take the file over
 * `maxBytes` ends it with a plain note instead; nothing is cut in the middle of a line.
 */
export function renderTranscriptMarkdown(header: TranscriptHeader, lines: readonly MeetingTranscriptLine[], maxBytes: number): RenderedTranscript {
  const q = (s: string): string => JSON.stringify(s);
  const seconds = Math.max(0, Math.round((header.endedAt.getTime() - header.startedAt.getTime()) / 1000));
  const front = [
    '---',
    'type: "Meeting Transcript"',
    `title: ${q(header.title)}`,
    `date: ${q(header.startedAt.toISOString().slice(0, 10))}`,
    `start: ${q(header.startedAt.toISOString())}`,
    `duration_seconds: ${seconds}`,
    `channel: ${q(header.channelLabel)}`,
    `participants: [${header.participants.map(q).join(', ')}]`,
    ...(header.language ? [`language: ${q(header.language)}`] : []),
    `source: ${header.source}`,
    '---',
    '',
    `# ${escapeMarkdown(header.title)}`,
    '',
  ].join('\n');
  const note = '\n*The transcript is longer than a file can hold; the rest is in the voice room in the app.*\n';
  const budget = maxBytes - Buffer.byteLength(note);
  let out = front;
  let used = Buffer.byteLength(out);
  let count = 0;
  let truncated = false;
  for (const line of lines) {
    const text = line.transcribed ? escapeMarkdown(line.text) : `*${escapeMarkdown(line.speakerName)} spoke (not transcribed)*`;
    const row = line.transcribed ? `[${clock(line.startMs)}] **${escapeMarkdown(line.speakerName)}:** ${text}\n` : `[${clock(line.startMs)}] ${text}\n`;
    const size = Buffer.byteLength(row);
    if (used + size > budget) {
      truncated = true;
      break;
    }
    out += row;
    used += size;
    count += 1;
  }
  if (truncated) out += note;
  return { markdown: out, lineCount: count, truncated };
}

/** A folder-safe name from a title: lower-case letters, digits and single hyphens, at most 40 characters; `meeting` when nothing is left. */
export function slugOf(title: string): string {
  let out = '';
  let hyphen = false;
  for (const ch of title.normalize('NFKD').toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (hyphen && out !== '') out += '-';
      hyphen = false;
      out += ch;
    } else hyphen = true;
  }
  const cut = out.slice(0, 40).replace(/-+$/, '');
  return cut === '' ? 'meeting' : cut;
}

interface ChannelRow extends Record<string, unknown> {
  id: string;
  name: string;
  kind: 'channel' | 'dm' | 'bot_conversation';
  private: boolean;
  team_id: string | null;
}

const bytesOf = (text: string): AsyncIterable<Uint8Array> => Readable.from([Buffer.from(text, 'utf8')]);

function coAuthorName(name: string): string {
  return stripHostileText(name).replace(/[<>]/g, '').slice(0, 100) || 'Someone';
}

/** The folder of Files storage for a channel: the same convention the Files screen reads (`channels/<name>/`, `dms/<id>/`). */
const filesFolder = (c: ChannelRow): string => (c.kind === 'channel' ? `channels/${c.name}/` : `dms/${c.id}/`);

interface Existing {
  location: 'repo' | 'channel_files' | 'personal' | null;
  path: string | null;
  fileId: string | null;
}

async function existingWrite(tx: PluginTx, m: MeetingRow): Promise<Existing> {
  const note = (await tx.query<{ location: Existing['location']; transcript_path: string | null }>('SELECT location, transcript_path FROM app.meeting_notes WHERE meeting_id = $1::uuid', [m.id])).rows[0];
  return { location: note?.location ?? null, path: m.transcript_path, fileId: m.transcript_file_id };
}

/** The first of `base`, `base-2`, `base-3`, ... that no other meeting of the place already uses. */
async function freeDir(tx: PluginTx, m: MeetingRow, place: 'repo' | 'files', dirFor: (slug: string) => string, slug: string): Promise<string> {
  for (let n = 1; n <= 50; n += 1) {
    const dir = dirFor(n === 1 ? slug : `${slug}-${n}`);
    const taken = await tx.query(
      `SELECT 1 FROM app.meetings WHERE id <> $1::uuid AND transcript_path = $2 AND ${place === 'repo' ? 'team_id = $3::uuid' : 'channel_id = $3::uuid'} LIMIT 1`,
      [m.id, `${dir}/transcript.md`, place === 'repo' ? m.team_id : m.channel_id],
    );
    if (taken.rows.length === 0) return dir;
  }
  return dirFor(`${slug}-${m.id.slice(0, 8)}`);
}

/**
 * Writes (or writes again) the transcript of an ended room. Returns what was done: `null` when there is nothing to write. Exported for the tests; the job and the
 * correction route reach it only through the `meetings.transcript` queue.
 */
export async function writeTranscript(ctx: PluginContext, tx: PluginTx, meetingId: string): Promise<{ store: 'repo' | 'files'; path: string; lineCount: number; first: boolean } | null> {
  const m = await loadMeeting(tx, meetingId);
  if (!m || m.state !== 'ended' || !m.ended_at) return null;
  if (m.notetaker_bot_id) return null;

  const people = await tx.query<{ actor_id: string; display_name: string; consent_transcribe: MeetingConsent }>(
    'SELECT actor_id, display_name, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1::uuid ORDER BY joined_at',
    [m.id],
  );
  const speakers = new Map<string, SpeakerFacts>(people.rows.map((r) => [r.actor_id, { displayName: r.display_name, consent: r.consent_transcribe }]));
  const segs = await tx.query<{ id: string; speaker_id: string; start_ms: number; end_ms: number; text: string; final: boolean; source: 'device' | 'server'; lang: string | null }>(
    'SELECT id, speaker_id, start_ms, end_ms, text, final, source, lang FROM app.meeting_segments WHERE meeting_id = $1::uuid ORDER BY start_ms, id LIMIT 20000',
    [m.id],
  );
  const facts: SegmentFacts[] = segs.rows.map((s) => ({ id: s.id, speakerId: s.speaker_id, startMs: s.start_ms, endMs: s.end_ms, text: s.text, final: s.final }));
  const lines = renderTranscript(facts, speakers);
  if (!lines.some((l) => l.transcribed)) return null;

  const channel = m.channel_id
    ? (await tx.query<ChannelRow>('SELECT id, name, kind, private, team_id FROM app.channels WHERE id = $1::uuid', [m.channel_id])).rows[0]
    : undefined;
  const toRepo = channel !== undefined && channel.kind === 'channel' && !channel.private && m.team_id !== null;
  if (!toRepo && !channel) return null;

  const sources = new Set(segs.rows.filter((s) => s.text !== '').map((s) => s.source));
  const langs = new Map<string, number>();
  for (const s of segs.rows) if (s.lang && s.text !== '') langs.set(s.lang, (langs.get(s.lang) ?? 0) + 1);
  const language = [...langs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const header: TranscriptHeader = {
    title: m.title,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    channelLabel: channel ? (channel.kind === 'channel' ? `#${channel.name}` : 'direct message') : '',
    participants: people.rows.map((r) => r.display_name),
    language,
    source: sources.size > 1 ? 'mixed' : sources.has('server') ? 'server' : 'on-device',
  };

  const previous = await existingWrite(tx, m);
  // A note-taker that was removed before the room ended already wrote this meeting's transcript into the organizer's Personal space: that copy stays the meeting's
  // (the location is never moved by a later write), and nothing is written for the team.
  if (previous.location === 'personal') return null;
  const now = ctx.runtime.now();
  let store: 'repo' | 'files';
  let path: string;
  let fileId: string | null = null;
  let lineCount: number;

  if (toRepo) {
    store = 'repo';
    const repo = ctx.providers.get<RepoProvider>('repo');
    if (!repo) throw new Error('The team repo is not available');
    const rendered = renderTranscriptMarkdown(header, lines, Math.min(MEETING_TRANSCRIPT_MAX_BYTES, REPO_MAX_FILE_BYTES - 4096));
    lineCount = rendered.lineCount;
    path =
      previous.location === 'repo' && previous.path
        ? previous.path
        : `${await freeDir(tx, m, 'repo', (slug) => meetingRepoDir(m.started_at, slug), slugOf(m.title))}/transcript.md`;
    const speakersWithWords = new Set(lines.filter((l) => l.transcribed).map((l) => l.speakerId));
    const coAuthors = [...speakersWithWords].map((id) => ({ actorId: id, name: coAuthorName(speakers.get(id)?.displayName ?? 'Someone') }));
    await repo.write(tx, m.team_id!, { id: tx.actor.id, kind: 'system' }, [{ path, op: 'put', content: rendered.markdown }], `Meeting transcript: ${stripHostileText(m.title).slice(0, 120)}`, coAuthors);
  } else {
    store = 'files';
    const storage = ctx.providers.get<BlobStorage>('storage');
    if (!storage) throw new Error('File storage is not available');
    const rendered = renderTranscriptMarkdown(header, lines, MEETING_TRANSCRIPT_MAX_BYTES);
    lineCount = rendered.lineCount;
    const blob = await storage.put(bytesOf(rendered.markdown), { maxBytes: MEETING_TRANSCRIPT_MAX_BYTES + 1024 });
    const prior = previous.location === 'channel_files' && previous.fileId ? previous.fileId : null;
    const updated = prior
      ? await tx.query<{ id: string; folder_path: string; name: string }>(
          'UPDATE app.files SET blob_key = $2, size = $3, sha256 = $4 WHERE id = $1::uuid RETURNING id, folder_path, name',
          [prior, blob.blobKey, blob.size, blob.sha256],
        )
      : null;
    const row = updated?.rows[0];
    if (row) {
      fileId = row.id;
      path = `${row.folder_path}${row.name}`;
    } else {
      const base = filesFolder(channel!);
      const dir = await freeDir(tx, m, 'files', (slug) => `${base}meetings/${meetingFolderName(m.started_at, slug)}`, slugOf(m.title));
      const folder = `${dir}/`;
      const made = await tx.query<{ id: string }>(
        `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
         VALUES ($1::uuid, $2::uuid, $3, 'transcript.md', $4, $5, 'text/markdown', $6, $7::uuid) RETURNING id`,
        [m.workspace_id, m.channel_id, folder, blob.blobKey, blob.size, blob.sha256, m.organizer_id],
      );
      fileId = made.rows[0]!.id;
      path = `${folder}transcript.md`;
    }
  }

  await tx.query(
    `INSERT INTO app.meeting_notes (meeting_id, location, transcript_path, file_ids)
     VALUES ($1::uuid, $2, $3, CASE WHEN $4::uuid IS NULL THEN '{}'::uuid[] ELSE ARRAY[$4::uuid] END)
     ON CONFLICT (meeting_id) DO UPDATE SET
       location = EXCLUDED.location, transcript_path = EXCLUDED.transcript_path,
       file_ids = CASE WHEN $4::uuid IS NULL OR $4::uuid = ANY (app.meeting_notes.file_ids) THEN app.meeting_notes.file_ids ELSE array_append(app.meeting_notes.file_ids, $4::uuid) END,
       updated_at = now()`,
    [m.id, store === 'repo' ? 'repo' : 'channel_files', path, fileId],
  );
  await tx.query('UPDATE app.meetings SET transcript_path = $2, transcript_file_id = $3::uuid WHERE id = $1::uuid', [m.id, path, fileId]);

  const first = previous.path === null;
  if (first) {
    await ctx.audit.emit(
      tx,
      MeetingsTranscriptWrittenEvent.parse({
        type: 'meetings.transcript.written',
        schemaVersion: 1,
        workspaceId: m.workspace_id,
        teamId: m.team_id,
        channelId: m.channel_id,
        meetingId: m.id,
        path,
        store,
        lineCount,
        at: now.toISOString(),
      }),
    );
  }
  return { store, path, lineCount, first };
}

export function registerTranscriptWriter(ctx: PluginContext): void {
  ctx.jobs.register(
    TRANSCRIPT_QUEUE,
    async (payload, tx) => {
      const p = Payload.parse(payload);
      await writeTranscript(ctx, tx, p.meetingId);
    },
    { serialKey: 'meetingId', maxAttempts: 5 },
  );

  // The room ended: write the file once the late lines have had their two minutes (and ten seconds more for the last of them to be stored).
  ctx.events.subscribe('meetings.meeting.ended', async (raw: PluginEvent, tx) => {
    const event = MeetingsMeetingEndedEvent.parse(raw);
    const runAt = new Date(new Date(event.at).getTime() + MEETING_TRANSCRIPT_DELAY_SECONDS * 1000);
    await ctx.jobs.enqueue(tx, TRANSCRIPT_QUEUE, { meetingId: event.meetingId, workspaceId: event.workspaceId, reason: 'ended' }, { runAt, dedupeKey: `transcript:${event.meetingId}` });
  });
}

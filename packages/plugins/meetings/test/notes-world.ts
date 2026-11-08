import { StartMeetingResponse } from '@manythreads/shared';
import { TEAM_IDS } from '@manythreads/test-utils';
import { expect } from 'vitest';
import { personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';

// Shared set-up for the tests of what happens after a meeting (shares, save to team, the notes routes): a finished room whose notes are in the organizer's Personal space, the
// way a note-taker leaves them. The rows are made by the system role (the note-taker's own run is tested in questions.test.ts), so these tests stay fast and need no model.

export type Who = (typeof personas)[keyof typeof personas];

export const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};

let seq = 0;

export interface SeededMeeting {
  id: string;
  channelId: string;
  threadRootId: string;
  botId: string;
  /** `Meetings/<folder>/transcript.md` in the organizer's Personal space. */
  transcriptPath: string;
  notesPath: string;
}

export const NOTES_MD = [
  '---',
  'type: "Meeting Notes"',
  'title: "Planning"',
  '---',
  '',
  '# Planning',
  '',
  '## Summary',
  '',
  'They agreed to ship on Thursday.',
  '',
  '## Decisions',
  '',
  '- Ship on Thursday ([00:00:00](transcript.md))',
  '',
].join('\n');

/** Makes a note-taker bot of the Engineering team (a row and its actor), as notetaker.test.ts does. */
export async function makeNoteTaker(w: FilesWorld, slug = 'note-taker', name = 'Note-taker'): Promise<string> {
  return w.system(async (tx) => {
    const found = await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2', [TEAM_IDS.Engineering, slug]);
    if (found.rows[0]) return found.rows[0].id;
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement, triggers)
       VALUES ($1, $2, $3, $4, 'Takes notes', 'agent', 'hermes', 'team', $5, 'active', '{"runner": "default"}', '[{"type": "meeting"}]'::jsonb) RETURNING id`,
      [personas.omar.workspaceId, TEAM_IDS.Engineering, slug, name, 'a'.repeat(64)],
    );
    await tx.query("INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2)", [personas.omar.workspaceId, bot.rows[0]!.id]);
    return bot.rows[0]!.id;
  });
}

/**
 * A room in `channelId` that the organizer started, with the people who joined and said yes or no, the lines they said, the note-taker set and the notes written to the organizer's
 * Personal space (rows only), and the room ended. The lines are sent by each speaker's own device, the way the web page does.
 */
export async function seedNoteTakerMeeting(
  w: FilesWorld,
  options: {
    organizer: Who;
    channelId: string;
    title?: string;
    others?: Array<[Who, 'yes' | 'no']>;
    organizerAnswer?: 'yes' | 'no';
    lines?: Array<[Who, string]>;
    notesMd?: string;
    notesStatus?: 'written' | 'failed' | 'pending';
    end?: boolean;
  },
): Promise<SeededMeeting> {
  const title = options.title ?? 'Planning';
  const started = StartMeetingResponse.parse(ok(await w.call(options.organizer, 'POST', `/api/channels/${options.channelId}/meetings`, { title })));
  const id = started.meeting.id;
  for (const [p] of options.others ?? []) ok(await w.call(p, 'POST', `/api/meetings/${id}/join`));
  ok(await w.call(options.organizer, 'PUT', `/api/meetings/${id}/transcription`, { mode: 'on_device' }));
  ok(await w.call(options.organizer, 'POST', `/api/meetings/${id}/consent`, { transcribe: options.organizerAnswer ?? 'yes' }));
  for (const [p, answer] of options.others ?? []) ok(await w.call(p, 'POST', `/api/meetings/${id}/consent`, { transcribe: answer }));
  let at = 0;
  for (const [speaker, text] of options.lines ?? []) {
    ok(await w.call(speaker, 'POST', `/api/meetings/${id}/segments`, { segments: [{ clientSegId: `nw${++seq}`, startMs: at, endMs: at + 1500, text, final: true }] }));
    at += 4000;
  }
  const botId = await makeNoteTaker(w);
  const folder = `2026-11-08-1000-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${seq}`;
  const transcriptPath = `Meetings/${folder}/transcript.md`;
  const notesPath = `Meetings/${folder}/notes.md`;
  const status = options.notesStatus ?? 'written';
  await w.system(async (tx) => {
    await tx.query('UPDATE app.meetings SET notetaker_bot_id = $2 WHERE id = $1', [id, botId]);
    await tx.query(
      `INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location, transcript_path, notes_path, summary, notes_md, items, status, failure)
       VALUES ($1, $2, $3, 'personal', $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        id,
        personas.omar.workspaceId,
        options.organizer.actorId,
        transcriptPath,
        status === 'written' ? notesPath : null,
        status === 'written' ? 'They agreed to ship on Thursday.' : '',
        status === 'written' ? (options.notesMd ?? NOTES_MD) : '',
        JSON.stringify(status === 'written' ? [{ kind: 'decision', text: 'Ship on Thursday', ownerName: null, ownerId: null, due: null, atMs: 0 }] : []),
        status,
        status === 'failed' ? 'The note-taker stopped before it finished.' : null,
      ],
    );
  });
  if (options.end !== false) ok(await w.call(options.organizer, 'POST', `/api/meetings/${id}/end`));
  return { id, channelId: options.channelId, threadRootId: started.meeting.threadRootId!, botId, transcriptPath, notesPath };
}

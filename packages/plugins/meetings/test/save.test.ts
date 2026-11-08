import {
  GetMeetingByPathResponse,
  GetMeetingNotesResponse,
  GetMeetingOverviewResponse,
  GetMeetingTranscriptResponse,
  GetRepoBlobResponse,
  GetRepoHistoryResponse,
  PutMeetingNotesResponse,
  SaveMeetingToTeamResponse,
} from '@manythreads/shared';
import { TEAM_IDS, relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type FilesWorld } from '../../files/test/world.ts';
import { ok, seedNoteTakerMeeting, type SeededMeeting } from './notes-world.ts';

// Reading, editing and saving the notes of a note-taker meeting (PLAN P15-20, P15-23, decision C19): the meeting page's summary, the notes view and its buttons, the edit with its
// conflict check, "Save to team" (once, with the organizer on the commit, and a drop into the memory inbox unless it is switched off), the lookup from a file path to its meeting.

const { omar, nadia, rafi, priya, sameera } = personas;
vi.setConfig({ testTimeout: 120_000 });

let w: FilesWorld;
let general = '';
let m1: SeededMeeting;
let repoDir = '';

const notesOf = (who: typeof nadia, id: string) => w.call(who, 'GET', `/api/meetings/${id}/notes`);
const blob = async (path: string): Promise<string> => GetRepoBlobResponse.parse(ok(await w.call(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`))).content;
const events = (type: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));
const row = (id: string) =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ location: string; saved_path: string | null; saved_at: Date | null; saved_by: string | null; memory_item_id: string | null; file_ids: string[]; transcript_path: string; notes_path: string | null; notes_md: string }>(
          'SELECT location, saved_path, saved_at, saved_by::text, memory_item_id::text, file_ids, transcript_path, notes_path, notes_md FROM app.meeting_notes WHERE meeting_id = $1',
          [id],
        )
      ).rows[0]!,
  );

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld({ limiter: relaxedRateLimiter() } as never);
  await ensureChannels(w);
  general = await w.channelId('engineering', 'general');
  m1 = await seedNoteTakerMeeting(w, {
    organizer: nadia,
    channelId: general,
    title: 'Release planning',
    others: [[rafi, 'yes'], [priya, 'no']],
    lines: [[nadia, 'We ship on Thursday.'], [rafi, 'Agreed, Thursday it is.'], [priya, 'This must never be written down.']],
  });
}, 240_000);
afterAll(async () => {
  await w?.close();
  delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
});

describe('the summary at the top of the meeting page', () => {
  it('gives the organizer the whole picture, and says what only they may do', async () => {
    const s = GetMeetingOverviewResponse.parse(ok(await w.call(nadia, 'GET', `/api/meetings/${m1.id}/summary`)));
    expect(s).toMatchObject({
      teamSlug: 'engineering',
      channelName: 'general',
      organizerName: 'Nadia',
      location: 'personal',
      notesStatus: 'written',
      decisionCount: 1,
      actionItemCount: 0,
      hasAudio: false,
      you: { isOrganizer: true, canManage: true, canReadNotes: true },
      thread: { channelId: general, rootId: m1.threadRootId },
    });
    expect(s.notetaker).toMatchObject({ name: 'Note-taker', slug: 'note-taker' });
    expect(s.people.map((p) => [p.displayName, p.transcribed]).sort()).toEqual([['Nadia', true], ['Priya', false], ['Rafi', true]]);
    expect(s.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(s.transcriptPath).toBe(m1.transcriptPath);
  });
  it('shows a reader of the channel who may not read the notes the room only: no paths, no counts, no status', async () => {
    const s = GetMeetingOverviewResponse.parse(ok(await w.call(rafi, 'GET', `/api/meetings/${m1.id}/summary`)));
    expect(s).toMatchObject({ location: null, notesStatus: null, transcriptPath: null, notesPath: null, decisionCount: 0, you: { isOrganizer: false, canManage: false, canReadNotes: false } });
    expect(s.organizerName).toBe('Nadia');
  });
  it('is not shown to a person who cannot see the room', async () => {
    expect((await w.call(sameera, 'GET', `/api/meetings/${m1.id}/summary`)).status).toBe(404);
  });
});

describe('the notes view', () => {
  it('tells the organizer where the files are and which buttons to draw', async () => {
    const n = GetMeetingNotesResponse.parse(ok(await notesOf(nadia, m1.id)));
    expect(n).toMatchObject({
      status: 'written',
      location: 'personal',
      transcriptPath: m1.transcriptPath,
      notesPath: m1.notesPath,
      canEdit: true,
      canShare: true,
      canSaveToTeam: true,
      canSendToMemory: false,
      savedPath: null,
    });
  });
  it('is not given to a reader of the channel the notes were not shared with, however the question is asked', async () => {
    expect((await notesOf(rafi, m1.id)).status).toBe(404);
    expect((await w.call(rafi, 'GET', `/api/meetings/${m1.id}/transcript?copy=organizer`)).status).toBe(404);
    expect((await notesOf(sameera, m1.id)).status).toBe(404);
  });
});

describe('editing the notes', () => {
  it('writes the new text to the organizer’s Personal file and keeps the old one as a version', async () => {
    const before = GetMeetingNotesResponse.parse(ok(await notesOf(nadia, m1.id)));
    const edited = PutMeetingNotesResponse.parse(ok(await w.call(nadia, 'PUT', `/api/meetings/${m1.id}/notes`, { notesMd: `${before.notesMd}\n## Extra\n\nA line added by hand.\n`, baseUpdatedAt: before.updatedAt })));
    expect(edited.notesMd).toContain('A line added by hand.');
    expect(edited.updatedAt >= before.updatedAt).toBe(true);
    expect(edited.status).toBe('written');
    expect((await row(m1.id)).file_ids.length).toBeGreaterThanOrEqual(1);
    expect((await row(m1.id)).location).toBe('personal');
  });
  it('refuses a change made from an old view with 409, and leaves the text as it is', async () => {
    const now = GetMeetingNotesResponse.parse(ok(await notesOf(nadia, m1.id)));
    const res = await w.call(nadia, 'PUT', `/api/meetings/${m1.id}/notes`, { notesMd: 'Overwritten.', baseUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(GetMeetingNotesResponse.parse(ok(await notesOf(nadia, m1.id))).notesMd).toBe(now.notesMd);
  });
  it('refuses empty notes and a person who is not the organizer', async () => {
    expect((await w.call(nadia, 'PUT', `/api/meetings/${m1.id}/notes`, { notesMd: '   ' })).status).toBe(400);
    expect((await w.call(rafi, 'PUT', `/api/meetings/${m1.id}/notes`, { notesMd: 'Mine.' })).status).toBe(404);
  });
});

describe('Save to team', () => {
  it('is for the organizer only, and not for notes that are not written', async () => {
    expect((await w.call(rafi, 'POST', `/api/meetings/${m1.id}/save-to-team`, { addToMemory: false })).status).toBe(404);
    const pending = await seedNoteTakerMeeting(w, { organizer: nadia, channelId: await w.channelId('engineering', 'dev'), title: 'No notes yet', notesStatus: 'pending' });
    expect((await w.call(nadia, 'POST', `/api/meetings/${pending.id}/save-to-team`, { addToMemory: false })).status).toBe(409);
    const live = await seedNoteTakerMeeting(w, { organizer: nadia, channelId: await w.channelId('engineering', 'incidents'), title: 'Still going', end: false });
    expect((await w.call(nadia, 'POST', `/api/meetings/${live.id}/save-to-team`, { addToMemory: false })).status).toBe(409);
    ok(await w.call(nadia, 'POST', `/api/meetings/${live.id}/end`));
    // a team she cannot see is a team that is not there
    expect((await w.call(nadia, 'POST', `/api/meetings/${m1.id}/save-to-team`, { teamSlug: 'marketing', addToMemory: false })).status).toBe(404);
    expect((await w.call(nadia, 'POST', `/api/meetings/${m1.id}/save-to-team`, { teamSlug: 'no-such-team', addToMemory: false })).status).toBe(404);
    expect((await row(m1.id)).saved_at).toBeNull();
  });

  it('copies both files into the team’s meeting folder with the organizer on the commit, and drops the notes into the memory inbox', async () => {
    const saved = SaveMeetingToTeamResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${m1.id}/save-to-team`, {})));
    expect(saved.path).toMatch(/^meetings\/\d{4}\/\d{2}\/\d{2}-\d{4}-release-planning\/notes\.md$/);
    repoDir = saved.path.replace(/notes\.md$/, '');
    expect(saved.memoryItemId).not.toBeNull();
    expect(saved.notes).toMatchObject({ canSaveToTeam: false, savedPath: saved.path, location: 'personal', memoryItemId: saved.memoryItemId });

    const notes = await blob(saved.path);
    expect(notes).toContain('A line added by hand.');
    const transcript = await blob(`${repoDir}transcript.md`);
    expect(transcript).toContain('**Nadia:** We ship on Thursday.');
    expect(transcript).toContain('**Rafi:** Agreed, Thursday it is.');
    expect(transcript).not.toContain('never be written');
    expect(transcript).toMatch(/Priya spoke \(not transcribed\)/);

    const history = GetRepoHistoryResponse.parse(ok(await w.call(omar, 'GET', `/api/teams/engineering/repo/history?path=${encodeURIComponent(repoDir)}`)));
    expect(history.commits).toHaveLength(1);
    expect(history.commits[0]!.coAuthorIds).toEqual([nadia.actorId]);

    const r = await row(m1.id);
    expect(r).toMatchObject({ location: 'personal', saved_path: saved.path, saved_by: nadia.actorId, memory_item_id: saved.memoryItemId });
    const logged = (await events('meetings.notes.saved')).filter((e) => e['meetingId'] === m1.id);
    expect(logged).toEqual([expect.objectContaining({ savedBy: nadia.actorId, path: saved.path, toMemory: true })]);
    expect(JSON.stringify(logged)).not.toContain('Thursday');

    const item = await w.system(
      async (tx) => (await tx.query<{ name: string; team_id: string; origin: string; dropper_id: string | null }>('SELECT name, team_id::text, origin, dropper_id::text FROM app.memory_inbox_items WHERE id = $1', [saved.memoryItemId])).rows[0],
    );
    expect(item).toMatchObject({ team_id: TEAM_IDS.Engineering, dropper_id: nadia.actorId });
    expect(item!.name).toContain('Release planning');
  });

  it('is done once per meeting: a second try is a 409 and changes nothing', async () => {
    const before = await row(m1.id);
    expect((await w.call(nadia, 'POST', `/api/meetings/${m1.id}/save-to-team`, {})).status).toBe(409);
    expect(await row(m1.id)).toEqual(before);
    expect((await events('meetings.notes.saved')).filter((e) => e['meetingId'] === m1.id)).toHaveLength(1);
  });

  it('opens the notes to the readers of the place the call was held, through the team copy', async () => {
    const n = GetMeetingNotesResponse.parse(ok(await notesOf(rafi, m1.id)));
    expect(n).toMatchObject({ status: 'written', location: 'personal', notesPath: `${repoDir}notes.md`, transcriptPath: `${repoDir}transcript.md`, canShare: false, canSaveToTeam: false });
    expect(n.notesMd).toContain('A line added by hand.');
    const lines = GetMeetingTranscriptResponse.parse(ok(await w.call(rafi, 'GET', `/api/meetings/${m1.id}/transcript?copy=organizer`))).lines;
    expect(lines.map((l) => l.text)).toContain('We ship on Thursday.');
    expect(lines.map((l) => l.text).join(' ')).not.toContain('never be written');
    expect((await notesOf(sameera, m1.id)).status).toBe(404);
    // the organizer still sees her own Personal paths
    expect(GetMeetingNotesResponse.parse(ok(await notesOf(nadia, m1.id))).transcriptPath).toBe(m1.transcriptPath);
  });

  it('keeps the team copy in step when the organizer edits the notes afterwards', async () => {
    const before = GetMeetingNotesResponse.parse(ok(await notesOf(nadia, m1.id)));
    ok(await w.call(nadia, 'PUT', `/api/meetings/${m1.id}/notes`, { notesMd: `${before.notesMd}\nSecond edit.\n`, baseUpdatedAt: before.updatedAt }));
    expect(await blob(`${repoDir}notes.md`)).toContain('Second edit.');
  });

  it('can leave the memory inbox out', async () => {
    const m3 = await seedNoteTakerMeeting(w, { organizer: nadia, channelId: await w.channelId('engineering', 'dev'), title: 'Retro', lines: [[nadia, 'Retro words.']] });
    const saved = SaveMeetingToTeamResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${m3.id}/save-to-team`, { addToMemory: false })));
    expect(saved.memoryItemId).toBeNull();
    expect((await row(m3.id)).memory_item_id).toBeNull();
    expect((await events('meetings.notes.saved')).filter((e) => e['meetingId'] === m3.id)[0]).toMatchObject({ toMemory: false });
  });

  it('keeps two meetings with the same title and minute in separate folders', async () => {
    const a = await seedNoteTakerMeeting(w, { organizer: nadia, channelId: await w.channelId('engineering', 'dev'), title: 'Same name', lines: [[nadia, 'one']] });
    const b = await seedNoteTakerMeeting(w, { organizer: nadia, channelId: await w.channelId('engineering', 'incidents'), title: 'Same name', lines: [[nadia, 'two']] });
    // the same minute for certain
    await w.system(async (tx) => void (await tx.query('UPDATE app.meetings SET started_at = (SELECT started_at FROM app.meetings WHERE id = $1) WHERE id = $2', [a.id, b.id]).catch(() => undefined)));
    const one = SaveMeetingToTeamResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${a.id}/save-to-team`, { addToMemory: false })));
    const two = SaveMeetingToTeamResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${b.id}/save-to-team`, { addToMemory: false })));
    expect(one.path).not.toBe(two.path);
    expect(await blob(two.path.replace(/notes\.md$/, 'transcript.md'))).toContain('two');
    expect(await blob(one.path.replace(/notes\.md$/, 'transcript.md'))).toContain('one');
  });
});

describe('from a file to its meeting', () => {
  const byPath = (who: typeof nadia, query: string) => w.call(who, 'GET', `/api/meetings/by-path?${query}`);

  it('finds a meeting from its team copy: the folder or a file in it', async () => {
    const dir = repoDir.replace(/\/$/, '');
    for (const path of [dir, `${dir}/`, `${dir}/notes.md`, `${dir}/transcript.md`]) {
      expect(GetMeetingByPathResponse.parse(ok(await byPath(rafi, `path=${encodeURIComponent(path)}&team=engineering`))).meetingId, path).toBe(m1.id);
    }
  });
  it('needs the team for a repo path, and finds nothing for another team’s', async () => {
    expect((await byPath(rafi, `path=${encodeURIComponent(`${repoDir}notes.md`)}`)).status).toBe(404);
    expect((await byPath(tariqLike(), `path=${encodeURIComponent(`${repoDir}notes.md`)}&team=engineering`)).status).toBe(404);
  });
  it('finds a Personal meeting for its organizer only, and only with no team', async () => {
    const folder = m1.transcriptPath.replace(/\/transcript\.md$/, '');
    for (const path of [folder, `${folder}/transcript.md`, `${folder}/notes.md`]) {
      expect(GetMeetingByPathResponse.parse(ok(await byPath(nadia, `path=${encodeURIComponent(path)}`))).meetingId, path).toBe(m1.id);
    }
    expect((await byPath(rafi, `path=${encodeURIComponent(folder)}`)).status).toBe(404);
  });
  it('finds a meeting kept in a channel’s Files folder, for the readers of the channel', async () => {
    const m4 = await seedNoteTakerMeeting(w, { organizer: nadia, channelId: general, title: 'Files one', lines: [[nadia, 'in files']] });
    await w.system(async (tx) => void (await tx.query("UPDATE app.meeting_notes SET location = 'channel_files', transcript_path = 'channels/general/meetings/2026-11-08-1100-files-one/transcript.md', notes_path = 'channels/general/meetings/2026-11-08-1100-files-one/notes.md' WHERE meeting_id = $1", [m4.id])));
    await w.system(async (tx) => void (await tx.query('UPDATE app.meetings SET notetaker_bot_id = NULL WHERE id = $1', [m4.id])));
    expect(GetMeetingByPathResponse.parse(ok(await byPath(rafi, 'path=channels/general/meetings/2026-11-08-1100-files-one/notes.md&team=engineering'))).meetingId).toBe(m4.id);
    expect((await byPath(rafi, 'path=channels/general/meetings/2026-11-08-1100-files-one&team=engineering')).status).toBe(200);
  });
  it('says nothing about a path that is not a meeting’s, climbs out of its place, or is a meeting the caller may not read', async () => {
    for (const path of ['', 'docs/readme.md', 'meetings/2026/11', `${repoDir}../x`, 'Meetings', 'Meetings/../Meetings/x']) {
      expect((await byPath(nadia, `path=${encodeURIComponent(path)}&team=engineering`)).status, path).toBeGreaterThanOrEqual(400);
    }
    const hidden = await seedNoteTakerMeeting(w, { organizer: rafi, channelId: general, title: 'Private notes', lines: [[rafi, 'secret']] });
    const folder = hidden.transcriptPath.replace(/\/transcript\.md$/, '');
    expect((await byPath(nadia, `path=${encodeURIComponent(folder)}`)).status).toBe(404);
  });
});

/** A person of another team (Marketing), for "the same path in another team". */
function tariqLike(): typeof nadia {
  return personas.tariq as typeof nadia;
}

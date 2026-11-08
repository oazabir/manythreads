import { GetRepoBlobResponse, GetRepoHistoryResponse, StartMeetingResponse } from '@manythreads/shared';
import { relaxedRateLimiter, testClient } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';

// The transcript file (P15-09): written two minutes ten seconds after a room ended, into the team repo for a public channel and into Files storage for a private one, readable by
// exactly the people who can read the room, once for the end and again (quietly) after a correction.

const { omar, nadia, rafi, priya } = personas;

let w: FilesWorld;
const originalProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];
beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld({ limiter: relaxedRateLimiter() } as never);
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
  if (originalProvider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = originalProvider;
});

type Who = typeof nadia;
let seq = 0;
const line = (text: string, startMs: number) => ({ clientSegId: `w${++seq}`, startMs, endMs: startMs + 1500, text, final: true });
const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const open = async (channel: string, title: string, people: [Who, 'yes' | 'no'][]): Promise<string> => {
  const [starter, ...rest] = people;
  const started = ok<unknown>(await w.call(starter![0], 'POST', `/api/channels/${channel}/meetings`, { title }));
  const id = StartMeetingResponse.parse(started).meeting.id;
  for (const [p] of rest) ok(await w.call(p, 'POST', `/api/meetings/${id}/join`));
  ok(await w.call(starter![0], 'PUT', `/api/meetings/${id}/transcription`, { mode: 'on_device' }));
  for (const [p, answer] of people) ok(await w.call(p, 'POST', `/api/meetings/${id}/consent`, { transcribe: answer }));
  return id;
};
const say = async (who: Who, room: string, text: string, startMs: number): Promise<void> => {
  ok(await w.call(who, 'POST', `/api/meetings/${room}/segments`, { segments: [line(text, startMs)] }));
};
const end = async (room: string, who: Who = nadia): Promise<void> => void ok(await w.call(who, 'POST', `/api/meetings/${room}/end`));
const jobs = (room: string) =>
  w.system(async (tx) =>
    (await tx.query<{ id: string; run_at: Date; state: string; payload: Record<string, unknown> }>("SELECT id, run_at, state, payload FROM app.jobs WHERE queue = 'meetings.transcript' AND payload->>'meetingId' = $1 ORDER BY created_at", [room])).rows,
  );
/** Runs the queued transcript job now instead of in two minutes, and waits for it to finish. */
const runNow = async (room: string, count = 1): Promise<void> => {
  await eventually(async () => ((await jobs(room)).length >= count ? true : undefined), 20_000, 'the transcript job to be queued');
  await w.system(async (tx) => void (await tx.query("UPDATE app.jobs SET run_at = now() WHERE queue = 'meetings.transcript' AND payload->>'meetingId' = $1 AND state = 'ready'", [room])));
  await eventually(async () => ((await jobs(room)).every((j) => j.state === 'done' || j.state === 'completed' || j.state === 'succeeded') ? true : undefined), 30_000, 'the transcript job to finish');
};
const meeting = (room: string) =>
  w.system(async (tx) => (await tx.query<{ transcript_path: string | null; transcript_file_id: string | null; ended_at: Date | null; title: string }>('SELECT transcript_path, transcript_file_id, ended_at, title FROM app.meetings WHERE id = $1', [room])).rows[0]!);
const written = (room: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'meetings.transcript.written' AND payload->>'meetingId' = $1", [room])).rows.map((r) => r.payload));
const note = (room: string) => w.system(async (tx) => (await tx.query<{ location: string; transcript_path: string; file_ids: string[]; status: string }>('SELECT location, transcript_path, file_ids, status FROM app.meeting_notes WHERE meeting_id = $1', [room])).rows[0]);
const blob = async (who: Who, path: string): Promise<string> => GetRepoBlobResponse.parse(ok(await w.call(who, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`))).content;

describe('a public channel: the team repo', () => {
  let room = '';
  let path = '';
  it('queues the file two minutes ten seconds after the end of the room', async () => {
    room = await open(await w.channelId('engineering', 'general'), 'Sprint review: Q4!', [[nadia, 'yes'], [rafi, 'yes'], [omar, 'no']]);
    await say(nadia, room, 'Welcome *everyone* to the <review>', 0);
    await say(rafi, room, 'Thanks Nadia', 3000);
    await say(omar, room, 'this must never be written', 6000);
    await end(room, nadia);
    const queued = await eventually(async () => {
      const j = await jobs(room);
      return j.length > 0 ? j : undefined;
    });
    const endedAt = (await meeting(room)).ended_at!;
    expect(queued[0]!.run_at.getTime() - endedAt.getTime()).toBe(130_000);
    expect(await meeting(room)).toMatchObject({ transcript_path: null });
  });

  it('writes meetings/<year>/<month>/<day>-<time>-<title>/transcript.md with the words of those who said yes and a stand-in for the rest', async () => {
    await runNow(room);
    const m = await meeting(room);
    path = m.transcript_path!;
    expect(path).toMatch(/^meetings\/\d{4}\/\d{2}\/\d{2}-\d{4}-sprint-review-q4\/transcript\.md$/);
    const text = await blob(priya, path); // a member of the team, not of the room
    expect(text).toContain('type: "Meeting Transcript"');
    expect(text).toContain('title: "Sprint review: Q4!"');
    expect(text).toContain('source: on-device');
    expect(text).toContain('[00:00:00] **Nadia:** Welcome \\*everyone\\* to the \\<review\\>');
    expect(text).toContain('[00:00:03] **Rafi:** Thanks Nadia');
    expect(text).toContain('[00:00:06] *Omar spoke (not transcribed)*');
    expect(text).not.toContain('must never be written');
    expect(await note(room)).toMatchObject({ location: 'repo', transcript_path: path, file_ids: [] });
  });

  it('commits as the system with the speakers who said yes as co-authors, and says so once in an event', async () => {
    const history = GetRepoHistoryResponse.parse(ok(await w.call(priya, 'GET', `/api/teams/engineering/repo/history?path=${encodeURIComponent(path)}`)));
    expect(history.commits).toHaveLength(1);
    expect([...history.commits[0]!.coAuthorIds].sort()).toEqual([nadia.actorId, rafi.actorId].sort());
    const events = await written(room);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ meetingId: room, path, store: 'repo', lineCount: 3 });
    expect(JSON.stringify(events[0])).not.toContain('Welcome');
  });

  it('is written again after a correction, at the same place, without a second event', async () => {
    const seg = (await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.meeting_segments WHERE meeting_id = $1 AND speaker_id = $2", [room, rafi.actorId])).rows[0]!.id));
    ok(await w.call(rafi, 'PATCH', `/api/meetings/${room}/segments/${seg}`, { text: 'Thanks, Nadia, that was clear' }));
    await runNow(room, 2);
    expect((await meeting(room)).transcript_path).toBe(path);
    const text = await blob(nadia, path);
    expect(text).toContain('Thanks, Nadia, that was clear');
    expect(text).not.toContain('Thanks Nadia\n');
    expect(GetRepoHistoryResponse.parse(ok(await w.call(priya, 'GET', `/api/teams/engineering/repo/history?path=${encodeURIComponent(path)}`))).commits).toHaveLength(2);
    expect(await written(room)).toHaveLength(1);
  });

  it('keeps two meetings with the same title and minute apart', async () => {
    const a = await open(await w.channelId('engineering', 'dev'), 'Standup', [[nadia, 'yes']]);
    await say(nadia, a, 'one', 0);
    await end(a);
    await runNow(a);
    const b = await open(await w.channelId('engineering', 'dev'), 'Standup', [[nadia, 'yes']]);
    await say(nadia, b, 'two', 0);
    // the same minute for certain: the owner copies the start of the first onto the second (the guard on the room's times is off for that statement)
    const owner = testClient({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE app.meetings DISABLE TRIGGER meetings_guard');
      await owner.query('UPDATE app.meetings SET started_at = (SELECT started_at FROM app.meetings WHERE id = $1) WHERE id = $2', [a, b]);
      await owner.query('ALTER TABLE app.meetings ENABLE TRIGGER meetings_guard');
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    await end(b);
    await runNow(b);
    const pa = (await meeting(a)).transcript_path!;
    const pb = (await meeting(b)).transcript_path!;
    expect(pa).not.toBe(pb);
    expect(pb).toBe(pa.replace('-standup/', '-standup-2/'));
    expect(await blob(nadia, pa)).toContain('one');
    expect(await blob(nadia, pb)).toContain('two');
  });
});

describe('a private channel: Files storage', () => {
  let room = '';
  let channel = '';
  let fileId = '';
  beforeAll(async () => {
    const made = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'leads-sync', private: true }), 201);
    channel = made.channel.id;
    for (const p of [nadia, rafi]) ok(await w.call(omar, 'POST', `/api/channels/${channel}/members`, { personId: p.personId }));
    room = await open(channel, 'Leads sync', [[omar, 'yes'], [nadia, 'yes'], [rafi, 'no']]);
    await say(omar, room, 'Salary review next week', 0);
    await say(nadia, room, 'Agreed', 4000);
    await end(room, omar);
  });

  it('writes channels/<name>/meetings/<folder>/transcript.md as a file the channel can read, and no commit', async () => {
    await runNow(room);
    const m = await meeting(room);
    expect(m.transcript_path).toMatch(/^channels\/leads-sync\/meetings\/\d{2}-\d{4}-leads-sync\/transcript\.md$/);
    fileId = m.transcript_file_id!;
    expect(fileId).toBeTruthy();
    expect(await note(room)).toMatchObject({ location: 'channel_files', transcript_path: m.transcript_path, file_ids: [fileId] });
    const got = await w.download(nadia, fileId);
    expect(got.status).toBe(200);
    expect(got.bytes.toString('utf8')).toContain('[00:00:00] **Omar:** Salary review next week');
    expect(got.bytes.toString('utf8')).toContain('[00:00:04] **Nadia:** Agreed');
    expect(await written(room)).toMatchObject([{ store: 'files', path: m.transcript_path }]);
    // nothing of it in the team repo
    expect((await w.call(priya, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(m.transcript_path!)}`)).status).toBe(404);
  });

  it('is not readable by a team member who is not in the channel (403), and not listed for them', async () => {
    expect((await w.download(priya, fileId)).status).toBe(403);
    const list = await w.call(priya, 'GET', `/api/channels/${channel}/files`);
    expect([403, 404]).toContain(list.status);
  });

  it('is written again in place after a correction (the same file, new bytes), with one event', async () => {
    const seg = await w.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.meeting_segments WHERE meeting_id = $1 AND speaker_id = $2', [room, nadia.actorId])).rows[0]!.id);
    ok(await w.call(nadia, 'PATCH', `/api/meetings/${room}/segments/${seg}`, { text: 'Agreed, with one change' }));
    await runNow(room, 2);
    expect((await meeting(room)).transcript_file_id).toBe(fileId);
    expect((await w.download(omar, fileId)).bytes.toString('utf8')).toContain('Agreed, with one change');
    expect(await written(room)).toHaveLength(1);
    const rows = await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.files WHERE channel_id = $1 AND name = 'transcript.md'", [channel])).rows.length);
    expect(rows).toBe(1);
  });
});

describe('when nothing is written', () => {
  it('writes no file for a room where nobody said yes, or nobody spoke, and says nothing', async () => {
    const quiet = await open(await w.channelId('engineering', 'releases'), 'Quiet', [[nadia, 'yes']]);
    await end(quiet);
    const silent = await open(await w.channelId('engineering', 'incidents'), 'Silent', [[nadia, 'no']]);
    await say(nadia, silent, 'not written', 0);
    await end(silent);
    await runNow(quiet);
    await runNow(silent);
    for (const room of [quiet, silent]) {
      expect((await meeting(room)).transcript_path).toBeNull();
      expect(await note(room)).toBeUndefined();
      expect(await written(room)).toEqual([]);
    }
  });

  it('leaves a room that a note-taker bot owns to the note-taker', async () => {
    const room = await open(await w.channelId('engineering', 'general'), 'With a note-taker', [[nadia, 'yes']]);
    await say(nadia, room, 'spoken', 0);
    const bot = await w.system(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
             SELECT $1, t.id, 'note-bot', 'note-bot', 'Takes notes', 'agent', 'hermes', 'team', $2, 'active', '{"runner": "default"}' FROM app.teams t WHERE t.slug = 'engineering' RETURNING id`,
            [omar.workspaceId, 'b'.repeat(64)],
          )
        ).rows[0]!.id,
    );
    await end(room, nadia);
    const owner = testClient({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE app.meetings DISABLE TRIGGER meetings_guard');
      await owner.query('UPDATE app.meetings SET notetaker_bot_id = $2 WHERE id = $1', [room, bot]);
      await owner.query('ALTER TABLE app.meetings ENABLE TRIGGER meetings_guard');
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    await runNow(room);
    expect((await meeting(room)).transcript_path).toBeNull();
    expect(await written(room)).toEqual([]);
  });
});

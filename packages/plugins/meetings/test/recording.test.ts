import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import { makeFakeAsrWav, readWavInfo } from '@manythreads/sdk';
import { MeetingRecordingState, StartMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { PcmSpool, audioFolder, audioSlug, readTeamKeepAudioDays, recordableNow, stopReasonFor, wavHeader, type PresentPerson } from '../src/recording.ts';

// Recording a room's audio (PLAN P15-15, decision C11). The pure parts first (the spool, the gate, TEAM.md, names), then the API against the fake media provider: off until an
// admin switches it on, one file per person who said yes, nothing written while anyone present has not, a yes that does not survive leaving and coming back, the files in the
// channel's Files storage and never in git.

const { omar, nadia, rafi } = personas;

const person = (actorId: string, yes: boolean, stored: PresentPerson['stored'] = yes ? 'yes' : 'unasked'): PresentPerson => ({ actorId, name: actorId, stored, yes });

describe('the recording gate', () => {
  it('records everybody present when everybody present said yes, and nobody otherwise', () => {
    expect(recordableNow(true, [person('a', true), person('b', true)])).toEqual(['a', 'b']);
    expect(recordableNow(true, [person('a', true), person('b', false)])).toEqual([]);
    expect(recordableNow(true, [person('a', false), person('b', false, 'no')])).toEqual([]);
  });
  it('records nobody when recording is off or the room is empty', () => {
    expect(recordableNow(false, [person('a', true)])).toEqual([]);
    expect(recordableNow(true, [])).toEqual([]);
  });
  it('says why a file stopped', () => {
    expect(stopReasonFor('a', [person('b', true)])).toBe('left');
    expect(stopReasonFor('a', [person('a', false, 'no'), person('b', true)])).toBe('consent_withdrawn');
    expect(stopReasonFor('a', [person('a', true), person('c', false)])).toBe('joined_without_yes');
  });
});

describe('TEAM.md: how long audio is kept', () => {
  it('keeps 30 days unless the file says otherwise', () => {
    expect(readTeamKeepAudioDays(null)).toBe(30);
    expect(readTeamKeepAudioDays('# Team\n')).toBe(30);
    expect(readTeamKeepAudioDays('---\nname: Engineering\n---\n')).toBe(30);
    expect(readTeamKeepAudioDays('---\nmeetings:\n  transcribe: server\n---\n')).toBe(30);
  });
  it('reads the number of days', () => {
    expect(readTeamKeepAudioDays('---\nmeetings:\n  keepAudioDays: 7\n---\n')).toBe(7);
    expect(readTeamKeepAudioDays('---\r\nmeetings:\r\n  keepAudioDays: 3650\r\n---\r\n')).toBe(3650);
  });
  it('falls back to 30 for anything that is not a whole number of days between 1 and 3650', () => {
    for (const bad of ['0', '-1', '3651', 'soon', '1.5', '"7"', 'true', '[7]']) expect(readTeamKeepAudioDays(`---\nmeetings:\n  keepAudioDays: ${bad}\n---\n`), bad).toBe(30);
    expect(readTeamKeepAudioDays('---\nmeetings: nope\n---\n')).toBe(30);
    expect(readTeamKeepAudioDays('---\n: : :\n  - [\n---\n')).toBe(30);
  });
});

describe('names and places', () => {
  it('makes a file name from a person name', () => {
    expect(audioSlug('Nadia Haddad')).toBe('nadia-haddad');
    expect(audioSlug('  ../..//')).toBe('voice');
    expect(audioSlug('Zoë Åström')).toBe('zoe-astrom');
    expect(audioSlug('x'.repeat(100)).length).toBe(40);
  });
  it('puts the audio in the channel’s Files folder, beside the transcript', () => {
    const at = new Date('2026-11-08T14:02:00Z');
    expect(audioFolder({ id: 'c1', name: 'general', kind: 'channel' }, at, 'Sprint review')).toBe('channels/general/meetings/08-1402-sprint-review/audio/');
    expect(audioFolder({ id: 'c1', name: 'x', kind: 'dm' }, at, 'Call')).toBe('dms/c1/meetings/08-1402-call/audio/');
  });
});

describe('the spool', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'spool-test-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const collect = async (spool: PcmSpool): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    for await (const p of spool.stream()) parts.push(p);
    return Buffer.concat(parts);
  };

  it('lays a chunk on the clock: silence before it, then the speech, then silence to the end', async () => {
    const spool = await PcmSpool.open(join(dir, 'a.pcm'), 10_000);
    expect(await spool.addChunk(makeFakeAsrWav('hi', 1000), 12_000)).toBe(true); // two seconds in
    await spool.finish(14_000);
    const wav = await collect(spool);
    const info = readWavInfo(wav);
    expect(info).toMatchObject({ ok: true, sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 4000 });
    // the first two seconds are silence, then the marker the fake transcriber reads
    const data = wav.subarray(44);
    expect(data.subarray(0, 64_000).every((b) => b === 0)).toBe(true);
    expect(Buffer.from(data.subarray(64_000, 64_000 + 12)).toString()).toBe('FAKEASR:hi\0\0'.slice(0, 12));
    await spool.discard();
  });

  it('appends a chunk that overlaps what is there (time never goes back) and refuses bytes that are not 16 kHz mono WAV', async () => {
    const spool = await PcmSpool.open(join(dir, 'b.pcm'), 0);
    expect(await spool.addChunk(makeFakeAsrWav('one', 1000), 0)).toBe(true);
    expect(await spool.addChunk(makeFakeAsrWav('two', 1000), 500)).toBe(true);
    expect(spool.durationMs).toBe(2000);
    expect(await spool.addChunk(new Uint8Array([1, 2, 3]), 3000)).toBe(false);
    expect(await spool.addChunk(new TextEncoder().encode('RIFF----WAVEfmt '.repeat(5)), 3000)).toBe(false);
    expect(spool.durationMs).toBe(2000);
    await spool.finish(500); // an earlier stop time never shortens the file
    expect(spool.durationMs).toBe(2000);
    await spool.discard();
  });

  it('stops growing at its limit and says so', async () => {
    const spool = await PcmSpool.open(join(dir, 'c.pcm'), 0, 48_000); // 1.5 seconds
    await spool.addChunk(makeFakeAsrWav('long', 1000), 0);
    expect(spool.atLimit).toBe(false);
    await spool.addChunk(makeFakeAsrWav('long', 1000), 1000);
    expect(spool.atLimit).toBe(true);
    await spool.finish(60_000);
    expect(spool.dataBytes).toBe(48_000);
    expect(readWavInfo(await collect(spool))).toMatchObject({ ok: true, durationMs: 1500 });
    await spool.discard();
  });

  it('removes its temporary file', async () => {
    const path = join(dir, 'd.pcm');
    const spool = await PcmSpool.open(path, 0);
    await spool.addChunk(makeFakeAsrWav('x', 100), 0);
    await spool.discard();
    await expect(fs.stat(path)).rejects.toThrow();
  });

  it('writes a header that matches its length', () => {
    const header = wavHeader(1234);
    const view = new DataView(header.buffer);
    expect(view.getUint32(4, true)).toBe(36 + 1234);
    expect(view.getUint32(40, true)).toBe(1234);
  });
});

let w: World;
const saved = { provider: process.env['MANYTHREADS_MEDIA_PROVIDER'], tmp: process.env['MANYTHREADS_RECORDING_TMP'] };
const HOOK = Symbol.for('manythreads.meetings.recording.hook');
let tmp = '';

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  tmp = await fs.mkdtemp(join(tmpdir(), 'recording-test-'));
  process.env['MANYTHREADS_RECORDING_TMP'] = tmp;
  (globalThis as unknown as Record<symbol, unknown>)[HOOK] = { reconcileMs: 250 };
  w = await createWorld();
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
  delete (globalThis as unknown as Record<symbol, unknown>)[HOOK];
  if (saved.provider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = saved.provider;
  if (saved.tmp === undefined) delete process.env['MANYTHREADS_RECORDING_TMP'];
  else process.env['MANYTHREADS_RECORDING_TMP'] = saved.tmp;
  await fs.rm(tmp, { recursive: true, force: true });
});

const room = async (who: typeof omar, name: string): Promise<{ id: string; thread: string }> => {
  const res = await w.call(who, 'POST', `/api/channels/${await w.channelId('engineering', name)}/meetings`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const m = StartMeetingResponse.parse(res.body).meeting;
  return { id: m.id, thread: m.threadRootId! };
};
const joinRoom = (who: typeof omar, id: string) => w.call(who, 'POST', `/api/meetings/${id}/join`);
const leave = (who: typeof omar, id: string) => w.call(who, 'POST', `/api/meetings/${id}/leave`);
const end = (who: typeof omar, id: string) => w.call(who, 'POST', `/api/meetings/${id}/end`);
const setRecording = (who: typeof omar, id: string, on: boolean) => w.call(who, 'PUT', `/api/meetings/${id}/recording`, { on });
const getRecording = async (who: typeof omar, id: string) => MeetingRecordingState.parse((await w.call(who, 'GET', `/api/meetings/${id}/recording`)).body);
const answer = (who: typeof omar, id: string, record: string) => w.call(who, 'POST', `/api/meetings/${id}/record-consent`, { record });
const cap = (value: 'on' | 'off') => w.call(omar, 'PUT', '/api/workspace/meetings-settings', { recordingCap: value });
const listenerOf = (id: string) => lastFakeMedia().listeners.get(id);
const rows = (id: string) =>
  w.system(async (tx) =>
    (
      await tx.query<{ actor_id: string; file_id: string | null; stopped_at: Date | null; stop_reason: string | null }>(
        'SELECT actor_id, file_id, stopped_at, stop_reason FROM app.meeting_recordings WHERE meeting_id = $1 ORDER BY started_at, id',
        [id],
      )
    ).rows,
  );
const events = (type: string, id: string) =>
  w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = $1 AND payload->>'meetingId' = $2 ORDER BY id", [type, id])).rows.map((r) => r.payload));
const thread = (rootId: string) => w.system(async (tx) => (await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE thread_root_id = $1 ORDER BY id', [rootId])).rows.map((r) => r.body));
const stored = (id: string) =>
  w.system(async (tx) => Object.fromEntries((await tx.query<{ actor_id: string; consent_record: string }>('SELECT actor_id, consent_record FROM app.meeting_participants WHERE meeting_id = $1', [id])).rows.map((r) => [r.actor_id, r.consent_record])));
const subscribed = (id: string): string[] => (listenerOf(id)?.subscriptions() ?? []).slice().sort();
const both = [nadia.actorId, rafi.actorId].sort();

describe('off until an admin switches it on', () => {
  it('says why, and refuses to turn it on', async () => {
    const r = await room(nadia, 'dev');
    const state = await getRecording(nadia, r.id);
    expect(state).toMatchObject({ cap: 'off', on: false, recording: false, yourConsent: 'unasked' });
    expect(state.reason).toMatch(/switched off for this workspace/);
    const res = await setRecording(nadia, r.id, true);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await getRecording(nadia, r.id)).on).toBe(false);
    expect(listenerOf(r.id)).toBeUndefined();
    await end(nadia, r.id);
  });
  it('is not shown to a stranger', async () => {
    const r = await room(nadia, 'dev');
    expect((await w.call(personas.sameera, 'GET', `/api/meetings/${r.id}/recording`)).status).toBe(404);
    await end(nadia, r.id);
  });
});

describe('a recorded room', () => {
  let id = '';
  let rootId = '';

  beforeAll(async () => {
    expect((await cap('on')).status).toBe(200);
    const r = await room(nadia, 'general');
    id = r.id;
    rootId = r.thread;
    await joinRoom(rafi, id);
  });
  afterAll(async () => {
    await end(nadia, id);
    await cap('off');
  });

  it('cannot be answered before it is on, and an answer needs a seat in the room', async () => {
    expect((await answer(nadia, id, 'yes')).status).toBe(409);
    const on = await setRecording(nadia, id, true);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(MeetingRecordingState.parse(on.body)).toMatchObject({ cap: 'on', on: true, recording: false, yourConsent: 'unasked', reason: null, files: [] });
    expect((await answer(omar, id, 'yes')).status).toBe(403); // omar is not in the room
    expect((await answer(nadia, id, 'unasked')).status).toBe(400);
  });

  it('joins the room as a listener of its own that publishes nothing, and hears nobody until everyone has said yes', async () => {
    await eventually(async () => listenerOf(id), 20_000, 'the recorder to join');
    const listener = listenerOf(id)!;
    expect(listener.options.listener?.identity).toBe(`recorder:${id}`);
    expect(lastFakeMedia().published()).toEqual([]);
    expect(subscribed(id)).toEqual([]);

    expect((await answer(nadia, id, 'yes')).status).toBe(200);
    expect((await getRecording(nadia, id)).yourConsent).toBe('yes');
    expect((await getRecording(rafi, id)).yourConsent).toBe('unasked');
    await new Promise((r) => setTimeout(r, 800));
    expect(subscribed(id)).toEqual([]); // rafi has not said yes: nobody is heard
    expect(listener.deliver({ identity: nadia.actorId, wav: makeFakeAsrWav('hello', 1000), startedAt: new Date(), durationMs: 1000 })).toBe(false);
    expect(await rows(id)).toEqual([]);
    expect((await getRecording(nadia, id)).recording).toBe(false);
  });

  it('starts one file per person the moment everybody present has said yes, and writes what they say on the room’s clock', async () => {
    expect((await answer(rafi, id, 'yes')).status).toBe(200);
    await eventually(async () => (JSON.stringify(subscribed(id)) === JSON.stringify(both) ? true : undefined), 20_000, 'both to be heard');
    expect((await getRecording(rafi, id)).recording).toBe(true);
    const open = await rows(id);
    expect(open.map((r) => r.actor_id).sort()).toEqual(both);
    expect(open.every((r) => r.stopped_at === null && r.file_id === null)).toBe(true);
    expect(await events('meetings.recording.started', id)).toMatchObject([{ people: 2, startedBy: nadia.actorId }]);

    const listener = listenerOf(id)!;
    const at = Date.now() + 2000;
    expect(listener.deliver({ identity: nadia.actorId, wav: makeFakeAsrWav('hello from nadia', 1000), startedAt: new Date(at), durationMs: 1000 })).toBe(true);
    expect(listener.deliver({ identity: rafi.actorId, wav: makeFakeAsrWav('hello from rafi', 1000), startedAt: new Date(at), durationMs: 1000 })).toBe(true);
    // a person not in the room (never subscribed) is refused by the provider, and nothing of theirs is kept
    expect(listener.deliver({ identity: omar.actorId, wav: makeFakeAsrWav('not here', 1000), startedAt: new Date(at), durationMs: 1000 })).toBe(false);
  });

  it('stops everybody’s file when one person says no, keeps what was said, and tells the call thread', async () => {
    expect((await answer(rafi, id, 'no')).status).toBe(200);
    await eventually(async () => ((await rows(id)).every((r) => r.stopped_at !== null) ? true : undefined), 20_000, 'both files to close');
    const closed = await rows(id);
    const byActor = Object.fromEntries(closed.map((r) => [r.actor_id, r.stop_reason]));
    expect(byActor).toEqual({ [nadia.actorId]: 'joined_without_yes', [rafi.actorId]: 'consent_withdrawn' });
    expect(closed.every((r) => r.file_id !== null)).toBe(true);
    expect(subscribed(id)).toEqual([]);

    // the files are in the channel's Files storage, the person whose voice it is is the uploader, and none of it went anywhere else
    const files = await w.system(async (tx) =>
      (
        await tx.query<{ id: string; folder_path: string; name: string; mime: string; size: string; uploader_id: string; channel_id: string }>(
          `SELECT f.id, f.folder_path, f.name, f.mime, f.size::text, f.uploader_id, f.channel_id FROM app.files f JOIN app.meeting_recordings r ON r.file_id = f.id WHERE r.meeting_id = $1 ORDER BY f.name`,
          [id],
        )
      ).rows,
    );
    expect(files.map((f) => f.name)).toEqual(['nadia.wav', 'rafi.wav']);
    for (const f of files) {
      expect(f.mime).toBe('audio/wav');
      expect(f.folder_path).toMatch(/^channels\/general\/meetings\/\d\d-\d{4}-[a-z0-9-]+\/audio\/$/);
      expect(f.channel_id).toBe(await w.channelId('engineering', 'general'));
      // 2 s of silence, then 1 s of speech (the session began a little before the test's clock: a little more silence, never less)
      expect(Number(f.size)).toBeGreaterThanOrEqual(44 + 32 * 3000);
      expect(Number(f.size)).toBeLessThan(44 + 32 * 6000);
    }
    expect(new Set(files.map((f) => f.uploader_id))).toEqual(new Set(both));

    // the thread line and the events follow the files being kept
    await eventually(async () => ((await thread(rootId)).some((b) => b.startsWith('Recording stopped')) ? true : undefined), 20_000, 'the thread line');
    await eventually(async () => ((await events('meetings.recording.stopped', id)).length >= 2 ? true : undefined), 20_000, 'the stopped events');
    expect((await events('meetings.recording.stopped', id)).map((e) => e['reason']).sort()).toEqual(['consent_withdrawn', 'joined_without_yes']);
    expect(JSON.stringify(await events('meetings.recording.stopped', id))).not.toMatch(/Nadia|Rafi/);
    expect((await getRecording(nadia, id)).files).toHaveLength(2);
  });

  it('starts new files when the one who said no says yes, and stops them when someone who has not said yes joins', async () => {
    expect((await answer(rafi, id, 'yes')).status).toBe(200);
    await eventually(async () => (JSON.stringify(subscribed(id)) === JSON.stringify(both) ? true : undefined), 20_000, 'both to be heard again');
    expect((await rows(id)).filter((r) => r.stopped_at === null)).toHaveLength(2);

    expect((await joinRoom(omar, id)).status).toBe(200);
    await eventually(async () => ((await rows(id)).every((r) => r.stopped_at !== null) ? true : undefined), 20_000, 'the files to close for the newcomer');
    expect((await rows(id)).slice(2).map((r) => r.stop_reason)).toEqual(['joined_without_yes', 'joined_without_yes']);
    expect(subscribed(id)).toEqual([]);
    expect((await getRecording(nadia, id)).recording).toBe(false);
    // the newcomer was never recorded: no file of omar's, and nothing was ever subscribed for them
    expect((await rows(id)).some((r) => r.actor_id === omar.actorId)).toBe(false);
    expect(lastFakeMedia().published()).toEqual([]);
  });

  it('writes again when the newcomer leaves, and closes every file when the room ends', async () => {
    expect((await leave(omar, id)).status).toBe(200);
    await eventually(async () => (JSON.stringify(subscribed(id)) === JSON.stringify(both) ? true : undefined), 20_000, 'both to be heard after the newcomer left');
    expect((await end(nadia, id)).status).toBe(200);
    await eventually(async () => ((await rows(id)).every((r) => r.stopped_at !== null) ? true : undefined), 20_000, 'the files to close at the end');
    const last = (await rows(id)).slice(4);
    expect(last.map((r) => r.stop_reason)).toEqual(['ended', 'ended']);
    expect(last.every((r) => r.file_id !== null)).toBe(true);
    await eventually(async () => (listenerOf(id) === undefined ? true : undefined), 20_000, 'the recorder to leave');
    // nothing is left in the temporary folder
    expect(await fs.readdir(tmp)).toEqual([]);
  });
});

describe('a yes does not follow a person who leaves and comes back', () => {
  it('asks again after a rejoin, and records nobody until they answer', async () => {
    expect((await cap('on')).status).toBe(200);
    const r = await room(nadia, 'incidents');
    await joinRoom(rafi, r.id);
    expect((await setRecording(nadia, r.id, true)).status).toBe(200);
    await eventually(async () => listenerOf(r.id), 20_000, 'the recorder to join');
    await answer(nadia, r.id, 'yes');
    await answer(rafi, r.id, 'yes');
    await eventually(async () => (JSON.stringify(subscribed(r.id)) === JSON.stringify(both) ? true : undefined), 20_000, 'both to be heard');

    await leave(rafi, r.id);
    await joinRoom(rafi, r.id);
    // the stored yes is still in the row for a moment; the recorder finds it older than the join and takes it back
    await eventually(async () => ((await stored(r.id))[rafi.actorId] === 'unasked' ? true : undefined), 20_000, 'the old yes to be taken back');
    expect(subscribed(r.id)).toEqual([]);
    expect((await getRecording(rafi, r.id)).yourConsent).toBe('unasked');
    expect((await getRecording(nadia, r.id)).recording).toBe(false);

    await answer(rafi, r.id, 'yes');
    await eventually(async () => (JSON.stringify(subscribed(r.id)) === JSON.stringify(both) ? true : undefined), 20_000, 'both to be heard after the new answer');
    await end(nadia, r.id);
    await eventually(async () => ((await rows(r.id)).every((row) => row.stopped_at !== null) ? true : undefined), 20_000, 'files closed');
    await cap('off');
  });
});

describe('turning it off', () => {
  it('lets the person who turned it on, and nobody who just sits in the room, and closes the files', async () => {
    expect((await cap('on')).status).toBe(200);
    const r = await room(nadia, 'releases');
    await joinRoom(rafi, r.id);
    expect((await setRecording(nadia, r.id, true)).status).toBe(200);
    await eventually(async () => listenerOf(r.id), 20_000, 'the recorder to join');
    await answer(nadia, r.id, 'yes');
    await answer(rafi, r.id, 'yes');
    await eventually(async () => (JSON.stringify(subscribed(r.id)) === JSON.stringify(both) ? true : undefined), 20_000, 'both to be heard');

    const refused = await setRecording(rafi, r.id, false);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect((await getRecording(rafi, r.id)).on).toBe(true);

    const off = await setRecording(nadia, r.id, false);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(MeetingRecordingState.parse(off.body)).toMatchObject({ on: false, recording: false });
    await eventually(async () => ((await rows(r.id)).length === 2 && (await rows(r.id)).every((row) => row.stopped_at !== null) ? true : undefined), 20_000, 'files closed');
    expect((await rows(r.id)).map((row) => row.stop_reason)).toEqual(['turned_off', 'turned_off']);
    await eventually(async () => (listenerOf(r.id) === undefined ? true : undefined), 20_000, 'the recorder to leave');
    // an answer is no longer wanted
    expect((await answer(rafi, r.id, 'yes')).status).toBe(409);
    // turning it off again changes nothing
    expect((await setRecording(nadia, r.id, false)).status).toBe(200);
    expect(await rows(r.id)).toHaveLength(2);
    await end(nadia, r.id);
    await cap('off');
  });
});

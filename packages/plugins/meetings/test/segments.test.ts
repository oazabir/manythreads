import { GetMeetingTranscriptResponse, PostMeetingSegmentsResponse, StartMeetingResponse, type MeetingTranscriptLine } from '@manythreads/shared';
import { relaxedRateLimiter, testClient } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';
import { SPEAKER_LINES_PER_MINUTE } from '../src/limits.ts';

// Transcript lines over HTTP (P15-08, P15-14, P15-16): what is stored, what is dropped and why, who may send, the late window, corrections and a voice message in the call thread.

const { nadia, rafi, omar, sameera } = personas;

let w: FilesWorld;
const originalProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];
beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  // many rooms are started in a minute here: the file is not about the start limits
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
const line = (text: string, startMs: number, over: Record<string, unknown> = {}) => ({ clientSegId: `c${++seq}`, startMs, endMs: startMs + 1500, text, final: true, ...over });
const post = (who: Who, room: string, segments: unknown[]): Promise<ApiResult> => w.call(who, 'POST', `/api/meetings/${room}/segments`, { segments });
const stored = (res: ApiResult): ReturnType<typeof PostMeetingSegmentsResponse.parse> => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return PostMeetingSegmentsResponse.parse(res.body);
};
const rows = (room: string) =>
  w.system(async (tx) => (await tx.query<{ id: string; speaker_id: string; text: string; source: string; client_seg_id: string | null; created_at: Date }>('SELECT id, speaker_id, text, source, client_seg_id, created_at FROM app.meeting_segments WHERE meeting_id = $1 ORDER BY start_ms, id', [room])).rows);
const transcript = async (who: Who, room: string): Promise<MeetingTranscriptLine[]> => {
  const res = await w.call(who, 'GET', `/api/meetings/${room}/transcript`);
  expect(res.status).toBe(200);
  return GetMeetingTranscriptResponse.parse(res.body).lines;
};
const channelNo = { current: 0 };
/** A fresh room in a public channel of Engineering with the given people in it and transcription on. */
const openRoom = async (starter: Who, others: Who[], answers: Record<string, 'yes' | 'no' | 'none'>, transcription = true): Promise<string> => {
  const names = ['general', 'dev', 'releases', 'incidents'];
  const channel = await w.channelId('engineering', names[channelNo.current++ % names.length]!);
  // one live room per channel: end any room left from an earlier test
  const live = await w.system(async (tx) => (await tx.query<{ id: string; actor_id: string }>("SELECT m.id, m.started_by AS actor_id FROM app.meetings m WHERE m.channel_id = $1 AND m.state = 'live'", [channel])).rows);
  for (const r of live) {
    const owner = Object.values(personas).find((p) => p.actorId === r.actor_id) ?? starter;
    expect((await w.call(owner, 'POST', `/api/meetings/${r.id}/end`)).status).toBe(200);
  }
  const started = await w.call(starter, 'POST', `/api/channels/${channel}/meetings`, {});
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const id = StartMeetingResponse.parse(started.body).meeting.id;
  for (const p of others) expect((await w.call(p, 'POST', `/api/meetings/${id}/join`)).status).toBe(200);
  if (transcription) expect((await w.call(starter, 'PUT', `/api/meetings/${id}/transcription`, { mode: 'on_device' })).status).toBe(200);
  for (const p of [starter, ...others]) {
    const a = answers[p.name.toLowerCase()] ?? answers[p.actorId] ?? 'none';
    if (a !== 'none') expect((await w.call(p, 'POST', `/api/meetings/${id}/consent`, { transcribe: a })).status).toBe(200);
  }
  return id;
};
const endRoom = async (who: Who, id: string): Promise<void> => {
  expect((await w.call(who, 'POST', `/api/meetings/${id}/end`)).status).toBe(200);
};
/** Moves the end of a room (and the departures that came with it) into the past: the app and the system role cannot, so the owner does, with the guard off for one statement. */
const backdate = async (room: string, seconds: number): Promise<void> => {
  const owner = testClient({ connectionString: w.server.db.ownerUrl });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE app.meetings DISABLE TRIGGER meetings_guard');
    await owner.query('UPDATE app.meetings SET ended_at = now() - make_interval(secs => $2) WHERE id = $1', [room, seconds]);
    await owner.query('ALTER TABLE app.meetings ENABLE TRIGGER meetings_guard');
    await owner.query('UPDATE app.meeting_participants SET left_at = now() - make_interval(secs => $2) WHERE meeting_id = $1', [room, seconds]);
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
};

describe('a speaker who said yes', () => {
  let room = '';
  beforeAll(async () => {
    room = await openRoom(nadia, [rafi], { nadia: 'yes', rafi: 'yes' });
  });

  it('has final lines stored, cleaned of control and direction characters, and readable by the others in the room', async () => {
    const res = stored(await post(nadia, room, [line('he‮llo\u0000 wor\u001bld', 0), line('  second\r\nline  ', 2000)]));
    expect(res).toEqual({ stored: 2, duplicates: 0, captioned: 0, blanked: false });
    expect((await rows(room)).map((r) => r.text)).toEqual(['hello world', 'second line']);
    expect((await rows(room)).every((r) => r.source === 'device' && r.speaker_id === nadia.actorId)).toBe(true);
    expect((await transcript(rafi, room)).map((l) => `${l.speakerName}: ${l.text}`)).toEqual(['Nadia: hello world', 'Nadia: second line']);
  });

  it('stores a line sent twice once (a retry)', async () => {
    const l = line('only once', 5000);
    expect(stored(await post(nadia, room, [l]))).toMatchObject({ stored: 1, duplicates: 0 });
    expect(stored(await post(nadia, room, [l]))).toMatchObject({ stored: 0, duplicates: 1 });
    expect((await rows(room)).filter((r) => r.text === 'only once').length).toBe(1);
  });

  it('drops what a second device heard again (same words, times overlapping by half) and keeps different words or a different time', async () => {
    stored(await post(nadia, room, [line('We should ship on Thursday', 10_000)]));
    // the same words, folded differently, shifted by 400 ms: a repeat
    expect(stored(await post(nadia, room, [line('we should ship on thursday!', 10_400, { clientSegId: 'other-device-1' })]))).toMatchObject({ stored: 0, duplicates: 1 });
    // the same batch holds the repeat too
    const both = stored(await post(nadia, room, [line('Second thing said', 20_000), line('second thing said', 20_300)]));
    expect(both).toMatchObject({ stored: 1, duplicates: 1 });
    // different words at the same time are two lines; the same words much later are another line
    expect(stored(await post(nadia, room, [line('We should ship on Friday', 10_000)]))).toMatchObject({ stored: 1 });
    expect(stored(await post(nadia, room, [line('We should ship on Thursday', 60_000)]))).toMatchObject({ stored: 1 });
  });

  it('never stores a partial line; it is only a caption', async () => {
    const before = (await rows(room)).length;
    const res = stored(await post(nadia, room, [line('typing in prog', 70_000, { final: false }), line('typing in progress', 70_000, { final: false })]));
    expect(res).toEqual({ stored: 0, duplicates: 0, captioned: 2, blanked: false });
    expect((await rows(room)).length).toBe(before);
  });

  it('leaves out a final line with nothing in it after the clean-up', async () => {
    const before = (await rows(room)).length;
    expect(stored(await post(nadia, room, [line('‮\u0000  ', 80_000)]))).toMatchObject({ stored: 0, duplicates: 0 });
    expect((await rows(room)).length).toBe(before);
  });

  it('refuses a line of 40 000 characters with 413 and stores nothing of the batch', async () => {
    const before = (await rows(room)).length;
    const res = await post(nadia, room, [line('fine', 90_000), line('x'.repeat(40_000), 91_000)]);
    expect(res.status).toBe(413);
    expect((await rows(room)).length).toBe(before);
  });

  it('refuses a malformed batch with 400: none, too many, a bad time, a stray field', async () => {
    expect((await post(nadia, room, [])).status).toBe(400);
    expect((await post(nadia, room, Array.from({ length: 21 }, (_, i) => line('x', i * 10)))).status).toBe(400);
    expect((await post(nadia, room, [line('x', 100, { endMs: 50 })])).status).toBe(400);
    expect((await post(nadia, room, [line('x', 5_000_000_000, { endMs: 5_000_000_001 })])).status).toBe(400);
    expect((await post(nadia, room, [{ ...line('x', 100), speakerId: rafi.actorId }])).status).toBe(400);
    expect((await w.call(nadia, 'POST', `/api/meetings/${room}/segments`, { nope: 1 })).status).toBe(400);
  });
});

describe('a speaker who said no, or has not answered', () => {
  let room = '';
  beforeAll(async () => {
    room = await openRoom(nadia, [rafi, omar], { nadia: 'yes', rafi: 'no' });
  });
  it('leaves only the times: the line is stored without its words, and nothing of it is a caption', async () => {
    const res = stored(await post(rafi, room, [line('a secret plan', 0), line('another one', 3000), line('typing', 6000, { final: false })]));
    expect(res).toEqual({ stored: 2, duplicates: 0, captioned: 0, blanked: true });
    expect((await rows(room)).filter((r) => r.speaker_id === rafi.actorId).map((r) => r.text)).toEqual(['', '']);
    const lines = await transcript(nadia, room);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ transcribed: false, text: 'Rafi spoke (not transcribed)' });
    expect(JSON.stringify(await w.system(async (tx) => (await tx.query('SELECT * FROM app.meeting_segments WHERE meeting_id = $1', [room])).rows))).not.toContain('secret');
  });
  it('is the same for somebody who has not been asked', async () => {
    expect(stored(await post(omar, room, [line('nobody asked me', 0)]))).toMatchObject({ stored: 1, blanked: true });
    expect((await rows(room)).filter((r) => r.speaker_id === omar.actorId).map((r) => r.text)).toEqual(['']);
  });
  it('is not changed by answering yes later: the earlier words are gone', async () => {
    expect((await w.call(rafi, 'POST', `/api/meetings/${room}/consent`, { transcribe: 'yes' })).status).toBe(200);
    expect((await rows(room)).filter((r) => r.speaker_id === rafi.actorId).map((r) => r.text)).toEqual(['', '']);
    expect(stored(await post(rafi, room, [line('now I agree', 9000)]))).toMatchObject({ stored: 1, blanked: false });
  });
});

describe('who may send, and when', () => {
  it('refuses a person who is not in the room (403), a stranger (404) and a room with transcription off (409)', async () => {
    const room = await openRoom(nadia, [rafi], { nadia: 'yes' });
    expect((await post(omar, room, [line('hello', 0)])).status).toBe(403);
    expect((await post(sameera, room, [line('hello', 0)])).status).toBe(404);
    expect((await w.call(null, 'POST', `/api/meetings/${room}/segments`, { segments: [line('hello', 0)] })).status).toBe(401);
    const off = await openRoom(nadia, [], { nadia: 'yes' }, false);
    const res = await post(nadia, off, [line('hello', 0)]);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Transcription is not on');
  });

  it('keeps a line that arrives 90 seconds after the room ended, and refuses one at 130 seconds', async () => {
    const room = await openRoom(nadia, [rafi], { nadia: 'yes', rafi: 'yes' });
    stored(await post(nadia, room, [line('before the end', 0)]));
    await endRoom(nadia, room);
    await backdate(room, 90);
    expect(stored(await post(nadia, room, [line('still on its way', 2000)]))).toMatchObject({ stored: 1 });
    expect(stored(await post(rafi, room, [line('mine too', 4000)]))).toMatchObject({ stored: 1 });
    await backdate(room, 130);
    const late = await post(nadia, room, [line('too late', 6000)]);
    expect(late.status).toBe(409);
    expect((await rows(room)).map((r) => r.text)).toEqual(['before the end', 'still on its way', 'mine too']);
  });

  it('counts lines against a share for one person in a minute: 429 with a wait', async () => {
    const room = await openRoom(nadia, [rafi], { nadia: 'yes', rafi: 'yes' });
    for (let i = 0; i < SPEAKER_LINES_PER_MINUTE / 20; i += 1) {
      stored(await post(nadia, room, Array.from({ length: 20 }, (_, j) => line(`line ${i}-${j}`, (i * 20 + j) * 2000))));
    }
    const res = await post(nadia, room, [line('one more', 999_000)]);
    expect(res.status).toBe(429);
    expect(stored(await post(rafi, room, [line('rafi is not limited by nadia', 1000)]))).toMatchObject({ stored: 1 });
  }, 60_000);
});

describe('correcting a line', () => {
  let room = '';
  let mine = '';
  let rafis = '';
  beforeAll(async () => {
    room = await openRoom(nadia, [rafi], { nadia: 'yes', rafi: 'yes' });
    stored(await post(nadia, room, [line('i said thursday', 0)]));
    stored(await post(rafi, room, [line('rafi line', 3000)]));
    const all = await rows(room);
    mine = all.find((r) => r.speaker_id === nadia.actorId)!.id;
    rafis = all.find((r) => r.speaker_id === rafi.actorId)!.id;
  });
  const patch = (who: Who, seg: string, text: string, r = room) => w.call(who, 'PATCH', `/api/meetings/${r}/segments/${seg}`, { text });

  it('lets a speaker change the words of their own line, cleaned, and says the line may be corrected again', async () => {
    const res = await patch(nadia, mine, 'I said ‮Friday\u0000');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ line: { segmentId: mine, text: 'I said Friday', speakerName: 'Nadia', editable: true, transcribed: true } });
    const seen = (await transcript(rafi, room)).find((l) => l.segmentId === mine)!;
    expect(seen.text).toBe('I said Friday');
    expect(seen.editable).toBe(false); // rafi is not the speaker
    expect((await transcript(nadia, room)).find((l) => l.segmentId === mine)!.editable).toBe(true);
  });
  it('refuses somebody else\'s line (404), a line of another room, an empty correction and a stranger', async () => {
    expect((await patch(nadia, rafis, 'not yours')).status).toBe(404);
    expect((await patch(rafi, mine, 'not yours either')).status).toBe(404);
    expect((await patch(nadia, mine, '‮\u0000 ')).status).toBe(400);
    expect((await patch(nadia, mine, '')).status).toBe(400);
    const other = await openRoom(nadia, [], { nadia: 'yes' });
    expect((await patch(nadia, mine, 'wrong room', other)).status).toBe(404);
    expect((await patch(sameera, mine, 'stranger')).status).toBe(404);
    expect((await rows(room)).find((r) => r.id === mine)!.text).toBe('I said Friday');
  });
  it('is closed after 24 hours (409) and for a speaker who no longer says yes', async () => {
    await w.system(async (tx) => void (await tx.query("UPDATE app.meeting_segments SET created_at = now() - interval '25 hours' WHERE id = $1", [mine])));
    expect((await patch(nadia, mine, 'too late now')).status).toBe(409);
    expect((await patch(nadia, mine, 'too late now')).body).toBeTruthy();
    expect((await w.call(rafi, 'POST', `/api/meetings/${room}/consent`, { transcribe: 'no' })).status).toBe(200);
    expect((await patch(rafi, rafis, 'after no')).status).toBe(404);
    expect((await transcript(nadia, room)).find((l) => l.segmentId === mine)!.editable).toBe(false);
  });
  it('queues the transcript to be written again after a correction in an ended room', async () => {
    const r2 = await openRoom(nadia, [], { nadia: 'yes' });
    stored(await post(nadia, r2, [line('first draft', 0)]));
    const seg = (await rows(r2))[0]!.id;
    expect((await patch(nadia, seg, 'second draft', r2)).status).toBe(200);
    const queued = () => w.system(async (tx) => (await tx.query<{ run_at: Date }>("SELECT run_at FROM app.jobs WHERE queue = 'meetings.transcript' AND payload->>'meetingId' = $1", [r2])).rows);
    expect(await queued()).toHaveLength(0); // the room is still on: the file is written when it ends
    await endRoom(nadia, r2);
    expect((await patch(nadia, seg, 'third draft', r2)).status).toBe(200);
    const jobs = await eventually(async () => {
      const q = await queued();
      return q.length >= 2 ? q : undefined;
    });
    // the file for the end of the room, and one correction, not before 30 seconds from now
    expect(jobs.some((j) => j.run_at.getTime() - Date.now() > 25_000)).toBe(true);
  });
});

describe('a voice message in the call thread', () => {
  const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('opus clip bytes')]);
  const threadOf = (room: string) => w.system(async (tx) => (await tx.query<{ thread_root_id: string | null; channel_id: string }>('SELECT thread_root_id, channel_id FROM app.meetings WHERE id = $1', [room])).rows[0]!);
  const voice = async (who: Who, room: string, text: string, transcript: 'device' | 'edited' | 'none' = 'device') => {
    const { thread_root_id, channel_id } = await threadOf(room);
    expect(thread_root_id).toBeTruthy();
    const up = await w.upload(who, channel_id, WEBM, { name: 'voice.webm', type: 'audio/webm;codecs=opus' });
    expect(up.status).toBe(201);
    const fileId = (up.body as { id: string }).id;
    const res = await w.call(who, 'POST', `/api/channels/${channel_id}/messages`, {
      channelId: channel_id,
      body: text,
      threadRootId: thread_root_id,
      attachments: [fileId],
      voice: { fileId, durationMs: 4000, language: 'en', transcript, peaks: [1, 2, 3] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { id: string }).id;
  };
  const voiceLines = (room: string) => w.system(async (tx) => (await tx.query<{ text: string; speaker_id: string; client_seg_id: string }>("SELECT text, speaker_id, client_seg_id FROM app.meeting_segments WHERE meeting_id = $1 AND client_seg_id LIKE 'voice:%'", [room])).rows);

  it('becomes a line of its author when they said yes, once, with the message id as its client id', async () => {
    const room = await openRoom(nadia, [rafi], { nadia: 'yes', rafi: 'no' });
    const id = await voice(nadia, room, 'Voice note about the release ‮ plan');
    const got = await eventually(async () => {
      const l = await voiceLines(room);
      return l.length > 0 ? l : undefined;
    });
    expect(got).toEqual([{ text: 'Voice note about the release plan', speaker_id: nadia.actorId, client_seg_id: `voice:${id}` }]);
    expect((await transcript(rafi, room)).map((l) => l.text)).toEqual(['Voice note about the release plan']);
  });
  it('is not a line when its author said no, has not answered, or sent no transcript; a deleted one is not either', async () => {
    const room = await openRoom(nadia, [rafi, omar], { nadia: 'yes', rafi: 'no' });
    await voice(rafi, room, 'I said no to being written down');
    await voice(omar, room, 'Nobody asked me');
    await voice(nadia, room, 'Voice message (0:04)', 'none');
    // a later voice message of nadia proves the earlier ones were looked at
    await voice(nadia, room, 'the only one that counts');
    const got = await eventually(async () => {
      const l = await voiceLines(room);
      return l.length > 0 ? l : undefined;
    });
    expect(got.map((l) => l.text)).toEqual(['the only one that counts']);
  });
  it('is not a line in a room with transcription off or one that ended more than two minutes ago', async () => {
    const off = await openRoom(nadia, [], { nadia: 'yes' }, false);
    await voice(nadia, off, 'in a room that is not transcribed');
    const old = await openRoom(nadia, [], { nadia: 'yes' });
    await endRoom(nadia, old);
    await backdate(old, 200);
    await voice(nadia, old, 'after the window');
    const marker = await openRoom(nadia, [], { nadia: 'yes' });
    await voice(nadia, marker, 'marker');
    await eventually(async () => ((await voiceLines(marker)).length > 0 ? true : undefined));
    expect(await voiceLines(off)).toEqual([]);
    expect(await voiceLines(old)).toEqual([]);
  });
});

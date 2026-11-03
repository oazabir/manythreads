import {
  GetMeetingTranscriptResponse,
  MeetingConsentResponse,
  MeetingTranscriptionState,
  MeetingsSettings,
  OpenDmResponse,
  StartMeetingResponse,
  type MeetingTranscriptLine,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { lowerCap, readTeamTranscribeCap } from '../src/config.ts';
import { PLACEHOLDER_MERGE_GAP_MS, notTranscribedText, renderTranscript, type SpeakerFacts } from '../src/transcript.ts';

// Consent and the transcription switch (PLAN P15-05): the pure rules (TEAM.md reading, the transcript a reader may see), then the API against the fake media provider:
// who may turn transcription on and off, each person's answer, the two caps (workspace switch and TEAM.md), "spoke (not transcribed)", and the unanswered call that
// becomes "Missed call".

const { omar, nadia, rafi, sameera } = personas;

describe('TEAM.md: the most a room may turn on', () => {
  it('leaves the default (on-device) when the file, the frontmatter or the key is missing', () => {
    expect(readTeamTranscribeCap(null)).toBe('on_device');
    expect(readTeamTranscribeCap('# Team\n\nHello\n')).toBe('on_device');
    expect(readTeamTranscribeCap('---\nname: Engineering\n---\n# Team\n')).toBe('on_device');
    expect(readTeamTranscribeCap('---\nname: Engineering\nmeetings:\n---\n')).toBe('on_device');
    expect(readTeamTranscribeCap('---\nmeetings: {}\n---\n')).toBe('on_device');
    expect(readTeamTranscribeCap('---\n---\nbody')).toBe('on_device');
  });
  it('reads the three choices', () => {
    expect(readTeamTranscribeCap('---\nmeetings:\n  transcribe: on-device\n---\n')).toBe('on_device');
    expect(readTeamTranscribeCap('---\nmeetings:\n  transcribe: server\n---\n')).toBe('server');
    expect(readTeamTranscribeCap('---\r\nmeetings:\r\n  transcribe: off\r\n---\r\nbody')).toBe('off');
  });
  it('reads a key that is there but wrong as off, so a typo never opens what the team meant to keep closed', () => {
    expect(readTeamTranscribeCap('---\nmeetings:\n  transcribe: of\n---\n')).toBe('off');
    expect(readTeamTranscribeCap('---\nmeetings:\n  transcribe: true\n---\n')).toBe('off');
    expect(readTeamTranscribeCap('---\nmeetings: nope\n---\n')).toBe('off');
    expect(readTeamTranscribeCap('---\nmeetings:\n  - transcribe\n---\n')).toBe('off');
    expect(readTeamTranscribeCap('---\nmeetings:\n  transcribe: off\n  extra: 1\n---\n')).toBe('off');
    expect(readTeamTranscribeCap('---\n: : :\n  - [\n---\n')).toBe('off');
    expect(readTeamTranscribeCap('---\njust a string\n---\n')).toBe('off');
  });
  it('takes the lower of two caps', () => {
    expect(lowerCap('server', 'on_device')).toBe('on_device');
    expect(lowerCap('on_device', 'server')).toBe('on_device');
    expect(lowerCap('off', 'server')).toBe('off');
    expect(lowerCap('server', 'server')).toBe('server');
  });
});

describe('the transcript a reader may see', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const speakers = (a: SpeakerFacts['consent'], b: SpeakerFacts['consent']): Map<string, SpeakerFacts> =>
    new Map<string, SpeakerFacts>([
      [A, { displayName: 'Ada', consent: a }],
      [B, { displayName: 'Bo', consent: b }],
    ]);
  const seg = (speakerId: string, startMs: number, endMs: number, text: string, final = true) => ({ speakerId, startMs, endMs, text, final });

  it('shows the words of a yes and only the times of anyone else', () => {
    const lines = renderTranscript([seg(A, 0, 1000, 'hello there'), seg(B, 1200, 2000, 'secret words')], speakers('yes', 'no'));
    expect(lines.map((l) => [l.speakerName, l.text, l.transcribed])).toEqual([
      ['Ada', 'hello there', true],
      ['Bo', notTranscribedText('Bo'), false],
    ]);
    expect(JSON.stringify(lines)).not.toContain('secret');
  });
  it('judges by the answer NOW: words stored before a no are not shown, and an unanswered person is hidden too', () => {
    const stored = [seg(A, 0, 1000, 'said before answering'), seg(B, 1000, 2000, 'also stored')];
    expect(renderTranscript(stored, speakers('no', 'unasked')).every((l) => !l.transcribed)).toBe(true);
    expect(renderTranscript(stored, speakers('yes', 'yes')).map((l) => l.text)).toEqual(['said before answering', 'also stored']);
  });
  it('joins stretches of a silent speaker that are close together, and keeps far ones apart', () => {
    const lines = renderTranscript([seg(B, 0, 1000, ''), seg(B, 1000 + PLACEHOLDER_MERGE_GAP_MS, 8000, ''), seg(B, 8000 + PLACEHOLDER_MERGE_GAP_MS + 1, 20_000, '')], speakers('yes', 'no'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ startMs: 0, endMs: 8000 });
  });
  it('does not merge across another speaker, drops empty lines of a yes and lines that are not final', () => {
    const lines = renderTranscript([seg(B, 0, 500, ''), seg(A, 600, 900, 'hi'), seg(B, 1000, 1500, ''), seg(A, 1600, 1700, '   '), seg(A, 1800, 1900, 'partial', false)], speakers('yes', 'no'));
    expect(lines.map((l) => l.speakerName)).toEqual(['Bo', 'Ada', 'Bo']);
  });
  it('is the same whatever order the rows came in', () => {
    const rows = [seg(A, 2000, 3000, 'two'), seg(A, 0, 1000, 'one')];
    expect(renderTranscript(rows, speakers('yes', 'yes')).map((l) => l.text)).toEqual(['one', 'two']);
  });
});

let w: World;
const originalProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld();
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
  if (originalProvider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = originalProvider;
});

const start = (who: typeof omar, channelId: string) => w.call(who, 'POST', `/api/channels/${channelId}/meetings`, {});
const room = async (who: typeof omar, channelId: string): Promise<string> => {
  const res = await start(who, channelId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return StartMeetingResponse.parse(res.body).meeting.id;
};
const join = (who: typeof omar, id: string) => w.call(who, 'POST', `/api/meetings/${id}/join`);
const end = (who: typeof omar, id: string) => w.call(who, 'POST', `/api/meetings/${id}/end`);
const transcribe = (who: typeof omar, id: string, mode: string) => w.call(who, 'PUT', `/api/meetings/${id}/transcription`, { mode });
const consent = (who: typeof omar, id: string, answer: string) => w.call(who, 'POST', `/api/meetings/${id}/consent`, { transcribe: answer });
const state = async (who: typeof omar, id: string) => MeetingTranscriptionState.parse((await w.call(who, 'GET', `/api/meetings/${id}/transcription`)).body);
const transcript = async (who: typeof omar, id: string): Promise<MeetingTranscriptLine[]> => GetMeetingTranscriptResponse.parse((await w.call(who, 'GET', `/api/meetings/${id}/transcript`)).body).lines;
const answers = (id: string) =>
  w.system(async (tx) => (await tx.query<{ actor_id: string; consent_transcribe: string }>('SELECT actor_id, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1', [id])).rows);
const events = (type: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));
const putSegment = (id: string, speaker: typeof omar, ms: number, text: string) =>
  // the system role stands in for the speaker's device here; the database trigger that blanks the words of a non-yes speaker is covered in the RLS test
  w.system(async (tx) => void (await tx.query("INSERT INTO app.meeting_segments (meeting_id, speaker_id, start_ms, end_ms, text, source) VALUES ($1, $2, $3, $4, $5, 'device')", [id, speaker.actorId, ms, ms + 800, text])));
const writeTeamMd = async (content: string): Promise<void> => {
  const res = await w.call(omar, 'POST', '/api/teams/engineering/proposals', { path: 'TEAM.md', content, applyNow: true });
  // writing the file as it already is changes nothing, and is fine
  if (res.status === 400 && JSON.stringify(res.body).includes('does not change the file')) return;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};
const setCap = (cap: string) => w.call(omar, 'PUT', '/api/workspace/meetings-settings', { transcribeCap: cap });

describe('turning transcription on and off', () => {
  let id = '';
  it('is off in a new room, and anyone present may turn it on; everyone is then asked again', async () => {
    id = await room(nadia, await w.channelId('engineering', 'general'));
    await join(rafi, id);
    const before = await state(rafi, id);
    expect(before, JSON.stringify(before)).toMatchObject({ mode: 'off', turnedOnBy: null, allowed: ['on_device'], reason: null });
    // rafi has already said yes to an earlier question
    expect((await consent(rafi, id, 'yes')).status).toBe(200);
    const res = await transcribe(rafi, id, 'on_device');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(MeetingTranscriptionState.parse(res.body)).toMatchObject({ mode: 'on_device', turnedOnBy: { actorId: rafi.actorId } });
    expect((await answers(id)).every((a) => a.consent_transcribe === 'unasked')).toBe(true);
    expect((await events('meetings.consent.changed')).some((p) => p['meetingId'] === id && p['subject'] === 'room_transcription' && p['value'] === 'yes')).toBe(true);
  });
  it('is refused for somebody who is not in the room (404 for a stranger, 403 for a member who has not joined)', async () => {
    expect((await transcribe(sameera, id, 'off')).status).toBe(404);
    expect((await transcribe(omar, id, 'off')).status).toBe(403);
  });
  it('cannot change how it works while it is on: off first', async () => {
    expect((await transcribe(rafi, id, 'server')).status).toBe(403); // the workspace default allows only the device
    expect((await setCap('server')).status).toBe(200);
    expect((await transcribe(rafi, id, 'server')).status).toBe(403); // ...and so does the team's file, until it says otherwise
    await writeTeamMd('---\nmeetings:\n  transcribe: server\n---\n# Team\n');
    const res = await transcribe(rafi, id, 'server');
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('turn transcription off');
    await setCap('on_device');
    await writeTeamMd('# Team\n\nNo settings.\n');
  });
  it('is turned off by the person who turned it on, the starter or a lead, and not by anybody else in the room', async () => {
    await join(omar, id); // omar leads the team
    expect((await transcribe(nadia, id, 'off')).status).toBe(200); // the starter
    expect((await state(nadia, id)).mode).toBe('off');
    expect((await transcribe(rafi, id, 'on_device')).status).toBe(200);
    expect((await transcribe(rafi, id, 'off')).status).toBe(200); // the person who turned it on
    expect((await transcribe(rafi, id, 'on_device')).status).toBe(200);
    expect((await transcribe(omar, id, 'off')).status).toBe(200); // a lead
    expect((await transcribe(nadia, id, 'on_device')).status).toBe(200);
    expect((await transcribe(rafi, id, 'off')).status).toBe(403); // rafi neither turned it on nor started the room nor leads the team
    expect((await state(rafi, id)).mode).toBe('on_device');
    expect((await transcribe(nadia, id, 'off')).status).toBe(200);
  });
  it('is not changed twice: asking for what the room already has says so and writes no second event', async () => {
    const before = (await events('meetings.consent.changed')).filter((p) => p['meetingId'] === id).length;
    const again = await transcribe(nadia, id, 'off');
    expect(again.status).toBe(200);
    expect((await events('meetings.consent.changed')).filter((p) => p['meetingId'] === id).length).toBe(before);
  });
  it('ends with the room: nothing can be changed afterwards', async () => {
    await end(omar, id);
    expect((await transcribe(nadia, id, 'on_device')).status).toBe(409);
    expect((await consent(nadia, id, 'yes')).status).toBe(409);
  });
});

describe('each person answers for themself', () => {
  let id = '';
  beforeAll(async () => {
    await setCap('on_device');
    id = await room(nadia, await w.channelId('engineering', 'incidents'));
    await join(rafi, id);
    await transcribe(nadia, id, 'on_device');
  });
  it('stores yes and no for the caller only, and says which', async () => {
    const yes = await consent(nadia, id, 'yes');
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    expect(MeetingConsentResponse.parse(yes.body).participant).toMatchObject({ actorId: nadia.actorId, consentTranscribe: 'yes' });
    await consent(rafi, id, 'no');
    const rows = Object.fromEntries((await answers(id)).map((a) => [a.actor_id, a.consent_transcribe]));
    expect(rows).toEqual({ [nadia.actorId]: 'yes', [rafi.actorId]: 'no' });
    const written = (await events('meetings.consent.changed')).filter((p) => p['meetingId'] === id && p['subject'] === 'transcribe');
    expect(written.map((p) => [p['actorId'], p['value']])).toEqual([
      [nadia.actorId, 'yes'],
      [rafi.actorId, 'no'],
    ]);
  });
  it('refuses "unasked", nonsense, a person who is not in the room and a stranger', async () => {
    expect((await consent(nadia, id, 'unasked')).status).toBe(400);
    expect((await consent(nadia, id, 'maybe')).status).toBe(400);
    expect((await consent(omar, id, 'yes')).status).toBe(403);
    expect((await consent(sameera, id, 'yes')).status).toBe(404);
  });
  it('shows words only for a yes: a no appears as "spoke (not transcribed)" even though words were stored first', async () => {
    await putSegment(id, nadia, 0, 'we should ship on friday');
    await putSegment(id, rafi, 1000, 'secret things about the customer');
    const lines = await transcript(omar, id);
    expect(lines.map((l) => [l.speakerName, l.transcribed, l.text])).toEqual([
      [expect.any(String), true, 'we should ship on friday'],
      [expect.any(String), false, expect.stringMatching(/ spoke \(not transcribed\)$/)],
    ]);
    expect(JSON.stringify(lines)).not.toContain('customer');
  });
  it('blanks the stored words of a person who answers no after speaking, and a late yes shows the later words only', async () => {
    await consent(nadia, id, 'no');
    const stored = await w.system(async (tx) => (await tx.query<{ speaker_id: string; text: string }>('SELECT speaker_id, text FROM app.meeting_segments WHERE meeting_id = $1', [id])).rows);
    expect(stored.find((s) => s.speaker_id === nadia.actorId)?.text).toBe('');
    expect((await transcript(rafi, id)).every((l) => !l.transcribed)).toBe(true);
    await consent(nadia, id, 'yes');
    await putSegment(id, nadia, 5000, 'back on the record');
    const lines = await transcript(rafi, id);
    expect(lines.filter((l) => l.transcribed).map((l) => l.text)).toEqual(['back on the record']);
  });
  it('hides the transcript from people who cannot read the room', async () => {
    expect((await w.call(sameera, 'GET', `/api/meetings/${id}/transcript`)).status).toBe(404);
    expect((await w.call(sameera, 'GET', `/api/meetings/${id}/transcription`)).status).toBe(404);
  });
  afterAll(async () => void (await end(omar, id)));
});

describe('the caps: the workspace switch and the team TEAM.md, the lower wins', () => {
  it('reads and writes the workspace switch; only an admin writes it; the default is the device', async () => {
    await w.system(async (tx) => void (await tx.query('DELETE FROM app.meeting_settings')));
    expect(MeetingsSettings.parse((await w.call(nadia, 'GET', '/api/workspace/meetings-settings')).body)).toEqual({ transcribeCap: 'on_device' });
    expect((await w.call(nadia, 'PUT', '/api/workspace/meetings-settings', { transcribeCap: 'server' })).status).toBe(403);
    expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { transcribeCap: 'sideways' })).status).toBe(400);
    expect(MeetingsSettings.parse((await setCap('server')).body)).toEqual({ transcribeCap: 'server' });
    expect(MeetingsSettings.parse((await w.call(nadia, 'GET', '/api/workspace/meetings-settings')).body)).toEqual({ transcribeCap: 'server' });
    expect(MeetingsSettings.parse((await setCap('off')).body)).toEqual({ transcribeCap: 'off' });
    await setCap('on_device');
  });
  it('workspace off forbids turning transcription on, in words that name who closed it; a running room can still turn it off', async () => {
    const id = await room(nadia, await w.channelId('engineering', 'releases'));
    await transcribe(nadia, id, 'on_device');
    await setCap('off');
    expect((await state(nadia, id)).allowed).toEqual([]);
    const off = await transcribe(nadia, id, 'off');
    expect(off.status).toBe(200);
    const refused = await transcribe(nadia, id, 'on_device');
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('switched off for this workspace');
    expect(await state(nadia, id)).toMatchObject({ mode: 'off', allowed: [] });
    await setCap('on_device');
    await end(omar, id);
  });
  it('TEAM.md off closes it for that team only, and a typo reads as off', async () => {
    await writeTeamMd('---\nmeetings:\n  transcribe: off\n---\n# Team\n');
    const id = await room(nadia, await w.channelId('engineering', 'general'));
    const refused = await transcribe(nadia, id, 'on_device');
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('switched off for this team');
    await writeTeamMd('---\nmeetings:\n  transcribe: sever\n---\n# Team\n');
    expect((await transcribe(nadia, id, 'on_device')).status).toBe(403);
    await writeTeamMd('---\nmeetings:\n  transcribe: on-device\n---\n# Team\n');
    expect((await transcribe(nadia, id, 'on_device')).status).toBe(200);
    await end(omar, id);
  });
  it('server needs both caps: the workspace allowing it is not enough when TEAM.md says on-device, and TEAM.md allowing it is not enough when the workspace says on_device', async () => {
    const id = await room(nadia, await w.channelId('engineering', 'general'));
    await setCap('server');
    await writeTeamMd('---\nmeetings:\n  transcribe: on-device\n---\n# Team\n');
    expect((await state(nadia, id)).allowed).toEqual(['on_device']);
    await writeTeamMd('---\nmeetings:\n  transcribe: server\n---\n# Team\n');
    expect((await state(nadia, id)).allowed).toEqual(['on_device', 'server']);
    await setCap('on_device');
    expect((await state(nadia, id)).allowed).toEqual(['on_device']);
    expect((await transcribe(nadia, id, 'server')).status).toBe(403);
    await writeTeamMd('# Team\n\nNo settings.\n');
    await end(omar, id);
  });
  it('a direct-message call has no team: only the workspace switch applies', async () => {
    const dm = OpenDmResponse.parse((await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] })).body).dm.channel.id;
    const id = await room(nadia, dm);
    expect((await state(nadia, id)).allowed).toEqual(['on_device']);
    expect((await transcribe(nadia, id, 'on_device')).status).toBe(200);
    await end(nadia, id);
  });
});

describe('a call in a direct message rings, and an unanswered one becomes "Missed call"', () => {
  const runRingEnd = async (): Promise<void> => {
    await w.system(async (tx) => void (await tx.query("UPDATE app.jobs SET run_at = now() WHERE queue = 'meetings.ringend' AND state = 'ready'")));
  };
  const threadBodies = (rootId: string) =>
    w.system(async (tx) => (await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE thread_root_id = $1 ORDER BY id', [rootId])).rows.map((r) => r.body));

  it('writes "Missed call" in the call thread once when nobody else came in', async () => {
    const dm = OpenDmResponse.parse((await w.call(nadia, 'POST', '/api/dms', { personIds: [sameera.personId] })).body).dm.channel.id;
    const res = StartMeetingResponse.parse((await start(nadia, dm)).body);
    expect(res.created).toBe(true);
    const queued = await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.jobs WHERE queue = 'meetings.ringend' AND payload->>'meetingId' = $1", [res.meeting.id])).rows.length);
    expect(queued).toBe(1);
    await runRingEnd();
    const bodies = await eventually(async () => {
      const b = await threadBodies(res.meeting.threadRootId!);
      return b.includes('Missed call') ? b : undefined;
    }, 20_000, 'the missed call message');
    expect(bodies.filter((b) => b === 'Missed call')).toHaveLength(1);
    await end(nadia, res.meeting.id);
  });
  it('writes nothing when the other person came into the room, and rings nobody in a channel', async () => {
    const dm = OpenDmResponse.parse((await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] })).body).dm.channel.id;
    const res = StartMeetingResponse.parse((await start(nadia, dm)).body);
    expect((await join(rafi, res.meeting.id)).status).toBe(200);
    await runRingEnd();
    await new Promise((r) => setTimeout(r, 2500));
    expect(await threadBodies(res.meeting.threadRootId!)).not.toContain('Missed call');
    await end(nadia, res.meeting.id);

    const general = await w.channelId('engineering', 'general');
    const created = StartMeetingResponse.parse((await start(rafi, general)).body);
    const rings = await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.jobs WHERE queue = 'meetings.ringend' AND payload->>'meetingId' = $1", [created.meeting.id])).rows.length);
    expect(rings).toBe(0);
    await end(omar, created.meeting.id);
  });
});

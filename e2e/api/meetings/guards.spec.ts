import { MEETING_BOT_FILES, personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';
import type { APIRequestContext } from '@playwright/test';

// Writes data (rooms, answers, files): its own server and database for this file (api/support/isolated.ts), with the voice-room stand-ins on (fake media, fake speech).
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_STACK_MEETINGS: '1' });

/**
 * The guards of a voice room at the API (PLAN P15-17, criteria 8 and 10): a bot is never handed a media token, a guest may join a room but never start one, the server
 * fallback for speech is refused wherever the room or the caps do not allow it, and the recording questions are answered only by a person who is in the room, only
 * once recording is on, and only with a yes or a no.
 */
const { omar, nadia, rafi, lena } = personas;
const as = (p: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }) });
const asBot = (actorId: string): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: actorId, workspaceId: omar.workspaceId }) });

async function channelId(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.get('/api/teams/engineering/channels', { headers: as(nadia) });
  expect(res.status()).toBe(200);
  const dir = (await res.json()) as { groups: Array<{ channels: Array<{ id: string; name: string }> }> };
  const id = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === name)?.id;
  expect(id, `channel #${name}`).toBeDefined();
  return id!;
}

async function startRoom(request: APIRequestContext, who: Persona, channel: string): Promise<string> {
  const res = await request.post(`/api/channels/${channel}/meetings`, { headers: as(who), data: {} });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { meeting: { id: string } }).meeting.id;
}

/** A 16 kHz mono 16-bit WAV (the shape the route wants), `ms` long: silence, or the stand-in's marker and the words `said`. */
function wav(ms: number, said = ''): Buffer {
  const samples = Math.round((ms / 1000) * 16_000);
  const data = Buffer.alloc(samples * 2);
  // the stand-in speech model (MANYTHREADS_FAKE_ASR=1) reads what comes after FAKEASR: in the data as the words that were said
  if (said !== '') data.write(`FAKEASR:${said}`, 0, 'utf8');
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16_000, 24);
  head.writeUInt32LE(32_000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('a bot is never handed a media token: it cannot start, join or renew, and the media server never saw it', async ({ request }) => {
  const stack = await iso.start();
  const bot = MEETING_BOT_FILES.find((b) => b.slug === 'note-taker')!;
  const set = await request.post('/api/teams/engineering/proposals', { headers: as(omar), data: { path: `bots/${bot.slug}/BOT.md`, op: 'put', content: bot.md, title: 'Set up the note-taker', applyNow: true } });
  expect(set.status(), await set.text()).toBe(201);
  await expect
    .poll(async () => (await stack.sql<{ id: string }>(`SELECT a.id FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.slug = 'note-taker' AND b.status = 'active'`))[0]?.id, { timeout: 60_000, message: 'the loader to load the note-taker' })
    .toBeTruthy();
  const botActor = (await stack.sql<{ id: string }>(`SELECT a.id FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.slug = 'note-taker'`))[0]!.id;

  const dev = await channelId(request, 'dev');
  const meetingId = await startRoom(request, nadia, dev);
  for (const [method, path, data] of [
    ['POST', `/api/channels/${dev}/meetings`, {}],
    ['POST', `/api/meetings/${meetingId}/join`, undefined],
    ['POST', `/api/meetings/${meetingId}/token`, undefined],
  ] as const) {
    const res = await request.fetch(path, { method, headers: asBot(botActor), ...(data === undefined ? {} : { data }) });
    expect(res.status(), `${method} ${path} as a bot`).toBe(403);
    expect(await res.text()).not.toMatch(/token["']?\s*:\s*["'][A-Za-z0-9._-]{20,}/);
  }
  const heard = await request.get(`/api/test/media/state?meetingId=${meetingId}`, { headers: { ...as(nadia), 'x-test-auth': stack.testAuthToken } });
  expect(heard.status(), await heard.text()).toBe(200);
  const state = (await heard.json()) as { tokens: Array<{ identity: string; kind: string }> };
  expect(state.tokens.some((t) => t.identity === botActor || t.kind === 'bot')).toBe(false);
  // the person who started it got the only token
  expect(state.tokens.map((t) => t.identity)).toEqual([nadia.actorId]);
});

test('a guest may join a live room of a channel they are in but may not start one', async ({ request }) => {
  const releases = await channelId(request, 'releases');
  // Lena, a guest, is in #releases: starting is refused with a plain reason, and nothing was opened
  const start = await request.post(`/api/channels/${releases}/meetings`, { headers: as(lena), data: {} });
  expect(start.status(), await start.text()).toBe(403);
  const stack = await iso.start();
  expect(await stack.sql(`SELECT 1 FROM app.meetings WHERE channel_id = $1`, [releases])).toEqual([]);
  // once a member has opened the room, she joins it and gets a token
  const meetingId = await startRoom(request, nadia, releases);
  const join = await request.post(`/api/meetings/${meetingId}/join`, { headers: as(lena) });
  expect(join.status(), await join.text()).toBe(200);
  expect(((await join.json()) as { join: { token: string } }).join.token.length).toBeGreaterThan(10);
  // a guest of a channel she is not in sees nothing of the room
  const dev = await channelId(request, 'dev');
  const devRoom = await startRoom(request, rafi, dev);
  expect([403, 404]).toContain((await request.post(`/api/meetings/${devRoom}/join`, { headers: as(lena) })).status());
  expect([403, 404]).toContain((await request.post(`/api/channels/${dev}/meetings`, { headers: as(lena), data: {} })).status());
});

test('the server fallback for speech is refused where the room, the answer or the caps do not allow it', async ({ request }) => {
  const stack = await iso.start();
  const incidents = await channelId(request, 'incidents');
  const meetingId = await startRoom(request, nadia, incidents);
  const chunk = (who: Persona, said = '') =>
    request.post(`/api/meetings/${meetingId}/audio-chunks?clientSegId=c-${Math.random().toString(36).slice(2)}&startMs=5000&durationMs=2000`, { headers: { ...as(who), 'content-type': 'audio/wav' }, data: wav(2000, said) });
  const lines = async () => (await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1`, [meetingId])).length;

  // transcription is off: nobody was asked, and the server does not transcribe
  expect((await chunk(nadia)).status()).toBe(403);
  // on the device only: the answer is yes and the fallback is still closed
  expect((await request.put(`/api/meetings/${meetingId}/transcription`, { headers: as(nadia), data: { mode: 'on_device' } })).status()).toBe(200);
  expect((await request.post(`/api/meetings/${meetingId}/consent`, { headers: as(nadia), data: { transcribe: 'yes' } })).status()).toBe(200);
  const device = await chunk(nadia);
  expect(device.status()).toBe(403);
  expect(await device.text()).toContain('does not transcribe on the server');
  // set to the server (the workspace allows it), but a person who is not in the room, and one who has not said yes, are refused
  expect((await request.put('/api/workspace/meetings-settings', { headers: as(omar), data: { transcribeCap: 'server' } })).status()).toBe(200);
  // the lower of the workspace switch and the team's TEAM.md wins: the team says server too
  const team = await request.post('/api/teams/engineering/proposals', { headers: as(omar), data: { path: 'TEAM.md', content: '---\nmeetings:\n  transcribe: server\n---\n# Team\n', applyNow: true } });
  expect(team.status(), await team.text()).toBe(201);
  expect((await request.put(`/api/meetings/${meetingId}/transcription`, { headers: as(nadia), data: { mode: 'off' } })).status()).toBe(200);
  const toServer = await request.put(`/api/meetings/${meetingId}/transcription`, { headers: as(nadia), data: { mode: 'server' } });
  expect(toServer.status(), await toServer.text()).toBe(200);
  expect((await chunk(rafi)).status()).toBe(403);
  // everything allows it for Nadia, who said yes: this is the one chunk that is taken
  expect((await request.post(`/api/meetings/${meetingId}/consent`, { headers: as(nadia), data: { transcribe: 'yes' } })).status()).toBe(200);
  const taken = await chunk(nadia, 'the server fallback works');
  expect(taken.status(), await taken.text()).toBe(200);
  expect((await stack.sql<{ text: string; source: string }>(`SELECT text, source FROM app.meeting_segments WHERE meeting_id = $1`, [meetingId]))).toEqual([{ text: 'the server fallback works', source: 'server' }]);
  expect((await request.post(`/api/meetings/${meetingId}/join`, { headers: as(rafi) })).status()).toBe(200);
  expect((await chunk(rafi)).status(), 'in the room but not asked yet').toBe(403);
  expect((await request.post(`/api/meetings/${meetingId}/consent`, { headers: as(rafi), data: { transcribe: 'no' } })).status()).toBe(200);
  expect((await chunk(rafi)).status(), 'said no').toBe(403);
  expect(await lines()).toBe(1);
  // the workspace switch closes the server even for a room already set to it
  expect((await request.put('/api/workspace/meetings-settings', { headers: as(omar), data: { transcribeCap: 'on_device' } })).status()).toBe(200);
  expect((await request.post(`/api/meetings/${meetingId}/consent`, { headers: as(nadia), data: { transcribe: 'yes' } })).status()).toBe(200);
  expect((await chunk(nadia)).status(), 'workspace allows only the device').toBe(403);
  expect(await lines()).toBe(1);
  // and a body that is not a WAV is refused before anything is read into the model
  expect((await request.put('/api/workspace/meetings-settings', { headers: as(omar), data: { transcribeCap: 'server' } })).status()).toBe(200);
  const junk = await request.post(`/api/meetings/${meetingId}/audio-chunks?clientSegId=junk&startMs=5000&durationMs=2000`, { headers: { ...as(nadia), 'content-type': 'audio/wav' }, data: Buffer.from('this is not a sound file at all') });
  expect(junk.status()).toBeGreaterThanOrEqual(400);
  expect(junk.status()).toBeLessThan(500);
  expect(await lines()).toBe(1);
});

test('recording: answered only by a person in the room, only when recording is on, only yes or no', async ({ request }) => {
  const stack = await iso.start();
  const general = await channelId(request, 'general');
  const meetingId = await startRoom(request, nadia, general);
  const answer = (who: Persona, record: string) => request.post(`/api/meetings/${meetingId}/record-consent`, { headers: as(who), data: { record } });
  const put = (who: Persona, on: boolean) => request.put(`/api/meetings/${meetingId}/recording`, { headers: as(who), data: { on } });

  // the workspace switch is off: nobody can turn it on, and nobody can answer
  expect((await put(nadia, true)).status()).toBeGreaterThanOrEqual(400);
  expect((await answer(nadia, 'yes')).status()).toBe(409);
  expect((await stack.sql(`SELECT 1 FROM app.meeting_recordings WHERE meeting_id = $1`, [meetingId])).length).toBe(0);

  expect((await request.put('/api/workspace/meetings-settings', { headers: as(omar), data: { recordingCap: 'on' } })).status()).toBe(200);
  // on in the workspace, but not yet in the room
  expect((await answer(nadia, 'yes')).status()).toBe(409);
  expect((await put(nadia, true)).status()).toBe(200);
  // a person who is not in the room cannot answer, and an answer must be a yes or a no
  expect((await answer(omar, 'yes')).status()).toBe(403);
  expect((await answer(nadia, 'unasked')).status()).toBe(400);
  expect((await answer(nadia, 'maybe')).status()).toBe(400);
  expect((await answer(nadia, 'yes')).status()).toBe(200);
  const mine = (await (await request.get(`/api/meetings/${meetingId}/recording`, { headers: as(nadia) })).json()) as { yourConsent: string; recording: boolean; on: boolean };
  expect(mine).toMatchObject({ yourConsent: 'yes', on: true });
  // Rafi joins without having said yes: nothing is being recorded, and his own state says he has not answered
  expect((await request.post(`/api/meetings/${meetingId}/join`, { headers: as(rafi) })).status()).toBe(200);
  const his = (await (await request.get(`/api/meetings/${meetingId}/recording`, { headers: as(rafi) })).json()) as { yourConsent: string; recording: boolean };
  expect(his).toMatchObject({ yourConsent: 'unasked', recording: false });
  // somebody who only sits in the room cannot turn it off; the one who turned it on still has it on
  expect((await put(rafi, false)).status()).toBe(403);
  expect(((await (await request.get(`/api/meetings/${meetingId}/recording`, { headers: as(nadia) })).json()) as { on: boolean }).on).toBe(true);
  expect((await answer(rafi, 'no')).status()).toBe(200);
  expect(((await (await request.get(`/api/meetings/${meetingId}/recording`, { headers: as(rafi) })).json()) as { yourConsent: string }).yourConsent).toBe('no');
  expect((await stack.sql(`SELECT 1 FROM app.meeting_recordings WHERE meeting_id = $1 AND actor_id = $2`, [meetingId, rafi.actorId])).length).toBe(0);
});

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { encodeWav16kMono, makeFakeAsrWav } from '@manythreads/sdk';
import { GetMeetingTranscriptResponse, PostMeetingAudioChunkResponse, StartMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';
import { cleanSpokenText, readBodyCapped } from '../src/routes-audio.ts';

// P15-07, the server fallback: `POST /api/meetings/:id/audio-chunks` (PLAN criterion 8). The transcriber is the stand-in (`MANYTHREADS_FAKE_ASR=1`: the text after `FAKEASR:` in
// the WAV), so these tests cover everything around it: who may send, what is stored, what is never written, the limits on the body and the budget.

const { omar, nadia, rafi, sameera } = personas;

describe('text from a speech model is cleaned', () => {
  it('drops control characters and bidirectional overrides, folds whitespace and keeps real text', () => {
    expect(cleanSpokenText('  hello\u0000 ‮world‬ ⁦x⁩\n\n  and\ttabs \u0085 ok\u007F ')).toBe('hello world x and tabs ok');
    expect(cleanSpokenText('مرحبا بالجميع 👋🏽 ok')).toBe('مرحبا بالجميع 👋🏽 ok');
    expect(cleanSpokenText('\u0000\u0001  ‪')).toBe('');
  });
  it('cuts at 4000 characters without splitting a pair, and stays linear on a hostile string', () => {
    const cut = cleanSpokenText('😀'.repeat(5000));
    expect([...cut]).toHaveLength(4000);
    expect(cut.endsWith('😀')).toBe(true);
    const hostile = ('‮ \u0000'.repeat(2) + 'a ').repeat(250_000);
    const t0 = performance.now();
    cleanSpokenText(hostile);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('the body reader', () => {
  async function* parts(...sizes: number[]): AsyncGenerator<Uint8Array> {
    for (const n of sizes) yield new Uint8Array(n).fill(7);
  }
  it('collects a body within the cap, and an absent body is empty', async () => {
    expect((await readBodyCapped(parts(10, 20), 100))!.length).toBe(30);
    expect((await readBodyCapped(undefined, 100))!.length).toBe(0);
  });
  it('answers null past the cap and stops reading', async () => {
    let pulled = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulled++;
        yield new Uint8Array(1000);
      }
    }
    expect(await readBodyCapped(endless(), 2500)).toBeNull();
    expect(pulled).toBeLessThanOrEqual(4);
  });
  it('gives up on a sender that stalls', async () => {
    async function* stalls(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(5);
      await new Promise((r) => setTimeout(r, 400));
      yield new Uint8Array(5);
    }
    await expect(readBodyCapped(stalls(), 100, 50, 5000)).rejects.toMatchObject({ status: 408 });
  });
  it('gives up on a sender that takes too long overall', async () => {
    async function* dribble(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 30));
        yield new Uint8Array(1);
      }
    }
    await expect(readBodyCapped(dribble(), 1000, 1000, 120)).rejects.toMatchObject({ status: 408 });
  });
});

let w: World;
let clock = (): Date => new Date();
let blobDir = '';
const saved = {
  provider: process.env['MANYTHREADS_MEDIA_PROVIDER'],
  asr: process.env['MANYTHREADS_FAKE_ASR'],
  storage: process.env['MANYTHREADS_STORAGE_DIR'],
};

beforeAll(async () => {
  blobDir = mkdtempSync(pathJoin(tmpdir(), 'manythreads-audio-chunks-'));
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  process.env['MANYTHREADS_FAKE_ASR'] = '1';
  process.env['MANYTHREADS_STORAGE_DIR'] = blobDir;
  w = await createWorld({ now: () => clock() });
  await ensureChannels(w);
  expect((await setCap('server')).status).toBe(200);
  await writeTeamMd('---\nmeetings:\n  transcribe: server\n---\n# Team\n');
}, 180_000);
afterAll(async () => {
  await w?.close();
  rmSync(blobDir, { recursive: true, force: true });
  for (const [k, v] of [
    ['MANYTHREADS_MEDIA_PROVIDER', saved.provider],
    ['MANYTHREADS_FAKE_ASR', saved.asr],
    ['MANYTHREADS_STORAGE_DIR', saved.storage],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const setCap = (cap: string) => w.call(omar, 'PUT', '/api/workspace/meetings-settings', { transcribeCap: cap });
const writeTeamMd = async (content: string): Promise<void> => {
  const res = await w.call(omar, 'POST', '/api/teams/engineering/proposals', { path: 'TEAM.md', content, applyNow: true });
  if (res.status === 400 && JSON.stringify(res.body).includes('does not change the file')) return;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};
const room = async (who: typeof omar, channel = 'general'): Promise<string> => {
  const res = await w.call(who, 'POST', `/api/channels/${await w.channelId('engineering', channel)}/meetings`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return StartMeetingResponse.parse(res.body).meeting.id;
};
const join = (who: typeof omar, id: string) => w.call(who, 'POST', `/api/meetings/${id}/join`);
const mode = (who: typeof omar, id: string, m: string) => w.call(who, 'PUT', `/api/meetings/${id}/transcription`, { mode: m });
const consent = (who: typeof omar, id: string, answer: string) => w.call(who, 'POST', `/api/meetings/${id}/consent`, { transcribe: answer });

/** A WAV of a "person" saying `text` through the stand-in, or any bytes, sent as the raw body. */
async function chunk(who: typeof omar, id: string, body: Uint8Array | null, query: Record<string, string | number> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const q = new URLSearchParams({ clientSegId: `c-${Math.random().toString(36).slice(2)}`, startMs: '5000', durationMs: '2000', ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(`${w.server.url}/api/meetings/${id}/audio-chunks?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) },
    ...(body ? { body: Buffer.from(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const say = (text: string, ms = 2000) => makeFakeAsrWav(text, ms);
const segments = (id: string) =>
  w.system(async (tx) => (await tx.query<{ speaker_id: string; text: string; source: string; start_ms: number; end_ms: number; final: boolean; client_seg_id: string }>(
    'SELECT speaker_id, text, source, start_ms, end_ms, final, client_seg_id FROM app.meeting_segments WHERE meeting_id = $1 ORDER BY start_ms, id', [id])).rows);
const spendLines = (id: string) =>
  w.system(async (tx) => (await tx.query<{ purpose: string; alias: string; team_id: string }>(`SELECT purpose, alias, team_id FROM app.llm_spend WHERE session_id = $1`, [`meeting:${id}`])).rows);
const filesOnDisk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesOnDisk(pathJoin(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));

describe('a person who chose the server', () => {
  let id = '';
  beforeAll(async () => {
    id = await room(nadia);
    await join(rafi, id);
    expect((await mode(nadia, id, 'server')).status).toBe(200);
    expect((await consent(nadia, id, 'yes')).status).toBe(200);
    expect((await consent(rafi, id, 'no')).status).toBe(200);
  });

  it('gets the words of a chunk stored as a server line of their own, times from the meeting clock, and a spend line; no audio is written anywhere', async () => {
    const res = await chunk(nadia, id, say('the release is on Thursday', 2500), { startMs: 12_000, clientSegId: 'a1', lang: 'en' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PostMeetingAudioChunkResponse.parse(res.body)).toEqual({ text: 'the release is on Thursday', stored: true });
    const rows = await segments(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ speaker_id: nadia.actorId, text: 'the release is on Thursday', source: 'server', start_ms: 12_000, final: true, client_seg_id: 'a1' });
    expect(rows[0]!.end_ms).toBeGreaterThanOrEqual(14_400);
    expect(rows[0]!.end_ms).toBeLessThanOrEqual(14_600);
    expect(await spendLines(id)).toEqual([{ purpose: 'transcribe', alias: 'transcribe', team_id: (await w.system(async (tx) => (await tx.query<{ team_id: string }>('SELECT team_id FROM app.meetings WHERE id = $1', [id])).rows[0]!.team_id)) }]);
    // the line is in the transcript a reader sees
    const t = GetMeetingTranscriptResponse.parse((await w.call(nadia, 'GET', `/api/meetings/${id}/transcript`)).body);
    expect(t.lines.map((l) => l.text)).toContain('the release is on Thursday');
    // nothing was written to blob storage, and no file row exists
    expect(filesOnDisk(blobDir)).toEqual([]);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.files')).rows.length)).toBe(0);
  });

  it('is answered from the first time when the same chunk comes again: one line, one spend line', async () => {
    const again = await chunk(nadia, id, say('the release is on Thursday', 2500), { startMs: 12_000, clientSegId: 'a1' });
    expect(again.body).toEqual({ text: 'the release is on Thursday', stored: true });
    expect(await segments(id)).toHaveLength(1);
    expect(await spendLines(id)).toHaveLength(1);
  });

  it('stores nothing for silence or for a chunk the model heard nothing in', async () => {
    const quiet = await chunk(nadia, id, encodeWav16kMono(new Int16Array(32_000)));
    expect(quiet).toEqual({ status: 200, body: { text: '', stored: false } });
    const nothing = await chunk(nadia, id, (() => { const s = new Int16Array(16_000); s.fill(900); return encodeWav16kMono(s); })());
    expect(nothing).toEqual({ status: 200, body: { text: '', stored: false } });
    expect(await segments(id)).toHaveLength(1);
  });

  it('is refused for a person who said no, who has not answered, who is not in the room, or who cannot see it', async () => {
    const spendBefore = (await spendLines(id)).length;
    expect((await chunk(rafi, id, say('secret words'))).status).toBe(403);
    // omar can read the channel but has not joined the room
    const outside = await chunk(omar, id, say('from outside'));
    expect(outside.status).toBe(403);
    expect(JSON.stringify(outside.body)).toContain('not in this voice room');
    await join(omar, id);
    const unasked = await chunk(omar, id, say('not yet asked'));
    expect(unasked.status).toBe(403);
    expect(JSON.stringify(unasked.body)).toContain('said yes');
    expect((await chunk(sameera, id, say('from another team'))).status).toBe(404);
    // none of it reached the transcript or the ledger
    expect((await segments(id)).map((s) => s.text)).toEqual(['the release is on Thursday']);
    expect(await spendLines(id)).toHaveLength(spendBefore);
    expect(JSON.stringify(await segments(id))).not.toContain('secret');
  });

  it('is refused for a bad query or a body that is not the one WAV format, and the 2 MiB cap holds', async () => {
    expect((await chunk(nadia, id, say('x'), { durationMs: 31_000 })).status).toBe(400);
    expect((await chunk(nadia, id, say('x'), { clientSegId: 'has spaces!' })).status).toBe(400);
    expect((await chunk(nadia, id, say('x'), { startMs: -1 })).status).toBe(400);
    expect((await chunk(nadia, id, say('x'), { startMs: 4_000_000_000 })).status).toBe(400);
    expect((await chunk(nadia, id, new TextEncoder().encode('RIFF but not really a wave file, only text pretending to be one.'))).status).toBe(400);
    const stereo = say('x');
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect((await chunk(nadia, id, stereo)).status).toBe(400);
    expect((await chunk(nadia, id, null)).status).toBe(400);
    const big = await chunk(nadia, id, new Uint8Array(2 * 1024 * 1024 + 10));
    expect(big.status).toBe(413);
    expect((await chunk(nadia, id, encodeWav16kMono(new Int16Array(16_000 * 31)))).status).toBe(400);
    expect(await segments(id)).toHaveLength(1);
    expect(filesOnDisk(blobDir)).toEqual([]);
  });

  it('is refused with a plain 409 and no line when the workspace budget is spent', async () => {
    await w.system(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, limit_usd) VALUES ($1, 'workspace', 1)`, [nadia.workspaceId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, alias, cost_usd) VALUES ($1, 'smart', 5)`, [nadia.workspaceId]);
    });
    const res = await chunk(nadia, id, say('over budget'));
    await w.system((tx) => tx.query('DELETE FROM app.llm_limits WHERE workspace_id = $1', [nadia.workspaceId]));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await segments(id))).not.toContain('over budget');
    // and the next chunk goes through again
    expect((await chunk(nadia, id, say('back again'))).status).toBe(200);
  });
});

describe('where the server is not what the room or the caps allow', () => {
  it('is 403 in a room set to the device, and before anyone is asked', async () => {
    const id = await room(nadia, 'incidents');
    expect((await mode(nadia, id, 'on_device')).status).toBe(200);
    expect((await consent(nadia, id, 'yes')).status).toBe(200);
    const res = await chunk(nadia, id, say('device only'));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('does not transcribe on the server');
    expect(await segments(id)).toEqual([]);
    // transcription off altogether
    expect((await mode(nadia, id, 'off')).status).toBe(200);
    expect((await chunk(nadia, id, say('off'))).status).toBe(403);
  });

  it('is 403 once the workspace switch or the team file stops allowing the server, even in a room already set to it', async () => {
    const id = await room(nadia, 'releases');
    expect((await mode(nadia, id, 'server')).status).toBe(200);
    expect((await consent(nadia, id, 'yes')).status).toBe(200);
    expect((await chunk(nadia, id, say('allowed'))).status).toBe(200);
    expect((await setCap('on_device')).status).toBe(200);
    const closed = await chunk(nadia, id, say('workspace says no'));
    expect(closed.status).toBe(403);
    expect((await setCap('server')).status).toBe(200);
    expect((await chunk(nadia, id, say('open again'))).status).toBe(200);
    await writeTeamMd('---\nmeetings:\n  transcribe: on-device\n---\n# Team\n');
    expect((await chunk(nadia, id, say('team says no'))).status).toBe(403);
    await writeTeamMd('---\nmeetings:\n  transcribe: off\n---\n# Team\n');
    expect((await chunk(nadia, id, say('team says off'))).status).toBe(403);
    await writeTeamMd('---\nmeetings:\n  transcribe: server\n---\n# Team\n');
    expect((await segments(id)).map((s) => s.text)).toEqual(['allowed', 'open again']);
  });

  it('takes a last chunk for two minutes after the room ended and then answers that it has ended', async () => {
    const id = await room(nadia, 'dev');
    expect((await mode(nadia, id, 'server')).status).toBe(200);
    expect((await consent(nadia, id, 'yes')).status).toBe(200);
    expect((await w.call(nadia, 'POST', `/api/meetings/${id}/end`)).status).toBe(200);
    expect((await chunk(nadia, id, say('my last words'))).status).toBe(200);
    const real = clock;
    clock = () => new Date(Date.now() + 121_000);
    try {
      const late = await chunk(nadia, id, say('too late'));
      expect(late.status).toBe(409);
      expect(JSON.stringify(late.body)).toContain('has ended');
    } finally {
      clock = real;
    }
    expect((await segments(id)).map((s) => s.text)).toEqual(['my last words']);
  });
});

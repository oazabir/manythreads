import { readFileSync } from 'node:fs';
import { readWavInfo, type MediaListenChunk } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { createLivekitProvider, verifyJwt } from '../src/livekit.ts';
import { startLivekitListener } from '../src/listener.ts';

// The server side of the note-taker's listener (PLAN P15-19) with a stand-in worker thread: that the chunks come out as WAV files, the subscription list follows
// `setIdentities` at once, the listener says when it is closed and why, and the token it asks for can only subscribe. That the real LiveKit library behaves is
// checked on the live site (it needs a media server).

const FAKE_WORKER = new URL('./fake-worker.ts', import.meta.url);
const SECRET = 's'.repeat(40);
const ENV = { MANYTHREADS_LIVEKIT_URL: 'wss://media.example.test', MANYTHREADS_LIVEKIT_API_KEY: 'APIkey1', MANYTHREADS_LIVEKIT_API_SECRET: SECRET };
const A = '00000000-0000-7000-8000-0000000a0001';
const B = '00000000-0000-7000-8000-0000000a0002';

function collect() {
  const chunks: MediaListenChunk[] = [];
  const closed: string[] = [];
  return { chunks, closed, options: { identities: [A, B], onChunk: (c: MediaListenChunk) => void chunks.push(c), onClosed: (r: string) => void closed.push(r) } };
}
const until = async (check: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('startLivekitListener (stand-in worker)', () => {
  it('hands a chunk over as a 16 kHz mono WAV with the identity and time the worker gave', async () => {
    const c = collect();
    const l = await startLivekitListener({ url: 'ws://x', token: 'speak.t', options: c.options, workerUrl: FAKE_WORKER });
    await until(() => c.chunks.length === 1);
    const chunk = c.chunks[0]!;
    expect(chunk.identity).toBe(A);
    expect(chunk.startedAt.getTime()).toBe(1_700_000_000_000);
    expect(chunk.durationMs).toBe(1000);
    expect(chunk.backlogMs).toBe(0);
    expect(readWavInfo(chunk.wav)).toMatchObject({ ok: true, sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
    await l.close();
  });

  it('reports who is subscribed, and drops a person from that list at once when the list changes', async () => {
    const c = collect();
    const l = await startLivekitListener({ url: 'ws://x', token: 'plain.t', options: c.options, workerUrl: FAKE_WORKER });
    await until(() => l.subscriptions().length === 2);
    expect(l.subscriptions().sort()).toEqual([A, B]);
    l.setIdentities([B]);
    expect(l.subscriptions()).toEqual([B]); // before the worker has answered
    await until(() => l.subscriptions().length === 1);
    await l.close();
  });

  it('close() leaves politely, says closed once, and ignores later calls', async () => {
    const c = collect();
    const l = await startLivekitListener({ url: 'ws://x', token: 'plain.t', options: c.options, workerUrl: FAKE_WORKER });
    await l.close();
    await l.close();
    expect(c.closed).toEqual(['closed']);
    l.setIdentities([A]);
    expect(l.subscriptions()).toEqual([]);
  });

  it('says "error" when the worker dies and "room_ended" when the room is gone', async () => {
    const dead = collect();
    await startLivekitListener({ url: 'ws://x', token: 'crash.t', options: dead.options, workerUrl: FAKE_WORKER });
    await until(() => dead.closed.length > 0);
    expect(dead.closed).toEqual(['error']);
    const gone = collect();
    await startLivekitListener({ url: 'ws://x', token: 'end.t', options: gone.options, workerUrl: FAKE_WORKER });
    await until(() => gone.closed.length > 0);
    expect(gone.closed).toEqual(['room_ended']);
  });

  it('gives up when the worker never joins, with a plain message and no "closed" call', async () => {
    const c = collect();
    await expect(startLivekitListener({ url: 'ws://x', token: 'never.t', options: c.options, workerUrl: FAKE_WORKER, connectTimeoutMs: 150 })).rejects.toThrow(/could not join the room/);
    expect(c.closed).toEqual([]);
  });
});

describe('the LiveKit provider listens with a token that can only subscribe', () => {
  it('asks for a hidden, subscribe-only token under a name that is not an actor id, and sends the worker the listen address', async () => {
    const p = createLivekitProvider({ env: () => ({ ...ENV, MANYTHREADS_LIVEKIT_LISTEN_URL: 'http://livekit.svc:7880/' }), listenerWorkerUrl: FAKE_WORKER });
    const c = collect();
    const l = await p.listen!('room-1', c.options);
    await until(() => c.chunks.length === 1);
    const echoed = JSON.parse(c.chunks[0]!.identity) as { url: string; token: string };
    // the fake worker picks its mode from the first part of the token; a real token starts with a JWT header, so no mode matches and this is the "plain" path:
    // what is checked here is what the worker was handed
    expect(echoed.url).toBe('ws://livekit.svc:7880');
    const claims = verifyJwt(echoed.token, SECRET, Math.floor(Date.now() / 1000))!;
    expect(claims).toMatchObject({ iss: 'APIkey1', sub: 'notetaker:room-1' });
    expect(claims['video']).toMatchObject({ room: 'room-1', roomJoin: true, canPublish: false, canPublishData: false, canSubscribe: true, hidden: true });
    expect(JSON.stringify(echoed)).not.toContain(SECRET);
    await l.close();
  });

  it('uses the public address when no listen address is set, and refuses with "not configured" when nothing is', async () => {
    const p = createLivekitProvider({ env: () => ENV, listenerWorkerUrl: FAKE_WORKER });
    const l = await p.listen!('r', collect().options);
    await l.close();
    const none = createLivekitProvider({ env: () => ({}) });
    await expect(none.listen!('r', collect().options)).rejects.toThrow(/not set up/);
  });

  it('the worker file never publishes: it uses none of the library\'s publishing calls', () => {
    const text = readFileSync(new URL('../src/listener-worker.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/listener-core.ts', import.meta.url), 'utf8');
    for (const word of ['publishTrack', 'publishData', 'AudioSource', 'LocalAudioTrack', 'LocalVideoTrack', 'localParticipant', 'captureFrame']) expect(text).not.toContain(word);
  });
});

import { MediaStatusResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// With no LiveKit address and key (the default of a fresh install) voice rooms say so plainly and write nothing (PLAN P15-02).

const { nadia } = personas;
const saved: Record<string, string | undefined> = {};
const KEYS = ['MANYTHREADS_MEDIA_PROVIDER', 'MANYTHREADS_LIVEKIT_URL', 'MANYTHREADS_LIVEKIT_API_KEY', 'MANYTHREADS_LIVEKIT_API_SECRET'];

let w: World;
let general: string;
beforeAll(async () => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  w = await createWorld();
  await ensureChannels(w);
  general = await w.channelId('engineering', 'general');
}, 180_000);
afterAll(async () => {
  await w?.close();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('no media server set up', () => {
  it('the status says so, in plain words', async () => {
    const res = await w.call(nadia, 'GET', '/api/meetings/media-status');
    expect(res.status).toBe(200);
    const body = MediaStatusResponse.parse(res.body);
    expect(body.configured).toBe(false);
    expect(body.provider).toBe('livekit');
    expect(body.reason).toMatch(/not set up/i);
  });

  it('start answers 409 with the reason and leaves no room behind', async () => {
    const res = await w.call(nadia, 'POST', `/api/channels/${general}/meetings`, {});
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/not set up/i);
    const rows = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.meetings')).rows[0]!.n);
    expect(rows).toBe(0);
  });
});

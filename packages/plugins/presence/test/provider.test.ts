import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPresenceProvider } from '../src/provider.ts';
import { createWorld, personas, type World } from './world.ts';

const { nadia, omar } = personas;

// P14-09: the `presence` provider tells other plugins (the email digest) when a person last sent a heartbeat, so they never read `app.presence` themselves.

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('the presence provider', () => {
  it('says when each person last sent a heartbeat, and says nothing about someone who never did', async () => {
    const before = Date.now();
    expect((await w.call(nadia, 'POST', '/api/presence', {})).status).toBe(200);
    const seen = await w.system((tx) => createPresenceProvider().lastSeen(tx, [nadia.personId, omar.personId]));
    expect([...seen.keys()]).toEqual([nadia.personId]);
    const at = seen.get(nadia.personId)!;
    expect(at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('answers an empty question without asking the database', async () => {
    expect((await w.system((tx) => createPresenceProvider().lastSeen(tx, []))).size).toBe(0);
  });

  it('is the provider other plugins find under the name "presence"', () => {
    expect(createPresenceProvider().id).toBe('presence');
  });
});

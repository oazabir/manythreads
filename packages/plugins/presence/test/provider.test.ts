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

  it('lists the people of one workspace seen after a time, and nobody else', async () => {
    expect((await w.call(nadia, 'POST', '/api/presence', {})).status).toBe(200);
    const provider = createPresenceProvider();
    const recent = await w.system((tx) => provider.seenSince(tx, new Date(Date.now() - 60_000), nadia.workspaceId));
    expect([...recent.keys()]).toContain(nadia.personId);
    expect(recent.has(omar.personId)).toBe(false);
    expect((await w.system((tx) => provider.seenSince(tx, new Date(Date.now() + 60_000), nadia.workspaceId))).size).toBe(0);
    expect((await w.system((tx) => provider.seenSince(tx, new Date(0), '01a0fb83-ada6-7efa-8bc6-50dade5f5784'))).size).toBe(0);
  });

  it('says when the heartbeat data started, keeps the answer, and starts again when the table was emptied (a crash)', async () => {
    const provider = createPresenceProvider();
    const first = await w.system((tx) => provider.warmSince(tx));
    expect(Math.abs(first.getTime() - Date.now())).toBeLessThan(120_000);
    expect((await w.system((tx) => provider.warmSince(tx))).getTime()).toBe(first.getTime());
    await w.system((tx) => tx.query('DELETE FROM app.presence_epoch'));
    const second = await w.system((tx) => provider.warmSince(tx));
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    expect((await w.system((tx) => provider.warmSince(tx))).getTime()).toBe(second.getTime());
  });

  it('is the provider other plugins find under the name "presence"', () => {
    expect(createPresenceProvider().id).toBe('presence');
  });
});

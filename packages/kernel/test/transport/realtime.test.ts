import { randomUUID } from 'node:crypto';
import { NADIA, PRIYA, RAFI } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REALTIME_MAX_BYTES, createRealtime, publishRealtime, type Realtime } from '../../src/transport/realtime.ts';
import { createReadStateService, type UnreadCounters } from '../../src/read-state/index.ts';
import type { Tx } from '../../src/index.ts';
import { createWorld, type World } from '../rls/world.ts';

// Live push: sockets by person, NOTIFY on commit only, read-state changes reach the person's sockets.

let w: World;
let rt: Realtime;
const counters: UnreadCounters = new Map();
const svc = createReadStateService({ counters, plugin: 'test' });
const tx = (t: Tx) => t as never;

const peer = () => {
  const frames: Array<{ type: string; id: string; payload: Record<string, unknown> }> = [];
  return { frames, send: (d: string) => void frames.push(JSON.parse(d) as never) };
};
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  w = await createWorld();
  rt = createRealtime();
  await rt.start(w.appPool);
  counters.set('channel', { plugin: 'test', counter: () => Promise.resolve(0) });
}, 120_000);
afterAll(async () => {
  await rt?.stop();
  await w?.close();
}, 60_000);

describe('registry', () => {
  it('delivers to every socket of a person and to no one else; detach forgets a socket', () => {
    const local = createRealtime();
    const [a1, a2, b] = [peer(), peer(), peer()];
    const off1 = local.attach('p-a', a1);
    local.attach('p-a', a2);
    local.attach('p-b', b);
    expect(local.connections()).toBe(3);
    expect(local.deliver({ workspaceId: 'w', personId: 'p-a', type: 'x.y.z', payload: { n: 1 } })).toBe(2);
    expect(a1.frames).toHaveLength(1);
    expect(a1.frames[0]).toMatchObject({ type: 'x.y.z', payload: { n: 1 } });
    expect(typeof a1.frames[0]?.id).toBe('string');
    expect(b.frames).toHaveLength(0);
    off1();
    expect(local.connections('p-a')).toBe(1);
    expect(local.deliver({ workspaceId: 'w', personId: 'p-a', type: 'x.y.z', payload: {} })).toBe(1);
    expect(local.deliver({ workspaceId: 'w', personId: 'nobody', type: 'x.y.z', payload: {} })).toBe(0);
  });

  it('a socket that throws does not stop the others', () => {
    const local = createRealtime();
    const good = peer();
    local.attach('p', { send: () => { throw new Error('closing'); } });
    local.attach('p', good);
    expect(local.deliver({ workspaceId: 'w', personId: 'p', type: 'x.y.z', payload: {} })).toBe(1);
  });
});

describe('push through Postgres', () => {
  it('arrives after commit, not before, and never when the transaction rolls back', async () => {
    const p = peer();
    const off = rt.attach(NADIA.personId, p);
    let midway = -1;
    await w.as(RAFI, async (t) => {
      await publishRealtime(t, [{ workspaceId: NADIA.workspaceId, personId: NADIA.personId, type: 'test.ping.sent', payload: { n: 1 } }]);
      await settle();
      midway = p.frames.length;
    });
    await settle();
    expect(midway).toBe(0);
    expect(p.frames).toHaveLength(1);
    await w.as(RAFI, async (t) => {
      await publishRealtime(t, [{ workspaceId: NADIA.workspaceId, personId: NADIA.personId, type: 'test.ping.sent', payload: { n: 2 } }]);
      throw new Error('abort');
    }).catch(() => undefined);
    await settle();
    expect(p.frames).toHaveLength(1);
    off();
  });

  it('refuses a payload that would not fit in a NOTIFY', async () => {
    await expect(
      w.as(RAFI, (t) => publishRealtime(t, [{ workspaceId: NADIA.workspaceId, personId: NADIA.personId, type: 'test.big.sent', payload: { blob: 'x'.repeat(REALTIME_MAX_BYTES) } }])),
    ).rejects.toThrow(RangeError);
  });

  it('read-state changes reach the sockets of that person only', async () => {
    const [nadia, priya] = [peer(), peer()];
    const offs = [rt.attach(NADIA.personId, nadia), rt.attach(PRIYA.personId, priya)];
    const ch = randomUUID();
    const m1 = await w.as(RAFI, async (t) => {
      const id = (await t.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';
      await svc.onPosted(tx(t), { targetType: 'channel', targetId: ch, messageId: id, authorId: RAFI.actorId, recipientPersonIds: [NADIA.personId] });
      return id;
    });
    await settle();
    expect(nadia.frames).toHaveLength(1);
    expect(nadia.frames[0]).toMatchObject({ type: 'reading.state.changed', payload: { targetType: 'channel', targetId: ch, unreadCount: 1, reason: 'posted', lastReadId: null } });
    expect(priya.frames).toHaveLength(0);
    await w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m1));
    await settle();
    expect(nadia.frames).toHaveLength(2);
    expect(nadia.frames[1]).toMatchObject({ payload: { unreadCount: 0, lastReadId: m1, reason: 'read' } });
    for (const off of offs) off();
  });
});

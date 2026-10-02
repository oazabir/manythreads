import { randomUUID } from 'node:crypto';
import { ReadingStateChangedEvent, parseEvent, upcast } from '@manythreads/shared';
import { NADIA, OMAR, PRIYA, RAFI, captureEvents, KAHF_WORKSPACE_ID } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventToRaw, type Tx } from '../../src/index.ts';
import { createReadStateService, type UnreadCounters } from '../../src/read-state/index.ts';
import { createWorld, type World } from '../rls/world.ts';

// P3-03 event contract: `reading.state.changed` is registered, versioned, written in the caller's transaction and only when something changed.

let w: World;
const counters: UnreadCounters = new Map();
const svc = createReadStateService({ counters, plugin: 'test' });
const tx = (t: Tx) => t as never;
const channel = () => ({ targetType: 'channel' as const, targetId: randomUUID() });

beforeAll(async () => {
  w = await createWorld();
  counters.set('channel', { plugin: 'test', counter: () => Promise.resolve(0) });
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const newId = async (t: Tx) => (await t.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';
const events = (fn: () => Promise<unknown>) => captureEvents('reading.state.changed', fn, { pool: w.sysPool });

describe('reading.state.changed', () => {
  it('a post emits one event for all recipients, valid against the registry, as the poster, in the workspace', async () => {
    const target = channel();
    const [ev] = await events(() =>
      w.as(RAFI, async (t) => svc.onPosted(tx(t), { ...target, messageId: await newId(t), authorId: RAFI.actorId, recipientPersonIds: [NADIA, PRIYA, RAFI].map((p) => p.personId) })),
    );
    expect(ev).toBeDefined();
    expect(ev?.actorId).toBe(RAFI.actorId);
    expect(ev?.teamId ?? null).toBeNull();
    const parsed = ReadingStateChangedEvent.parse(parseEvent(eventToRaw({ type: ev?.type ?? '', schema_version: ev?.schemaVersion ?? 0, workspace_id: KAHF_WORKSPACE_ID, payload: ev?.payload ?? {} })));
    expect(parsed).toMatchObject({ type: 'reading.state.changed', schemaVersion: 1, workspaceId: KAHF_WORKSPACE_ID, ...target, reason: 'posted' });
    expect(parsed.changes.map((c) => c.personId).sort()).toEqual([NADIA, PRIYA].map((p) => p.personId).sort());
    expect(parsed.changes.every((c) => c.unreadCount === 1 && c.lastReadId === null && !c.followed)).toBe(true);
    expect(upcast(parsed)).toEqual(parsed);
  });

  it('only workspace admins can read it back from the event log (no team on the event)', async () => {
    const target = channel();
    await w.as(RAFI, async (t) => svc.onPosted(tx(t), { ...target, messageId: await newId(t), authorId: RAFI.actorId, recipientPersonIds: [NADIA.personId] }));
    const read = (p: typeof NADIA) => w.as(p, (t) => t.query(`SELECT 1 FROM events WHERE type = 'reading.state.changed' AND payload->>'targetId' = $1`, [target.targetId]));
    expect((await read(OMAR)).rows).toHaveLength(1);
    expect((await read(NADIA)).rows).toHaveLength(0);
  });

  it('mark-read emits `read` once, and nothing when the position did not move', async () => {
    const target = channel();
    const m1 = await w.as(RAFI, async (t) => {
      const id = await newId(t);
      await svc.onPosted(tx(t), { ...target, messageId: id, authorId: RAFI.actorId, recipientPersonIds: [NADIA.personId] });
      return id;
    });
    const first = await events(() => w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, target, m1)));
    expect(first).toHaveLength(1);
    expect(first[0]?.payload).toMatchObject({ reason: 'read', targetId: target.targetId, changes: [{ personId: NADIA.personId, lastReadId: m1, unreadCount: 0, followed: false }] });
    const older = await events(() => w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, target, '00000000-0000-7000-8000-000000000001')));
    expect(older).toHaveLength(0);
    const same = await events(() => w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, target, m1)));
    expect(same).toHaveLength(0); // same position, same count: nothing changed
  });

  it('follow emits `followed` only when the flag changes', async () => {
    const target = channel();
    const on = await events(() => w.as(PRIYA, (t) => svc.setFollowed(tx(t), PRIYA.personId, target, true)));
    expect(on.map((e) => e.payload['reason'])).toEqual(['followed']);
    const again = await events(() => w.as(PRIYA, (t) => svc.setFollowed(tx(t), PRIYA.personId, target, true)));
    expect(again).toHaveLength(0);
  });

  it('a rolled-back change leaves no event', async () => {
    const target = channel();
    const got = await events(async () => {
      await w
        .as(RAFI, async (t) => {
          await svc.onPosted(tx(t), { ...target, messageId: await newId(t), authorId: RAFI.actorId, recipientPersonIds: [NADIA.personId] });
          throw new Error('abort');
        })
        .catch(() => undefined);
    });
    expect(got).toHaveLength(0);
    expect((await w.system((t) => t.query('SELECT 1 FROM read_state WHERE target_id = $1', [target.targetId]))).rows).toEqual([]);
  });

  it('rejects a malformed payload (the registry is the contract)', () => {
    const ok = { type: 'reading.state.changed', schemaVersion: 1, workspaceId: KAHF_WORKSPACE_ID, targetType: 'channel', targetId: randomUUID(), reason: 'read', changes: [{ personId: NADIA.personId, lastReadId: null, unreadCount: 0, followed: false }] };
    expect(parseEvent(ok)).toEqual(ok);
    expect(() => parseEvent({ ...ok, targetType: 'dm' })).toThrow();
    expect(() => parseEvent({ ...ok, reason: 'deleted' })).toThrow();
    expect(() => parseEvent({ ...ok, changes: [] })).toThrow();
    expect(() => parseEvent({ ...ok, changes: [{ ...ok.changes[0], unreadCount: -1 }] })).toThrow();
  });
});

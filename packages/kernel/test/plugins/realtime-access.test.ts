import { randomUUID } from 'node:crypto';
import { definePlugin, type PluginTx } from '@manythreads/sdk';
import { LENA, OMAR, PRIYA, SAMEERA, TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExtensionRegistries, createMemoryKv, createPluginContext } from '../../src/plugins/index.ts';
import { createRealtime, type Realtime } from '../../src/transport/realtime.ts';
import { createWorld, type World } from '../rls/world.ts';

// P4-00: ctx.access (typed wrappers over the visibility functions) and ctx.realtime.pushToPeople / pushMany (one statement per fan-out).

const { manifest } = definePlugin({ manifest: { name: 'plain', version: '0.1.0', kind: 'server' }, register: () => undefined });
const ctx = createPluginContext(manifest, {
  registries: new ExtensionRegistries(),
  storage: createMemoryKv(),
  mail: { send: () => Promise.resolve() },
  runtime: { publicUrl: 'http://x', now: () => new Date() },
});
const sorted = (xs: readonly string[]) => [...xs].sort();

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

describe('ctx.access', () => {
  const teams = (p: Parameters<World['as']>[0], perm: 'read' | 'post' | 'manage') => w.as(p, (tx) => ctx.access.readableTeamIds(tx as unknown as PluginTx, perm));

  it('readableTeamIds is app.readable_team_ids for the transaction actor: members, admins, guests, permission ranks', async () => {
    expect(sorted(await teams(PRIYA, 'read'))).toEqual(sorted([TEAM_IDS.Engineering, TEAM_IDS.Marketing]));
    expect(await teams(SAMEERA, 'post')).toEqual([TEAM_IDS['Customer support']]);
    expect(await teams(SAMEERA, 'manage')).toEqual([]);
    expect(sorted(await teams(OMAR, 'read'))).toEqual(sorted(Object.values(TEAM_IDS)));
    expect(await teams(LENA, 'read')).toEqual([]);
  });

  it('is empty for the system actor and for a permission nobody defined', async () => {
    expect(await w.system((tx) => ctx.access.readableTeamIds(tx as unknown as PluginTx, 'read'))).toEqual([]);
    expect(await w.as(OMAR, (tx) => ctx.access.readableTeamIds(tx as unknown as PluginTx, 'nope' as never))).toEqual([]);
  });
});

describe('ctx.realtime.pushToPeople', () => {
  /** A transaction that only counts statements (what the fan-out costs in round trips). */
  const counting = () => {
    const statements: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    const tx = {
      actor: { kind: 'person', id: randomUUID(), workspaceId: randomUUID() },
      query: (text: string, values?: readonly unknown[]) => {
        statements.push({ text, values });
        return Promise.resolve({ rows: [] });
      },
    } as PluginTx;
    return { tx, statements };
  };

  it('a 2,000-member audience is ONE publish statement, with one payload per distinct person', async () => {
    const { tx, statements } = counting();
    const people = Array.from({ length: 2_000 }, () => randomUUID());
    await ctx.realtime.pushToPeople(tx, [...people, people[0] as string], 'message.posted', { channelId: 'c', messageId: 'm' });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toContain('pg_notify');
    const payloads = (statements[0]?.values?.[1] ?? []) as string[];
    expect(payloads).toHaveLength(2_000);
    expect(JSON.parse(payloads[0] as string)).toMatchObject({ workspaceId: tx.actor.workspaceId, personId: people[0], type: 'message.posted' });
  });

  it('an empty audience issues nothing; pushMany carries a payload per person in one statement', async () => {
    const { tx, statements } = counting();
    await ctx.realtime.pushToPeople(tx, [], 'x.y.z', {});
    await ctx.realtime.pushMany(tx, []);
    expect(statements).toHaveLength(0);
    await ctx.realtime.pushMany(tx, [
      { personId: 'p1', type: 'x.y.z', payload: { n: 1 } },
      { personId: 'p2', type: 'x.y.z', payload: { n: 2 } },
    ]);
    expect(statements).toHaveLength(1);
    expect(((statements[0]?.values?.[1] ?? []) as string[]).map((p) => JSON.parse(p).payload.n)).toEqual([1, 2]);
  });

  describe('through Postgres', () => {
    let rt: Realtime;
    beforeAll(async () => {
      rt = createRealtime();
      await rt.start(w.appPool);
    });
    afterAll(async () => {
      await rt?.stop();
    });

    it('every person in the audience gets the frame after commit, nobody else', async () => {
      const got = new Map<string, number>();
      const offs = [OMAR, PRIYA, LENA].map((p) => rt.attach(p.personId, { send: () => void got.set(p.key, (got.get(p.key) ?? 0) + 1) }));
      await w.as(OMAR, (tx) => ctx.realtime.pushToPeople(tx as unknown as PluginTx, [OMAR.personId, PRIYA.personId], 'test.ping.sent', { n: 1 }));
      await new Promise((r) => setTimeout(r, 200));
      expect([...got.entries()].sort()).toEqual([['omar', 1], ['priya', 1]]);
      for (const off of offs) off();
    });
  });
});

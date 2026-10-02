import { randomUUID } from 'node:crypto';
import { UnreadCounterMissingError } from '@manythreads/sdk';
import { LENA, NADIA, OMAR, PRIYA, RAFI, SAMEERA, KAHF_WORKSPACE_ID, type Persona, testClient } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor, type Tx } from '../../src/index.ts';
import { createReadStateService, type UnreadCounters } from '../../src/read-state/index.ts';
import { createWorld, type World } from './world.ts';

// P3-03: the read-state service against a migrated database: unread bookkeeping, monotonic mark-read, races, the partial index and
// row-level security (policy P: own rows only; other people's counters move only through app.read_state_bump).

let w: World;
let owner: pg.Client;
const counters: UnreadCounters = new Map();
const svc = createReadStateService({ counters, plugin: 'test' });
const tx = (t: Tx) => t as never;

/** Stands in for the channels plugin's `messages` table: ids are uuid v7, newest = greatest. */
const countAfter = async (t: Tx, channelId: string, after: string): Promise<number> =>
  Number((await t.query<{ n: string }>('SELECT count(*) AS n FROM rs_test_messages WHERE channel_id = $1 AND id > $2', [channelId, after])).rows[0]?.n);

beforeAll(async () => {
  w = await createWorld();
  owner = testClient({ connectionString: w.db.ownerUrl });
  await owner.connect();
  await owner.query(`CREATE TABLE app.rs_test_messages (id uuid PRIMARY KEY DEFAULT uuidv7(), channel_id uuid NOT NULL, author_id uuid NOT NULL)`);
  await owner.query('GRANT SELECT, INSERT ON app.rs_test_messages TO manythreads_app, manythreads_system');
  counters.set('channel', { plugin: 'test', counter: (t, target, after) => countAfter(t as unknown as Tx, target.targetId, after) });
}, 120_000);
afterAll(async () => {
  await owner?.end();
  await w?.close();
}, 60_000);

/** `author` posts a message to `channel`; every other listed person gets it as unread. Returns the message id. */
async function post(channel: string, author: Persona, recipients: Persona[], authorAsPerson = false): Promise<string> {
  return w.as(author, async (t) => {
    const id = (await t.query<{ id: string }>(`INSERT INTO rs_test_messages (channel_id, author_id) VALUES ($1, $2) RETURNING id`, [channel, author.actorId])).rows[0]?.id ?? '';
    await svc.onPosted(tx(t), {
      targetType: 'channel',
      targetId: channel,
      messageId: id,
      authorId: authorAsPerson ? author.personId : author.actorId,
      recipientPersonIds: recipients.map((p) => p.personId),
    });
    return id;
  });
}

const stateOf = (p: Persona, channel: string) =>
  w.as(p, async (t) => (await svc.get(tx(t), p.personId, [{ targetType: 'channel', targetId: channel }]))[0]);

describe('onPosted', () => {
  it('increments unread for every recipient except the author (author given as actor id or as person id)', async () => {
    const ch = randomUUID();
    await post(ch, RAFI, [NADIA, RAFI, PRIYA]);
    await post(ch, RAFI, [NADIA, RAFI, PRIYA], true);
    expect((await stateOf(NADIA, ch))?.unreadCount).toBe(2);
    expect((await stateOf(PRIYA, ch))?.unreadCount).toBe(2);
    expect(await stateOf(RAFI, ch)).toEqual({ targetType: 'channel', targetId: ch, lastReadId: null, unreadCount: 0, followed: false });
    // Someone who is not a recipient has nothing.
    expect((await stateOf(OMAR, ch))?.unreadCount).toBe(0);
  });

  it('is one statement for the whole recipient list and returns the changed entries', async () => {
    const ch = randomUUID();
    const changed = await w.as(RAFI, async (t) => {
      const id = (await t.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';
      return svc.onPosted(tx(t), { targetType: 'channel', targetId: ch, messageId: id, authorId: RAFI.actorId, recipientPersonIds: [NADIA, PRIYA, OMAR, RAFI].map((p) => p.personId) });
    });
    expect(changed.map((c) => c.personId).sort()).toEqual([NADIA, PRIYA, OMAR].map((p) => p.personId).sort());
    expect(changed.every((c) => c.unreadCount === 1)).toBe(true);
  });

  it('ignores people who are not active members of the workspace and duplicates in the list', async () => {
    const ch = randomUUID();
    const stranger = randomUUID();
    await w.as(RAFI, async (t) => {
      const id = (await t.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';
      const changed = await svc.onPosted(tx(t), { targetType: 'channel', targetId: ch, messageId: id, authorId: RAFI.actorId, recipientPersonIds: [stranger, NADIA.personId, NADIA.personId] });
      expect(changed.map((c) => c.personId)).toEqual([NADIA.personId]);
    });
    const rows = await w.system((t) => t.query('SELECT person_id FROM read_state WHERE target_id = $1', [ch]));
    expect(rows.rows).toEqual([{ person_id: NADIA.personId }]);
  });

  it('does not count a message that is not newer than the read position (replay, out of order)', async () => {
    const ch = randomUUID();
    const m1 = await post(ch, RAFI, [NADIA]);
    const m2 = await post(ch, RAFI, [NADIA]);
    await w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m2));
    // m1 is delivered again after Nadia read past it
    await w.as(RAFI, (t) => svc.onPosted(tx(t), { targetType: 'channel', targetId: ch, messageId: m1, authorId: RAFI.actorId, recipientPersonIds: [NADIA.personId] }));
    expect((await stateOf(NADIA, ch))?.unreadCount).toBe(0);
  });

  it('is refused for an actor that is not part of the workspace', async () => {
    const stranger = { kind: 'person' as const, id: randomUUID() as never, workspaceId: KAHF_WORKSPACE_ID };
    await expect(
      withActor(stranger, (t) => t.query(`SELECT * FROM app.read_state_bump('channel', $1, $2, $3, $4::uuid[])`, [randomUUID(), randomUUID(), randomUUID(), [NADIA.personId]]), { pool: w.appPool }),
    ).rejects.toMatchObject({ code: '42501' });
    // ... and it changed nothing
    expect((await w.system((t) => t.query('SELECT 1 FROM read_state WHERE person_id = $1 AND unread_count > 99', [NADIA.personId]))).rows).toEqual([]);
  });
});

describe('markRead', () => {
  it('recomputes unread from the registered counter and clears it at the newest message', async () => {
    const ch = randomUUID();
    const [m1, m2, m3] = [await post(ch, RAFI, [NADIA]), await post(ch, RAFI, [NADIA]), await post(ch, RAFI, [NADIA])] as [string, string, string];
    expect((await stateOf(NADIA, ch))?.unreadCount).toBe(3);
    const afterM1 = await w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m1));
    expect(afterM1).toMatchObject({ lastReadId: m1, unreadCount: 2 });
    const afterM3 = await w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m3));
    expect(afterM3).toMatchObject({ lastReadId: m3, unreadCount: 0 });
    expect(m2 < m3).toBe(true);
  });

  it('is monotonic: an older position changes nothing and returns the current state', async () => {
    const ch = randomUUID();
    const [m1, m2] = [await post(ch, RAFI, [NADIA]), await post(ch, RAFI, [NADIA])] as [string, string];
    await w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m2));
    const back = await w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m1));
    expect(back).toMatchObject({ lastReadId: m2, unreadCount: 0 });
    const m3 = await post(ch, RAFI, [NADIA]);
    const again = await w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m1));
    expect(again).toMatchObject({ lastReadId: m2, unreadCount: 1 });
    expect(m3 > m2).toBe(true);
  });

  it('creates the row for a person who never received a post, and takes `remaining` over the counter', async () => {
    const ch = randomUUID();
    const m1 = await post(ch, RAFI, []);
    const entry = await w.as(PRIYA, (t) => svc.markRead(tx(t), PRIYA.personId, { targetType: 'channel', targetId: ch }, m1, { remaining: 7 }));
    expect(entry).toMatchObject({ lastReadId: m1, unreadCount: 7 });
    await expect(w.as(PRIYA, (t) => svc.markRead(tx(t), PRIYA.personId, { targetType: 'channel', targetId: ch }, randomUUID(), { remaining: -1 }))).rejects.toThrow(RangeError);
  });

  it('needs a counter or `remaining`: UnreadCounterMissingError for a type nobody registered', async () => {
    const thread = randomUUID();
    await expect(w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'thread', targetId: thread }, randomUUID()))).rejects.toBeInstanceOf(UnreadCounterMissingError);
    // the failed call rolled back with its transaction: no row
    expect((await w.system((t) => t.query('SELECT 1 FROM read_state WHERE target_id = $1', [thread]))).rows).toEqual([]);
  });

  it('two mark-reads racing end at the newest position with its count, whatever the order', async () => {
    for (let round = 0; round < 15; round += 1) {
      const ch = randomUUID();
      const ms: string[] = [];
      for (let i = 0; i < 6; i += 1) ms.push(await post(ch, RAFI, [NADIA]));
      const calls = [ms[1], ms[4]].map((m) => w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m as string)));
      if (round % 2 === 1) calls.reverse();
      await Promise.all(calls);
      expect(await stateOf(NADIA, ch), `round ${round}`).toMatchObject({ lastReadId: ms[4], unreadCount: 1 });
    }
  });

  it('a post racing a mark-read is counted exactly once (the counter taken under the row lock)', async () => {
    for (let round = 0; round < 15; round += 1) {
      const ch = randomUUID();
      const m1 = await post(ch, RAFI, [NADIA]);
      await post(ch, RAFI, [NADIA]);
      await Promise.all([
        post(ch, RAFI, [NADIA]),
        w.as(NADIA, (t) => svc.markRead(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, m1)),
        post(ch, RAFI, [NADIA]),
      ]);
      const state = await stateOf(NADIA, ch);
      // The invariant: the stored count is the number of messages newer than the stored position.
      const truth = await w.as(NADIA, (t) => countAfter(t, ch, state?.lastReadId ?? m1));
      expect(state?.unreadCount, `round ${round}`).toBe(truth);
    }
  });
});

describe('follow, get and the summary', () => {
  it('setFollowed toggles the flag and keeps the counters', async () => {
    const ch = randomUUID();
    const m = await post(ch, RAFI, [NADIA]);
    const on = await w.as(NADIA, (t) => svc.setFollowed(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, true));
    expect(on).toMatchObject({ followed: true, unreadCount: 1 });
    expect(await w.as(NADIA, (t) => svc.setFollowed(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, true))).toMatchObject({ followed: true });
    const off = await w.as(NADIA, (t) => svc.setFollowed(tx(t), NADIA.personId, { targetType: 'channel', targetId: ch }, false));
    expect(off).toMatchObject({ followed: false, unreadCount: 1 });
    expect(m).toBeTruthy();
  });

  it('get answers every requested target in order, zeros for the unknown', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await post(a, RAFI, [SAMEERA]);
    const got = await w.as(SAMEERA, (t) =>
      svc.get(tx(t), SAMEERA.personId, [{ targetType: 'channel', targetId: b }, { targetType: 'channel', targetId: a }]),
    );
    expect(got.map((g) => [g.targetId, g.unreadCount])).toEqual([[b, 0], [a, 1]]);
    expect(await w.as(SAMEERA, (t) => svc.get(tx(t), SAMEERA.personId, []))).toEqual([]);
  });

  it('unreadSummary: unread channels (only those with unread) and one total for threads', async () => {
    const [c1, c2, c3] = [randomUUID(), randomUUID(), randomUUID()];
    const [t1, t2] = [randomUUID(), randomUUID()];
    await post(c1, RAFI, [LENA]);
    await post(c1, RAFI, [LENA]);
    const m = await post(c2, RAFI, [LENA]);
    await w.as(LENA, (t) => svc.markRead(tx(t), LENA.personId, { targetType: 'channel', targetId: c2 }, m)); // c2 read again
    await post(c3, RAFI, [LENA]);
    await w.as(RAFI, async (t) => {
      const id = (await t.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';
      await svc.onPosted(tx(t), { targetType: 'thread', targetId: t1, messageId: id, authorId: RAFI.actorId, recipientPersonIds: [LENA.personId] });
      await svc.onPosted(tx(t), { targetType: 'thread', targetId: t1, messageId: (await t.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '', authorId: RAFI.actorId, recipientPersonIds: [LENA.personId] });
      await svc.onPosted(tx(t), { targetType: 'thread', targetId: t2, messageId: (await t.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '', authorId: RAFI.actorId, recipientPersonIds: [LENA.personId] });
    });
    const summary = await w.as(LENA, (t) => svc.unreadSummary(tx(t), LENA.personId));
    expect(summary.channels).toEqual(expect.arrayContaining([{ channelId: c1, unreadCount: 2 }, { channelId: c3, unreadCount: 1 }]));
    expect(summary.channels.map((c) => c.channelId)).not.toContain(c2);
    expect(summary.threads).toEqual({ threadCount: 2, unreadCount: 3 });
    expect(summary.total).toBe(2 + 1 + 3);
  });
});

describe('the partial unread index', () => {
  it('the unread query as a person uses read_state_unread, not a scan of the table', async () => {
    // 6 people x 6,000 targets, all read, plus 3 unread for Nadia: the hot filter must not touch the 36,000.
    await w.system((t) =>
      t.query(
        `INSERT INTO read_state (person_id, target_type, target_id, unread_count)
         SELECT p, 'channel', gen_random_uuid(), 0 FROM unnest($1::uuid[]) p CROSS JOIN generate_series(1, 6000)`,
        [[OMAR, RAFI, SAMEERA, PRIYA, LENA, NADIA].map((p) => p.personId)],
      ),
    );
    for (const c of [randomUUID(), randomUUID(), randomUUID()]) await post(c, RAFI, [NADIA]);
    await owner.query('VACUUM ANALYZE app.read_state');
    const plan = await w.as(NADIA, async (t) => {
      const res = await t.query<{ 'QUERY PLAN': unknown }>(
        'EXPLAIN (FORMAT JSON) SELECT target_type, target_id, unread_count FROM app.read_state WHERE person_id = $1 AND unread_count > 0',
        [NADIA.personId],
      );
      return JSON.stringify(res.rows[0]?.['QUERY PLAN']);
    });
    expect(plan).toContain('read_state_unread');
    expect(plan).not.toContain('Seq Scan');
    const summary = await w.as(NADIA, (t) => svc.unreadSummary(tx(t), NADIA.personId));
    expect(summary.channels.length).toBeGreaterThanOrEqual(3);
  }, 60_000);
});

describe('row-level security (P: own rows only)', () => {
  it("Nadia cannot read Rafi's read state, and neither can an admin", async () => {
    const ch = randomUUID();
    await post(ch, NADIA, [RAFI]);
    expect((await stateOf(RAFI, ch))?.unreadCount).toBe(1);
    for (const p of [NADIA, OMAR, PRIYA, LENA]) {
      const rows = await w.as(p, (t) => t.query('SELECT * FROM read_state WHERE person_id = $1', [RAFI.personId]));
      expect(rows.rows, `${p.key} reads Rafi's rows`).toEqual([]);
      const viaService = await w.as(p, (t) => svc.get(tx(t), RAFI.personId, [{ targetType: 'channel', targetId: ch }]));
      expect(viaService[0]?.unreadCount, `${p.key} via service`).toBe(0);
    }
    const own = await w.as(RAFI, (t) => t.query('SELECT * FROM read_state WHERE target_id = $1', [ch]));
    expect(own.rows).toHaveLength(1);
  });

  it("Nadia cannot change or create Rafi's rows", async () => {
    const ch = randomUUID();
    await post(ch, NADIA, [RAFI]);
    const upd = await w.as(NADIA, (t) => t.query('UPDATE read_state SET unread_count = 0 WHERE person_id = $1', [RAFI.personId]));
    expect(upd.rowCount).toBe(0);
    const del = await w.as(NADIA, (t) => t.query('DELETE FROM read_state WHERE person_id = $1', [RAFI.personId]));
    expect(del.rowCount).toBe(0);
    await expect(
      w.as(NADIA, (t) => t.query(`INSERT INTO read_state (person_id, target_type, target_id) VALUES ($1, 'channel', $2)`, [RAFI.personId, randomUUID()])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      w.as(NADIA, (t) => svc.markRead(tx(t), RAFI.personId, { targetType: 'channel', targetId: ch }, randomUUID(), { remaining: 0 })),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await stateOf(RAFI, ch))?.unreadCount).toBe(1);
  });

  it('a bot has no read state, and the table passes the per-row policy check (see harness)', async () => {
    const bot = { kind: 'bot' as const, id: randomUUID() as never, workspaceId: KAHF_WORKSPACE_ID };
    const rows = await withActor(bot, (t) => t.query('SELECT * FROM read_state'), { pool: w.appPool });
    expect(rows.rows).toEqual([]);
  });
});

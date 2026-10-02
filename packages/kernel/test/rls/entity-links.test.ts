import { randomUUID } from 'node:crypto';
import type { EntityRef } from '@manythreads/shared';
import { LENA, NADIA, OMAR, PRIYA, SAMEERA, TARIQ, TEAM_IDS, KAHF_WORKSPACE_ID } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEntityLinkService, type EntityResolvers } from '../../src/entity-links/index.ts';
import type { Tx } from '../../src/index.ts';
import { createWorld, type World } from './world.ts';

// P3-04: the entity-link service on app.entity_links (policy T, members only): idempotent create, listing by direction, the
// resolver registry running under the caller's RLS, and the type and kind rules of migration 0013.

let w: World;
let owner: pg.Client;
const resolvers: EntityResolvers = new Map();
const links = createEntityLinkService({ resolvers, plugin: 'test' });
const tx = (t: Tx) => t as never;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;
const msg = () => ({ type: 'message' as const, id: randomUUID() });
const page = () => ({ type: 'page' as const, id: randomUUID() });

beforeAll(async () => {
  w = await createWorld();
  owner = new pg.Client({ connectionString: w.db.ownerUrl });
  await owner.connect();
}, 120_000);
afterAll(async () => {
  await owner?.end();
  await w?.close();
}, 60_000);

describe('create', () => {
  it('is idempotent: the same link returns the same row, created only the first time', async () => {
    const [src, dst] = [msg(), page()];
    const first = await w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src, dst, kind: 'mentions' }));
    const second = await w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src, dst, kind: 'mentions' }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.link).toEqual(first.link);
    expect(first.link).toMatchObject({ teamId: ENG, src, dst, kind: 'mentions' });
    // a different kind is another link
    const other = await w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src, dst, kind: 'related' }));
    expect(other.created).toBe(true);
    expect(other.link.id).not.toBe(first.link.id);
  });

  it('concurrent creators converge on one row', async () => {
    const [src, dst] = [msg(), { type: 'file' as const, id: randomUUID() }];
    const results = await Promise.all(
      [NADIA, PRIYA, OMAR, NADIA, PRIYA, OMAR].map((p) => w.as(p, (t) => links.create(tx(t), { teamId: ENG, src, dst, kind: 'attached' }))),
    );
    expect(new Set(results.map((r) => r.link.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await w.system((t) => t.query('SELECT id FROM entity_links WHERE src_id = $1', [src.id]));
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses a link to itself, an unknown type and a malformed kind (zod, and the CHECKs behind them)', async () => {
    const a = msg();
    await expect(w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src: a, dst: a, kind: 'related' }))).rejects.toThrow(RangeError);
    await expect(w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src: { type: 'event' as never, id: randomUUID() }, dst: a, kind: 'related' }))).rejects.toThrow();
    await expect(w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src: msg(), dst: a, kind: 'Related!' }))).rejects.toThrow();
    // straight SQL cannot get around it either
    for (const [src, dst, kind] of [['event', 'message', 'related'], ['message', 'run', 'related'], ['message', 'page', 'BAD KIND']] as const) {
      await expect(
        owner.query('INSERT INTO app.entity_links (team_id, src_type, src_id, dst_type, dst_id, kind) VALUES ($1, $2, $3, $4, $5, $6)', [ENG, src, randomUUID(), dst, randomUUID(), kind]),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});

describe('list', () => {
  it('lists out, in and both, newest first, and filters by kind', async () => {
    const [a, b, c]: [EntityRef, EntityRef, EntityRef] = [msg(), page(), { type: 'task', id: randomUUID() }];
    const ab = (await w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src: a, dst: b, kind: 'mentions' }))).link;
    const ca = (await w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src: c, dst: a, kind: 'created_from' }))).link;
    const cb = (await w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src: c, dst: b, kind: 'related' }))).link;
    const ids = async (ref: EntityRef, dir?: 'out' | 'in' | 'both', kind?: string) =>
      (await w.as(NADIA, (t) => links.list(tx(t), ref, dir, kind ? { kind } : {}))).map((l) => l.id);
    expect(await ids(a, 'out')).toEqual([ab.id]);
    expect(await ids(a, 'in')).toEqual([ca.id]);
    expect(await ids(a)).toEqual([ca.id, ab.id]);
    expect(await ids(b, 'in')).toEqual([cb.id, ab.id]);
    expect(await ids(b, 'in', 'related')).toEqual([cb.id]);
    expect(await ids(c, 'out')).toEqual([cb.id, ca.id]);
    expect(await w.as(NADIA, (t) => links.list(tx(t), b, 'in', { limit: 1 }))).toHaveLength(1);
    expect(await w.as(NADIA, (t) => links.remove(tx(t), { src: c, dst: b, kind: 'related' }))).toBe(true);
    expect(await w.as(NADIA, (t) => links.remove(tx(t), { src: c, dst: b, kind: 'related' }))).toBe(false);
    expect(await ids(b, 'in')).toEqual([ab.id]);
  });
});

describe('row-level security (T: members of the team only)', () => {
  it('only members of the team see or make links; admins, other teams and guests do not', async () => {
    const [src, dst] = [msg(), page()];
    await w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src, dst, kind: 'mentions' }));
    const seen = async (p: typeof NADIA) => (await w.as(p, (t) => links.list(tx(t), src))).length;
    expect(await seen(NADIA)).toBe(1);
    expect(await seen(PRIYA)).toBe(1); // Engineering and Marketing
    expect(await seen(OMAR)).toBe(1); // member of Engineering (leads it)
    expect(await seen(SAMEERA)).toBe(0); // Customer support
    expect(await seen(TARIQ)).toBe(0); // Marketing only
    expect(await seen(LENA)).toBe(0); // guest
    await expect(w.as(SAMEERA, (t) => links.create(tx(t), { teamId: ENG, src: msg(), dst: page(), kind: 'mentions' }))).rejects.toMatchObject({ code: '42501' });
    await expect(w.as(LENA, (t) => links.create(tx(t), { teamId: ENG, src: msg(), dst: page(), kind: 'mentions' }))).rejects.toMatchObject({ code: '42501' });
    expect(await w.as(SAMEERA, (t) => links.remove(tx(t), { src, dst, kind: 'mentions' }))).toBe(false);
  });

  it('a workspace admin who is not on the team does not see its links (no admin override)', async () => {
    const [src, dst] = [msg(), page()];
    await w.as(TARIQ, (t) => links.create(tx(t), { teamId: MKT, src, dst, kind: 'related' }));
    expect(await w.as(OMAR, (t) => links.list(tx(t), src))).toEqual([]);
    expect(await w.as(PRIYA, (t) => links.list(tx(t), src))).toHaveLength(1);
  });

  it('the policy is the hoisted form (no per-row helper calls in the plan)', async () => {
    const plan = await w.as(NADIA, async (t) => JSON.stringify((await t.query('EXPLAIN (VERBOSE, FORMAT JSON) SELECT count(*) FROM app.entity_links')).rows[0]));
    expect(plan).toContain('member_team_ids');
    expect(plan).not.toMatch(/is_team_member|can_in_team|app\.can\(/);
  });
});

describe('resolvers', () => {
  it('summarise through the type resolver in the caller transaction, so RLS applies to the lookup', async () => {
    const stubEng = (await w.system((t) => t.query<{ id: string }>(`INSERT INTO stub_resources (workspace_id, team_id, name) VALUES ($1, $2, 'Runbook') RETURNING id`, [KAHF_WORKSPACE_ID, ENG]))).rows[0]?.id ?? '';
    const stubMkt = (await w.system((t) => t.query<{ id: string }>(`INSERT INTO stub_resources (workspace_id, team_id, name) VALUES ($1, $2, 'Campaign') RETURNING id`, [KAHF_WORKSPACE_ID, MKT]))).rows[0]?.id ?? '';
    links.registerResolver('page', async (t, id) => {
      const row = (await t.query<{ name: string }>('SELECT name FROM app.stub_resources WHERE id = $1', [id])).rows[0];
      return row ? { title: row.name, subtitle: 'stub', href: `/pages/${id}` } : null;
    });
    const src = msg();
    // An Engineering link to a Marketing page: Nadia sees the link (her team) but not what it points to.
    await w.as(NADIA, (t) => links.create(tx(t), { teamId: ENG, src, dst: { type: 'page', id: stubEng }, kind: 'mentions' }));
    await w.as(PRIYA, (t) => links.create(tx(t), { teamId: ENG, src, dst: { type: 'page', id: stubMkt }, kind: 'mentions' }));
    const summaries = async (p: typeof NADIA) =>
      w.as(p, async (t) => {
        const out = [];
        for (const l of await links.list(tx(t), src, 'out')) out.push(await links.resolve(tx(t), l.dst));
        return out;
      });
    expect(await summaries(NADIA)).toEqual(expect.arrayContaining([{ type: 'page', id: stubEng, title: 'Runbook', subtitle: 'stub', href: `/pages/${stubEng}` }, null]));
    expect((await summaries(NADIA)).filter((s) => s !== null)).toHaveLength(1);
    expect((await summaries(PRIYA)).filter((s) => s !== null)).toHaveLength(2);
    // no resolver for a type: null; an id nobody has: null
    expect(await w.as(NADIA, (t) => links.resolve(tx(t), { type: 'bot', id: randomUUID() }))).toBeNull();
    expect(await w.as(NADIA, (t) => links.resolve(tx(t), { type: 'page', id: randomUUID() }))).toBeNull();
  });

  it('one resolver per type; a second registration throws and names the owner', () => {
    const other = createEntityLinkService({ resolvers, plugin: 'other' });
    expect(() => other.registerResolver('page', () => Promise.resolve(null))).toThrow(/already registered by plugin "test"/);
    expect(() => links.registerResolver('nope' as never, () => Promise.resolve(null))).toThrow();
  });
});

import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryInboxMigrationSource,
  memoryShareMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P8-24, P8-25 (security-critical, cross-team): the definer functions that move memory between teams. app.deliver_inbox_item writes into ANOTHER team's inbox, so who may call
// it, what it checks again for every caller, and that a replay changes nothing are tested here against a real database with forged callers. Also: the receiving team's accept
// row, its pause / resume / end door, the incoming view, and the workspace switch.
//
// Cast (the seed workspace): ENG led by omar (who is also owner and admin, so he manages every team), MARKETING led by tariq (no workspace role), SUPPORT has only a member
// (sameera). Two arrangements are used so that the sending lead and the receiving lead are never the same person: ENG -> MARKETING (tariq receives) and MARKETING -> ENG.

const { omar, nadia, rafi, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const SUPPORT = TEAM_IDS['Customer support'];
const MARKETING = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const hex = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 1000;

interface Seed {
  shareId: string;
  linkId: string;
  runId: string;
  from: string;
  to: string;
}

/** A share of `from` with a link to `to` in `linkState`, and a run of it in `runState` (with a digest), as the platform's jobs leave them. */
async function seed(from: string, to: string, o: { linkState?: string; runState?: string; shareStatus?: string } = {}): Promise<Seed> {
  counter += 1;
  const linkState = o.linkState ?? 'accepted';
  return sys(async (tx) => {
    const names = (await tx.query<{ id: string; slug: string; name: string }>('SELECT id, slug, name FROM app.teams WHERE id = ANY($1::uuid[])', [[from, to]])).rows;
    const dest = names.find((t) => t.id === to)!;
    const share = await tx.query<{ id: string }>(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name, status) VALUES ($1, $2, $3, 'Release notes', $4) RETURNING id`, [
      omar.workspaceId,
      from,
      `deliver-${counter}`,
      o.shareStatus ?? 'active',
    ]);
    const shareId = share.rows[0]!.id;
    const link = await tx.query<{ id: string }>(
      `INSERT INTO app.memory_share_links (workspace_id, team_id, share_id, dest_team_id, dest_slug, dest_name, state, accepted_at, ended_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 IN ('accepted', 'paused') THEN now() END, CASE WHEN $7 = 'revoked' THEN 'by_team' END) RETURNING id`,
      [omar.workspaceId, from, shareId, to, dest.slug, dest.name, linkState],
    );
    const runState = o.runState ?? 'ready';
    const withDigest = ['awaiting_approval', 'ready', 'sent'].includes(runState);
    const run = await tx.query<{ id: string }>(
      `INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode, requested_by, period, digest_sha, bundle, bundle_bytes, manifest, destinations, sent_at)
       VALUES ($1, $2, $3, 'manual', $4, 'summary', $5, '2026-11-02', $6, $7::jsonb, 120, $8::jsonb, $9::jsonb, CASE WHEN $4 = 'sent' THEN now() END) RETURNING id`,
      [
        omar.workspaceId,
        from,
        shareId,
        runState,
        omar.actorId,
        withDigest ? hex(counter) : null,
        withDigest ? JSON.stringify({ 'digest.md': 'a', 'index.md': 'b', 'log.md': 'c' }) : null,
        withDigest ? JSON.stringify({}) : null,
        JSON.stringify([{ teamId: to, slug: dest.slug, name: dest.name }]),
      ],
    );
    return { shareId, linkId: link.rows[0]!.id, runId: run.rows[0]!.id, from, to };
  });
}

const deliver = (p: Persona | 'system', runId: string, dest: string): Promise<Array<Record<string, unknown>>> => {
  const run = async (tx: Tx): Promise<Array<Record<string, unknown>>> => (await tx.query('SELECT * FROM app.deliver_inbox_item($1::uuid, $2::uuid)', [runId, dest])).rows as Array<Record<string, unknown>>;
  return p === 'system' ? sys(run) : as(p, run);
};
const itemsFor = (team: string): Promise<number> => sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.memory_inbox_items WHERE team_id = $1 AND origin = 'share'`, [team])).rows[0]!.n);
const deliveries = (runId: string): Promise<number> => sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_share_deliveries WHERE run_id = $1', [runId])).rows[0]!.n);
const setSwitch = (enabled: boolean): Promise<unknown> =>
  sys((tx) => tx.query(`INSERT INTO app.memory_sharing_settings (workspace_id, enabled) VALUES ($1, $2) ON CONFLICT (workspace_id) DO UPDATE SET enabled = EXCLUDED.enabled`, [omar.workspaceId, enabled]));

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, approvalsMigrationSource, memoryInboxMigrationSource, memoryShareMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('app.deliver_inbox_item: who may deliver', () => {
  it('a lead of the SENDING team delivers an approved digest into the destination’s inbox as an authenticated share item', async () => {
    const s = await seed(MARKETING, ENG);
    const before = await itemsFor(ENG);
    const rows = await deliver(tariq, s.runId, ENG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ o_duplicate: false, o_team_id: MARKETING, o_dest_team_id: ENG, o_share_id: s.shareId, o_period: '2026-11-02', o_files: 3, o_bytes: 120 });
    expect(await itemsFor(ENG)).toBe(before + 1);
    const item = await sys(async (tx) => (await tx.query<Record<string, unknown>>('SELECT team_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, sender, sender_check, team_only FROM app.memory_inbox_items WHERE id = $1', [rows[0]!['o_item_id']])).rows[0]!);
    expect(item).toMatchObject({ team_id: ENG, origin: 'share', state: 'queued', stage: 'hold', kind: 'bundle', size: '120', blob_key: null, dropper_id: null, sender_check: 'pass', team_only: false });
    expect(String(item['name'])).toMatch(/^digests\/marketing\/2026-11-02$/);
    expect(String(item['sender'])).toBe('marketing');
    expect(await deliveries(s.runId)).toBe(1);
  });

  it('the platform (system role) delivers too', async () => {
    const s = await seed(ENG, MARKETING);
    const rows = await deliver('system', s.runId, MARKETING);
    expect(rows[0]).toMatchObject({ o_duplicate: false, o_dest_team_id: MARKETING });
  });

  it('refuses every forged caller with 42501 and writes nothing: the destination’s own lead, a plain member of the sender, a member of a third team, a guest', async () => {
    const s = await seed(ENG, MARKETING);
    const before = await itemsFor(MARKETING);
    // tariq leads the DESTINATION: receiving a share does not let him push a digest into his own inbox
    expect(await code(deliver(tariq, s.runId, MARKETING))).toBe('42501');
    expect(await code(deliver(nadia, s.runId, MARKETING))).toBe('42501'); // a member of the sending team, not a lead
    expect(await code(deliver(rafi, s.runId, MARKETING))).toBe('42501');
    expect(await code(deliver(sameera, s.runId, MARKETING))).toBe('42501'); // a member of a third team
    expect(await code(deliver(lena, s.runId, MARKETING))).toBe('42501'); // a guest
    expect(await itemsFor(MARKETING)).toBe(before);
    expect(await deliveries(s.runId)).toBe(0);
  });

  it('a run that does not exist and a run the caller may not use answer the same, so ids cannot be probed', async () => {
    const s = await seed(ENG, MARKETING);
    const missing = '00000000-0000-7000-8000-00000000f00d';
    expect(await code(deliver(tariq, missing, MARKETING))).toBe('42501');
    expect(await code(deliver(tariq, s.runId, MARKETING))).toBe('42501');
  });

  it('a sending lead cannot deliver into a team the share does not name (no link, no delivery) and cannot name a team of nowhere', async () => {
    const s = await seed(MARKETING, ENG);
    expect(await code(deliver(tariq, s.runId, SUPPORT))).toBe('55000');
    expect(await code(deliver(tariq, s.runId, '00000000-0000-7000-8000-00000000f00d'))).toBe('55000');
    expect(await itemsFor(SUPPORT)).toBe(0);
  });

  it('a lead of another team’s share cannot deliver it: the sending team of the RUN is what is checked, not the one in the call', async () => {
    const s = await seed(ENG, MARKETING);
    // tariq leads MARKETING; the run is ENG's. Naming his own team as the destination does not make it his.
    expect(await code(deliver(tariq, s.runId, MARKETING))).toBe('42501');
    expect(await code(deliver(tariq, s.runId, ENG))).toBe('42501');
  });
});

describe('app.deliver_inbox_item: only the teams the approver was shown', () => {
  it('a team that accepted after the digest was approved, and so is not in the run’s destinations, gets nothing (55000), for the platform and the sending lead', async () => {
    const s = await seed(MARKETING, ENG);
    await sys((tx) => tx.query(`INSERT INTO app.memory_share_links (workspace_id, team_id, share_id, dest_team_id, dest_slug, dest_name, state, accepted_at) VALUES ($1, $2, $3, $4, 'customer-support', 'Customer support', 'accepted', now())`, [omar.workspaceId, MARKETING, s.shareId, SUPPORT]));
    const before = await itemsFor(SUPPORT);
    expect(await code(deliver('system', s.runId, SUPPORT))).toBe('55000');
    expect(await code(deliver(tariq, s.runId, SUPPORT))).toBe('55000');
    expect(await itemsFor(SUPPORT)).toBe(before);
    expect(await deliveries(s.runId)).toBe(0);
    // the team that was named still gets it
    expect((await deliver('system', s.runId, ENG))[0]).toMatchObject({ o_duplicate: false });
  });

  it('a run with no destinations recorded delivers to nobody', async () => {
    const s = await seed(MARKETING, ENG);
    await sys((tx) => tx.query(`UPDATE app.memory_share_runs SET destinations = '[]'::jsonb WHERE id = $1`, [s.runId]));
    expect(await code(deliver('system', s.runId, ENG))).toBe('55000');
    expect(await deliveries(s.runId)).toBe(0);
  });
});

describe('app.deliver_inbox_item: a link that is not accepted delivers nothing', () => {
  for (const linkState of ['requested', 'paused', 'revoked']) {
    it(`link ${linkState}: refused (55000), no item, no delivery, for the platform and for the sending lead`, async () => {
      const s = await seed(MARKETING, ENG, { linkState });
      const before = await itemsFor(ENG);
      expect(await code(deliver('system', s.runId, ENG))).toBe('55000');
      expect(await code(deliver(tariq, s.runId, ENG))).toBe('55000');
      expect(await itemsFor(ENG)).toBe(before);
      expect(await deliveries(s.runId)).toBe(0);
    });
  }

  it('a paused link delivers again once the team resumes it, and a revoked one never does', async () => {
    const s = await seed(MARKETING, ENG, { linkState: 'paused' });
    expect(await code(deliver('system', s.runId, ENG))).toBe('55000');
    await as(omar, (tx) => tx.query(`SELECT * FROM app.memory_share_link_act($1::uuid, $2::uuid, 'resume')`, [s.linkId, ENG]));
    expect((await deliver('system', s.runId, ENG))[0]).toMatchObject({ o_duplicate: false });
    const t = await seed(MARKETING, ENG, { linkState: 'accepted' });
    await as(omar, (tx) => tx.query(`SELECT * FROM app.memory_share_link_act($1::uuid, $2::uuid, 'revoke')`, [t.linkId, ENG]));
    expect(await code(deliver('system', t.runId, ENG))).toBe('55000');
  });

  it('a run that is not approved yet (building, awaiting approval, denied, expired) delivers nothing', async () => {
    for (const runState of ['building', 'awaiting_approval', 'denied', 'expired', 'empty', 'failed']) {
      const s = await seed(MARKETING, ENG, { runState });
      expect(await code(deliver('system', s.runId, ENG)), runState).toBe('55000');
      expect(await deliveries(s.runId), runState).toBe(0);
    }
  });

  it('a removed or invalid share delivers nothing', async () => {
    for (const shareStatus of ['removed', 'invalid']) {
      const s = await seed(MARKETING, ENG, { shareStatus });
      expect(await code(deliver('system', s.runId, ENG)), shareStatus).toBe('55000');
    }
  });

  it('an archived destination receives nothing', async () => {
    const s = await seed(ENG, SUPPORT);
    await sys((tx) => tx.query('UPDATE app.teams SET archived_at = now() WHERE id = $1', [SUPPORT]));
    try {
      expect(await code(deliver('system', s.runId, SUPPORT))).toBe('55000');
    } finally {
      await sys((tx) => tx.query('UPDATE app.teams SET archived_at = NULL WHERE id = $1', [SUPPORT]));
    }
    expect(await itemsFor(SUPPORT)).toBe(0);
  });
});

describe('the workspace switch “Memory sharing”', () => {
  it('off stops every send, on lets the same run go; with no row at all sharing is on', async () => {
    const s = await seed(MARKETING, ENG);
    await setSwitch(false);
    try {
      expect(await code(deliver('system', s.runId, ENG))).toBe('55000');
      expect(await code(deliver(tariq, s.runId, ENG))).toBe('55000');
      expect(await deliveries(s.runId)).toBe(0);
    } finally {
      await setSwitch(true);
    }
    expect((await deliver('system', s.runId, ENG))[0]).toMatchObject({ o_duplicate: false });
  });

  it('is readable by everyone in the workspace and written only by an owner or admin', async () => {
    const read = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.memory_sharing_settings')).rowCount ?? 0);
    await setSwitch(true);
    for (const p of [omar, nadia, tariq, sameera]) expect(await read(p), p.key).toBe(1);
    const write = (p: Persona): Promise<unknown> =>
      as(p, (tx) => tx.query(`UPDATE app.memory_sharing_settings SET enabled = false, changed_by = $2, updated_at = now() WHERE workspace_id = $1`, [omar.workspaceId, p.actorId]));
    // a team lead is not a workspace admin: the update matches no row he may touch
    for (const p of [tariq, nadia, sameera]) {
      const changed = await as(p, async (tx) => (await tx.query(`UPDATE app.memory_sharing_settings SET enabled = false WHERE workspace_id = $1`, [omar.workspaceId])).rowCount);
      expect(changed, p.key).toBe(0);
    }
    expect(await code(as(tariq, (tx) => tx.query(`DELETE FROM app.memory_sharing_settings`)))).toBe('42501');
    expect(await sys(async (tx) => (await tx.query<{ enabled: boolean }>('SELECT enabled FROM app.memory_sharing_settings')).rows[0]!.enabled)).toBe(true);
    await write(omar);
    expect(await sys(async (tx) => (await tx.query<{ enabled: boolean }>('SELECT enabled FROM app.memory_sharing_settings')).rows[0]!.enabled)).toBe(false);
    await setSwitch(true);
  });
});

describe('app.deliver_inbox_item: replay', () => {
  it('delivering the same digest to the same team again returns the first delivery and writes nothing', async () => {
    const s = await seed(MARKETING, ENG);
    const first = (await deliver('system', s.runId, ENG))[0]!;
    const again = (await deliver('system', s.runId, ENG))[0]!;
    const third = (await deliver(tariq, s.runId, ENG))[0]!;
    expect(first['o_duplicate']).toBe(false);
    expect(again).toMatchObject({ o_duplicate: true, o_delivery_id: first['o_delivery_id'], o_item_id: first['o_item_id'] });
    expect(third).toMatchObject({ o_duplicate: true, o_delivery_id: first['o_delivery_id'] });
    expect(await deliveries(s.runId)).toBe(1);
    expect(await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_inbox_items WHERE sha256 = $1 AND team_id = $2', [first['o_digest_sha'], ENG])).rows[0]!.n)).toBe(1);
  });

  it('a sent run can be replayed (still one item), and two destinations each get their own', async () => {
    const s = await seed(ENG, MARKETING, { runState: 'sent' });
    const one = (await deliver('system', s.runId, MARKETING))[0]!;
    expect((await deliver('system', s.runId, MARKETING))[0]).toMatchObject({ o_duplicate: true, o_item_id: one['o_item_id'] });
    // a second destination of the same share, named in the approved run as well
    await sys((tx) =>
      tx.query(`UPDATE app.memory_share_runs SET destinations = destinations || $2::jsonb WHERE id = $1`, [s.runId, JSON.stringify([{ teamId: SUPPORT, slug: 'customer-support', name: 'Customer support' }])]),
    );
    await sys((tx) =>
      tx.query(`INSERT INTO app.memory_share_links (workspace_id, team_id, share_id, dest_team_id, dest_slug, dest_name, state, accepted_at) VALUES ($1, $2, $3, $4, 'customer-support', 'Customer support', 'accepted', now())`, [
        omar.workspaceId,
        ENG,
        s.shareId,
        SUPPORT,
      ]),
    );
    const other = (await deliver('system', s.runId, SUPPORT))[0]!;
    expect(other).toMatchObject({ o_duplicate: false, o_dest_team_id: SUPPORT });
    expect(other['o_item_id']).not.toBe(one['o_item_id']);
    expect(await deliveries(s.runId)).toBe(2);
  });
});

describe('the request role cannot write across teams by hand', () => {
  it('cannot insert a delivery, a share item into another team’s inbox, or read the deliveries of a team it does not manage', async () => {
    const s = await seed(MARKETING, ENG);
    await deliver('system', s.runId, ENG);
    expect(
      await code(
        as(tariq, (tx) =>
          tx.query(`INSERT INTO app.memory_share_deliveries (workspace_id, team_id, share_id, run_id, dest_team_id, from_slug, digest_sha, period, files, bytes) VALUES ($1, $2, $3, $4, $5, 'marketing', $6, '2026-11-03', 1, 1)`, [
            omar.workspaceId,
            MARKETING,
            s.shareId,
            s.runId,
            ENG,
            hex(9),
          ]),
        ),
      ),
    ).toBeDefined();
    expect(
      await code(
        as(tariq, (tx) =>
          tx.query(`INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, state, stage, kind, name, size, sha256) VALUES ($1, $2, 'share', 'queued', 'hold', 'bundle', 'x', 1, $3)`, [omar.workspaceId, ENG, hex(10)]),
        ),
      ),
    ).toBeDefined();
    const seeing = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.memory_share_deliveries WHERE run_id = $1', [s.runId])).rowCount ?? 0);
    expect(await seeing(tariq)).toBe(1); // he manages the sending team
    expect(await seeing(nadia)).toBe(0);
    expect(await seeing(sameera)).toBe(0);
    expect(await seeing(lena)).toBe(0);
  });
});

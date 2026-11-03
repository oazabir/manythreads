import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  memoryShareMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import type { PluginTx } from '@manythreads/sdk';
import { isWorkspaceAdmin, mayAutoApprove } from '../../src/util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P8-22, P8-23: who reads a team's shares (the people of the team) and its runs (the people who manage the team: a run names what was left out), who starts a run
// (a lead or admin, as themselves, at the very beginning), what the request role can never do (write a share or a link, change a run, read the digest's files), the
// shape the database keeps whatever the code does, and the two definer doors that file and settle a digest's approval.

const { omar, nadia, rafi, sameera, tariq } = personas;
const ENG = TEAM_IDS.Engineering;
const SUPPORT = TEAM_IDS['Customer support'];
const MARKETING = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const sha = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 100;

/** A share of `team` with a link to `dest`, as the loader makes them (the system role). */
async function seedShare(team: string = ENG, dest: { id: string; slug: string } = { id: SUPPORT, slug: 'customer-support' }): Promise<{ shareId: string; slug: string }> {
  counter += 1;
  const slug = `share-${counter}`;
  return sys(async (tx) => {
    const share = await tx.query<{ id: string }>(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, 'Release notes') RETURNING id`, [omar.workspaceId, team, slug]);
    const shareId = share.rows[0]!.id;
    await tx.query(`INSERT INTO app.memory_share_links (workspace_id, team_id, share_id, dest_team_id, dest_slug, dest_name) VALUES ($1, $2, $3, $4, $5, 'Customer support')`, [omar.workspaceId, team, shareId, dest.id, dest.slug]);
    return { shareId, slug };
  });
}

interface RunSeed {
  state?: string;
  withDigest?: boolean;
  requestedBy?: Persona;
  team?: string;
}
/** A run as the system role makes one. */
async function seedRun(shareId: string, o: RunSeed = {}): Promise<string> {
  counter += 1;
  const digest = o.withDigest === true || ['awaiting_approval', 'ready', 'sent'].includes(o.state ?? '');
  return sys(async (tx) => {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode, requested_by, period, digest_sha, bundle, bundle_bytes, manifest, sent_at)
       VALUES ($1, $2, $3, 'manual', $4, 'summary', $5, '2026-11-02', $6, $7::jsonb, 10, $8::jsonb, $9) RETURNING id`,
      [
        omar.workspaceId,
        o.team ?? ENG,
        shareId,
        o.state ?? 'building',
        (o.requestedBy ?? omar).actorId,
        digest ? sha(counter) : null,
        digest ? JSON.stringify({ 'digest.md': 'x' }) : null,
        digest ? JSON.stringify({ 'memory/a.md': 'a'.repeat(40) }) : null,
        o.state === 'sent' ? new Date() : null,
      ],
    );
    return res.rows[0]!.id;
  });
}
const visibleShares = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.memory_shares ORDER BY id')).rows.map((r) => r.id));
const visibleRuns = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.memory_share_runs ORDER BY id')).rows.map((r) => r.id));

const startSql = `INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode, requested_by) VALUES ($1, $2, $3, $4, $5, 'summary', $6) RETURNING id`;
const start = (p: Persona, shareId: string, over: { team?: string; trigger?: string; state?: string; by?: string } = {}): Promise<unknown> =>
  as(p, (tx) => tx.query(startSql, [omar.workspaceId, over.team ?? ENG, shareId, over.trigger ?? 'manual', over.state ?? 'building', over.by ?? p.actorId]));

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, approvalsMigrationSource, memoryShareMigrationSource],
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

describe('reading', () => {
  it('shows a team’s shares and links to the people of the team, and nobody else', async () => {
    const { shareId } = await seedShare();
    for (const p of [omar, nadia, rafi]) expect(await visibleShares(p), p.key).toContain(shareId);
    for (const p of [sameera, tariq]) expect(await visibleShares(p), p.key).not.toContain(shareId);
    const links = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.memory_share_links WHERE share_id = $1', [shareId])).rowCount ?? 0);
    expect(await links(nadia)).toBe(1);
    expect(await links(sameera)).toBe(0);
  });

  it('shows a run only to the people who manage the team: it names what was left out', async () => {
    const { shareId } = await seedShare();
    const run = await seedRun(shareId, { state: 'empty' });
    expect(await visibleRuns(omar)).toContain(run);
    expect(await visibleRuns(nadia)).not.toContain(run);
    expect(await visibleRuns(rafi)).not.toContain(run);
    expect(await visibleRuns(sameera)).not.toContain(run);
    expect(await visibleRuns(tariq)).not.toContain(run);
  });

  it('a run is a run of its share’s own team: the share and the team are one foreign key', async () => {
    const { shareId } = await seedShare(ENG);
    expect(await code(seedRun(shareId, { team: MARKETING }))).toBe('23503');
  });
});

describe('what the request role can never do', () => {
  it('write a share or a link', async () => {
    const { shareId } = await seedShare();
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name) VALUES ($1, $2, 'mine', 'x')`, [omar.workspaceId, ENG])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.memory_shares SET approval = 'auto', auto_allowed = true WHERE id = $1`, [shareId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.memory_share_links SET state = 'accepted', accepted_at = now() WHERE share_id = $1`, [shareId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.memory_shares WHERE id = $1', [shareId])))).toBe('42501');
  });

  it('change or delete a run, whoever asks', async () => {
    const { shareId } = await seedShare();
    const run = await seedRun(shareId, { state: 'empty' });
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.memory_share_runs SET state = 'ready' WHERE id = $1`, [run])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.memory_share_runs WHERE id = $1', [run])))).toBe('42501');
  });

  it('read the digest’s files, by name or with a star; everything else of a run is readable to a manager', async () => {
    const { shareId } = await seedShare();
    const run = await seedRun(shareId, { state: 'ready' });
    expect(await code(as(omar, (tx) => tx.query('SELECT bundle FROM app.memory_share_runs WHERE id = $1', [run])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT * FROM app.memory_share_runs WHERE id = $1', [run])))).toBe('42501');
    const row = await as(omar, async (tx) => (await tx.query<{ digest_sha: string; manifest: Record<string, string> }>('SELECT digest_sha, manifest FROM app.memory_share_runs WHERE id = $1', [run])).rows[0]);
    expect(row?.digest_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.manifest).toEqual({ 'memory/a.md': 'a'.repeat(40) });
    const files = await sys(async (tx) => (await tx.query<{ bundle: Record<string, string> }>('SELECT bundle FROM app.memory_share_runs WHERE id = $1', [run])).rows[0]?.bundle);
    expect(files).toEqual({ 'digest.md': 'x' });
  });
});

describe('starting a run', () => {
  it('lets a lead or admin start one, as themselves, in the first state', async () => {
    const { shareId } = await seedShare();
    await expect(start(omar, shareId)).resolves.toBeDefined();
  });

  it('refuses a member, a person from another team, and a run made in somebody else’s name', async () => {
    const { shareId } = await seedShare();
    expect(await code(start(nadia, shareId))).toBe('42501');
    expect(await code(start(sameera, shareId))).toBe('42501');
    expect(await code(start(tariq, shareId))).toBe('42501');
    expect(await code(start(omar, shareId, { by: nadia.actorId }))).toBe('42501');
  });

  it('refuses a run that begins anywhere but the beginning, or by the schedule', async () => {
    const { shareId } = await seedShare();
    expect(await code(start(omar, shareId, { state: 'ready' }))).toBe('42501');
    expect(await code(start(omar, shareId, { state: 'sent' }))).toBe('42501');
    expect(await code(start(omar, shareId, { trigger: 'schedule' }))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode, requested_by, bundle) VALUES ($1, $2, $3, 'manual', 'building', 'summary', $4, '{}'::jsonb)`, [omar.workspaceId, ENG, shareId, omar.actorId])))).toBe('42501');
  });

  it('the route’s own statement (conflict-tolerant, returning what the role may read) works for a manager', async () => {
    const { shareId } = await seedShare();
    const sql = `INSERT INTO app.memory_share_runs AS r (workspace_id, team_id, share_id, trigger_kind, state, mode, requested_by) VALUES ($1, $2, $3, 'manual', 'building', 'summary', $4)
                 ON CONFLICT DO NOTHING RETURNING r.id, r.state, r.requested_by`;
    const insert = (): Promise<unknown[]> => as(omar, async (tx) => (await tx.query(sql, [omar.workspaceId, ENG, shareId, omar.actorId])).rows);
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);
  });

  it('one digest of a share is built at a time', async () => {
    const { shareId } = await seedShare();
    await start(omar, shareId);
    expect(await code(start(omar, shareId))).toBe('23505');
    expect(await code(seedRun(shareId))).toBe('23505');
    // once it is finished, the next can begin
    await sys((tx) => tx.query(`UPDATE app.memory_share_runs SET state = 'empty' WHERE share_id = $1`, [shareId]));
    await expect(start(omar, shareId)).resolves.toBeDefined();
  });
});

describe('the shape the database keeps', () => {
  it('a run that waits for approval, is ready or was sent has its digest', async () => {
    const { shareId } = await seedShare();
    for (const state of ['awaiting_approval', 'ready', 'sent']) {
      expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode, sent_at) VALUES ($1, $2, $3, 'manual', $4, 'summary', now())`, [omar.workspaceId, ENG, shareId, state]))), state).toBe('23514');
    }
  });

  it('a sent run says when, a link that was accepted says when, a share is not sent to its own team', async () => {
    const { shareId } = await seedShare();
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode, digest_sha, bundle, manifest) VALUES ($1, $2, $3, 'manual', 'sent', 'summary', $4, '{}'::jsonb, '{}'::jsonb)`, [omar.workspaceId, ENG, shareId, sha(1)])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`UPDATE app.memory_share_links SET state = 'accepted' WHERE share_id = $1`, [shareId])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_share_links (workspace_id, team_id, share_id, dest_team_id, dest_slug) VALUES ($1, $2, $3, $2, 'engineering')`, [omar.workspaceId, ENG, shareId])))).toBe('23514');
  });

  it('keeps names, states and hashes meaningful', async () => {
    const bad = (sql: string, params: unknown[]): Promise<string | undefined> => code(sys((tx) => tx.query(sql, params)));
    expect(await bad(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name) VALUES ($1, $2, 'Not A Slug', 'x')`, [omar.workspaceId, ENG])).toBe('23514');
    expect(await bad(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name) VALUES ($1, $2, 'ok-slug', '')`, [omar.workspaceId, ENG])).toBe('23514');
    expect(await bad(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name, mode) VALUES ($1, $2, 'ok-slug', 'x', 'everything')`, [omar.workspaceId, ENG])).toBe('23514');
    expect(await bad(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name, definition_sha) VALUES ($1, $2, 'ok-slug', 'x', 'nope')`, [omar.workspaceId, ENG])).toBe('23514');
    const { shareId } = await seedShare();
    expect(await bad(`INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode) VALUES ($1, $2, $3, 'manual', 'mystery', 'summary')`, [omar.workspaceId, ENG, shareId])).toBe('23514');
    expect(await bad(`INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode, period) VALUES ($1, $2, $3, 'manual', 'empty', 'summary', '../x')`, [omar.workspaceId, ENG, shareId])).toBe('23514');
  });

  it('one share name per team, one link per share and destination', async () => {
    const { shareId, slug } = await seedShare();
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, 'again')`, [omar.workspaceId, ENG, slug])))).toBe('23505');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_share_links (workspace_id, team_id, share_id, dest_team_id, dest_slug) VALUES ($1, $2, $3, $4, 'customer-support')`, [omar.workspaceId, ENG, shareId, SUPPORT])))).toBe('23505');
  });
});

describe('the digest approval doors', () => {
  const request = (runId: string, requester: Persona, approvers: string[]): Promise<string> =>
    sys(async (tx) => (await tx.query<{ id: string }>('SELECT app.memory_share_request_approval($1::uuid, $2::uuid, $3, $4::jsonb, $5::text[]) AS id', [runId, requester.actorId, 'Send release notes', JSON.stringify({ share: 'x' }), approvers])).rows[0]!.id);
  const approvalOf = (id: string): Promise<Record<string, unknown>> =>
    sys(async (tx) => (await tx.query('SELECT source, tool, status, outcome, summary, resume, approver_scope, requester_id, bot_id, run_id, channel_id FROM app.approvals WHERE id = $1', [id])).rows[0] as Record<string, unknown>);

  it('files an Approvals row of source grant and tool memory.digest.send for a built digest, and only for the system role', async () => {
    const { shareId } = await seedShare();
    const run = await seedRun(shareId, { withDigest: true });
    expect(await code(as(omar, (tx) => tx.query('SELECT app.memory_share_request_approval($1::uuid, $2::uuid, $3, $4::jsonb, $5::text[])', [run, omar.actorId, 's', '{}', ['role:lead']])))).toBe('42501');
    const id = await request(run, omar, ['role:lead']);
    const row = await approvalOf(id);
    expect(row).toMatchObject({ source: 'grant', tool: 'memory.digest.send', status: 'pending', outcome: 'none', requester_id: omar.actorId, bot_id: null, run_id: null, channel_id: null });
    expect(row['approver_scope']).toEqual({ roles: [], people: [], leads: true });
    expect(row['resume']).toMatchObject({ kind: 'handoff', payload: { op: 'memory_digest_send', runId: run } });
    const linked = await sys(async (tx) => (await tx.query<{ approval_id: string }>('SELECT approval_id FROM app.memory_share_runs WHERE id = $1', [run])).rows[0]?.approval_id);
    expect(linked).toBe(id);
    // asking again for the same run is the same approval
    expect(await request(run, omar, ['role:lead'])).toBe(id);
  });

  it('turns the share’s approvers into the approval’s scope', async () => {
    const { shareId } = await seedShare();
    const run = await seedRun(shareId, { withDigest: true });
    const id = await request(run, omar, ['role:on-call', `person:${nadia.personId}`]);
    expect((await approvalOf(id))['approver_scope']).toEqual({ roles: ['role:on-call'], people: [nadia.personId], leads: false });
  });

  it('refuses a run with no digest, a run that is not building, and a requester from nowhere', async () => {
    const { shareId } = await seedShare();
    const bare = await seedRun(shareId);
    expect(await code(request(bare, omar, ['role:lead']))).toBe('55000');
    const waiting = await seedRun(shareId, { state: 'empty' });
    expect(await code(request(waiting, omar, ['role:lead']))).toBe('55000');
    const run = await seedRun(shareId, { withDigest: true, state: 'building' }).catch(() => null);
    if (run !== null) expect(await code(sys((tx) => tx.query('SELECT app.memory_share_request_approval($1::uuid, $2::uuid, $3, $4::jsonb, $5::text[])', [run, '00000000-0000-7000-8000-00000000dead', 's', '{}', ['role:lead']])))).toBe('23503');
  });

  it('settles a run when its approval is decided: approved makes it ready and finishes the approval, denied makes it denied', async () => {
    const decide = (p: Persona, id: string, decision: string): Promise<unknown> => as(p, (tx) => tx.query('SELECT app.approvals_decide($1, $2, $3)', [id, decision, 'ok']));
    const settle = (id: string, decision: string): Promise<Array<Record<string, unknown>>> => sys(async (tx) => (await tx.query('SELECT * FROM app.memory_share_settle($1::uuid, $2)', [id, decision])).rows as Array<Record<string, unknown>>);
    const runState = (id: string): Promise<{ state: string; settled_by: string | null }> => sys(async (tx) => (await tx.query<{ state: string; settled_by: string | null }>('SELECT state, settled_by FROM app.memory_share_runs WHERE id = $1', [id])).rows[0]!);

    const { shareId } = await seedShare();
    const run = await seedRun(shareId, { withDigest: true });
    const id = await request(run, omar, [`person:${nadia.personId}`]);
    await sys((tx) => tx.query(`UPDATE app.memory_share_runs SET state = 'awaiting_approval' WHERE id = $1`, [run]));
    // nothing decided yet: settling does nothing
    expect(await settle(id, 'approved')).toEqual([]);
    expect(await code(decide(omar, id, 'approved'))).toBe('42501'); // the requester can never
    expect(await code(decide(rafi, id, 'approved'))).toBe('42501'); // not named
    await decide(nadia, id, 'approved');
    // the request role cannot settle; the decision must match what was decided
    expect(await code(as(nadia, (tx) => tx.query('SELECT * FROM app.memory_share_settle($1::uuid, $2)', [id, 'approved'])))).toBe('42501');
    expect(await settle(id, 'denied')).toEqual([]);
    const moved = await settle(id, 'approved');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ o_run_id: run, o_share_id: shareId, o_team_id: ENG, o_outcome: 'ready', o_decider: nadia.actorId });
    expect(await runState(run)).toEqual({ state: 'ready', settled_by: nadia.actorId });
    // an approved hand-back that nothing resumes must not be called "never started" by the sweep
    expect(await approvalOf(id)).toMatchObject({ status: 'approved', outcome: 'ran' });
    // once only
    expect(await settle(id, 'approved')).toEqual([]);

    const run2 = await seedRun(shareId, { withDigest: true });
    const id2 = await request(run2, omar, [`person:${nadia.personId}`]);
    await sys((tx) => tx.query(`UPDATE app.memory_share_runs SET state = 'awaiting_approval' WHERE id = $1`, [run2]));
    await decide(nadia, id2, 'denied');
    expect((await settle(id2, 'denied'))[0]).toMatchObject({ o_run_id: run2, o_outcome: 'denied' });
    expect((await runState(run2)).state).toBe('denied');
    expect(await approvalOf(id2)).toMatchObject({ status: 'denied', outcome: 'none' });
  });

  it('does not touch an approval that is not a digest’s', async () => {
    const other = await sys(async (tx) => {
      const res = await tx.query<{ id: string }>('SELECT app.approvals_request_task($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8) AS id', [
        omar.workspaceId,
        ENG,
        nadia.actorId,
        'dispatch',
        'tasks.handoff',
        'Hand off',
        JSON.stringify({ kind: 'handoff' }),
        `rls-${counter}`,
      ]);
      return res.rows[0]!.id;
    });
    await as(omar, (tx) => tx.query('SELECT app.approvals_decide($1, $2, $3)', [other, 'approved', 'ok']));
    expect(await sys(async (tx) => (await tx.query('SELECT * FROM app.memory_share_settle($1::uuid, $2)', [other, 'approved'])).rows)).toEqual([]);
  });
});

describe('who may switch a review off', () => {
  const asPlugin = (fn: (tx: PluginTx) => Promise<boolean>): Promise<boolean> => sys((tx) => fn(tx as unknown as PluginTx));

  it('an active lead of the team or a workspace owner or admin may; a member, a person of another team, a bot-less nobody may not', async () => {
    expect(await asPlugin((tx) => mayAutoApprove(tx, ENG, omar.actorId))).toBe(true);
    expect(await asPlugin((tx) => mayAutoApprove(tx, ENG, nadia.actorId))).toBe(false);
    expect(await asPlugin((tx) => mayAutoApprove(tx, ENG, sameera.actorId))).toBe(false);
    expect(await asPlugin((tx) => mayAutoApprove(tx, ENG, null))).toBe(false);
    // a lead of another team is not a lead of this one
    expect(await asPlugin((tx) => mayAutoApprove(tx, ENG, tariq.actorId))).toBe(false);
    expect(await asPlugin((tx) => mayAutoApprove(tx, MARKETING, tariq.actorId))).toBe(true);
    expect(await asPlugin((tx) => isWorkspaceAdmin(tx, omar.actorId))).toBe(true);
    expect(await asPlugin((tx) => isWorkspaceAdmin(tx, tariq.actorId))).toBe(false);
  });

  it('a suspended person may not, though they still hold the role', async () => {
    await sys((tx) => tx.query(`UPDATE app.people SET status = 'suspended' WHERE id = $1`, [tariq.personId]));
    try {
      expect(await asPlugin((tx) => mayAutoApprove(tx, MARKETING, tariq.actorId))).toBe(false);
    } finally {
      await sys((tx) => tx.query(`UPDATE app.people SET status = 'active' WHERE id = $1`, [tariq.personId]));
    }
    expect(await asPlugin((tx) => mayAutoApprove(tx, MARKETING, tariq.actorId))).toBe(true);
  });
});

describe('policy hygiene', () => {
  it('has no policy that evaluates a function per row, and every table is forced', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of ['memory_shares', 'memory_share_links', 'memory_share_runs']) expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

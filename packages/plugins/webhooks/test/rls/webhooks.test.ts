import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  webhooksMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P14-14: who may see a webhook, who may make, rotate and revoke one, and that nobody on the request role can read the secret hash.

const { omar, nadia, rafi, tariq, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let engChannel = '';
let engHook = '';
let mktChannel = '';
let mktHook = '';
const hash = (n: number): Buffer => Buffer.alloc(32, n);

const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const names = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ name: string }>('SELECT name FROM app.webhooks ORDER BY name')).rows.map((r) => r.name));
const make = (p: Persona, channel: string, name: string, n: number): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ id: string }>('SELECT app.webhooks_create($1::uuid, $2, NULL, $3) AS id', [channel, name, hash(n)])).rows[0]!.id);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, webhooksMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  const ids = await sys(async (tx) => {
    const channel = async (team: string, name: string): Promise<string> => {
      const t = await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE name = $1', [team]);
      const c = await tx.query<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, team_id, kind, name, created_by) VALUES ($1, $2, 'channel', $3, $4) RETURNING id`,
        [omar.workspaceId, t.rows[0]!.id, name, omar.actorId],
      );
      return c.rows[0]!.id;
    };
    return { eng: await channel('Engineering', `hooks-${randomUUID().slice(0, 8)}`), mkt: await channel('Marketing', `hooks-${randomUUID().slice(0, 8)}`) };
  });
  engChannel = ids.eng;
  mktChannel = ids.mkt;
  engHook = await make(omar, engChannel, 'ci', 1);
  mktHook = await make(tariq, mktChannel, 'campaign', 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('webhooks and webhook_secrets (P14-14)', () => {
  it('passes the RLS harness and reads without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['webhooks', 'webhook_secrets']) expect(await findPerRowPolicyCalls(admin, table), `per-row calls in ${table}`).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('a lead sees the webhooks of the team and a workspace owner sees all; members, other teams and guests see none', async () => {
    expect(await names(omar)).toEqual(['campaign', 'ci']);
    expect(await names(tariq)).toEqual(['campaign']);
    expect(await names(nadia)).toEqual([]);
    expect(await names(rafi)).toEqual([]);
    expect(await names(lena)).toEqual([]);
  });

  it('nobody on the request role reads the secret hash or writes either table', async () => {
    expect(await code(as(omar, (tx) => tx.query('SELECT secret_hash FROM app.webhook_secrets')))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT webhook_id FROM app.webhook_secrets')))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.webhooks SET name = 'x' WHERE id = $1`, [engHook])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`DELETE FROM app.webhooks WHERE id = $1`, [engHook])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.webhooks (workspace_id, team_id, channel_id, actor_id, name, created_by) SELECT workspace_id, team_id, id, created_by, 'x', created_by FROM app.channels LIMIT 1`)))).toBe('42501');
  });

  it('only a lead (or an owner) can make a webhook; a member or another team\'s lead cannot', async () => {
    expect(await code(make(nadia, engChannel, 'by-member', 3))).toBe('42501');
    expect(await code(make(tariq, engChannel, 'by-other-lead', 4))).toBe('42501');
    expect(await code(make(lena, engChannel, 'by-guest', 5))).toBe('42501');
    expect(await code(make(omar, engChannel, 'by-owner', 6))).toBeUndefined();
  });

  it('refuses a name already in use in the channel, ignoring case', async () => {
    expect(await code(make(omar, engChannel, 'CI', 7))).toBe('23505');
  });

  it('only a lead can rotate or revoke, and a revoked webhook is gone from the lead\'s view', async () => {
    expect(await code(as(nadia, (tx) => tx.query('SELECT app.webhooks_rotate($1::uuid, $2)', [engHook, hash(9)])))).toBeDefined();
    expect(await code(as(tariq, (tx) => tx.query('SELECT app.webhooks_revoke($1::uuid)', [engHook])))).toBeDefined();
    expect(await code(as(omar, (tx) => tx.query('SELECT app.webhooks_rotate($1::uuid, $2)', [engHook, hash(9)])))).toBeUndefined();
    const stored = await sys(async (tx) => (await tx.query<{ secret_hash: Buffer }>('SELECT secret_hash FROM app.webhook_secrets WHERE webhook_id = $1', [engHook])).rows[0]!.secret_hash);
    expect(stored.equals(hash(9))).toBe(true);
    expect(await code(as(tariq, (tx) => tx.query('SELECT app.webhooks_revoke($1::uuid)', [mktHook])))).toBeUndefined();
    const live = await as(tariq, async (tx) => (await tx.query<{ name: string }>('SELECT name FROM app.webhooks WHERE revoked_at IS NULL')).rows.map((r) => r.name));
    expect(live).not.toContain('campaign');
    const left = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.webhook_secrets WHERE webhook_id = $1', [mktHook])).rowCount);
    expect(left).toBe(0);
  });

  it('acting as a webhook is for the system role only', async () => {
    expect(await code(as(omar, (tx) => tx.query('SELECT app.webhooks_act_as($1::uuid)', [engHook])))).toBe('42501');
    expect(await code(sys((tx) => tx.query('SELECT app.webhooks_act_as($1::uuid)', [engHook])))).toBeUndefined();
  });

  it('each webhook gets its own system-kind actor, never a person', async () => {
    const kinds = await sys(async (tx) => (await tx.query<{ kind: string }>('SELECT a.kind FROM app.webhooks w JOIN app.actors a ON a.id = w.actor_id')).rows.map((r) => r.kind));
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set(['system']));
  });
});

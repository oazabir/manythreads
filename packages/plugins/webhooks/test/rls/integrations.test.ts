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

// P14-14: the tables of API tokens and outgoing webhooks. A team's leads (and workspace admins) read them, nobody on the request role writes them, and
// the delivery record is for the system role only. The definer function that makes a token or an outgoing hook checks the caller.

const { omar, nadia, rafi, tariq, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let engChannel = '';
let engChannel2 = '';
let mktChannel = '';
let tokenId = '';
let hookId = '';
let mktTokenId = '';
const hash = (n: number): Buffer => Buffer.alloc(32, n);

const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const count = (p: Persona, table: string): Promise<number> => as(p, async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0]!.n);
const makeToken = (p: Persona, channel: string, name: string, n: number, scopes = ['chat.postMessage'], more: string[] = []): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ id: string }>(`SELECT app.integrations_create('api', $1::uuid, $2, NULL, $3, $4::text[], $5::uuid[], NULL, NULL, NULL, NULL) AS id`, [channel, name, hash(n), scopes, more])).rows[0]!.id);
const makeHook = (p: Persona, channel: string, name: string): Promise<string> =>
  as(p, async (tx) =>
    (await tx.query<{ id: string }>(`SELECT app.integrations_create('outgoing', $1::uuid, $2, NULL, NULL, NULL, NULL, 'https://example.com/in', ARRAY['deploy']::text[], 'starts', $3) AS id`, [channel, name, randomUUID().replaceAll('-', '')])).rows[0]!.id,
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, webhooksMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  const ids = await sys(async (tx) => {
    const channel = async (team: string, name: string): Promise<string> => {
      const t = await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE name = $1', [team]);
      const c = await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, kind, name, created_by) VALUES ($1, $2, 'channel', $3, $4) RETURNING id`, [omar.workspaceId, t.rows[0]!.id, name, omar.actorId]);
      return c.rows[0]!.id;
    };
    return { eng: await channel('Engineering', `int-${randomUUID().slice(0, 8)}`), eng2: await channel('Engineering', `int-${randomUUID().slice(0, 8)}`), mkt: await channel('Marketing', `int-${randomUUID().slice(0, 8)}`) };
  });
  engChannel = ids.eng;
  engChannel2 = ids.eng2;
  mktChannel = ids.mkt;
  tokenId = await makeToken(omar, engChannel, 'deploy script', 1, ['chat.postMessage', 'reactions.add'], [engChannel2]);
  hookId = await makeHook(omar, engChannel, 'deploy hook');
  mktTokenId = await makeToken(tariq, mktChannel, 'campaign script', 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('webhook_api, webhook_channels, webhook_outgoing, webhook_deliveries (P14-14)', () => {
  it('passes the RLS harness and reads without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['webhook_api', 'webhook_channels', 'webhook_outgoing', 'webhook_deliveries']) expect(await findPerRowPolicyCalls(admin, table), `per-row calls in ${table}`).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('a team\'s lead sees its tokens, channels and hooks; an owner sees all; members, other teams and guests see none', async () => {
    for (const table of ['webhook_api', 'webhook_channels', 'webhook_outgoing']) {
      const total = await sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0]!.n);
      expect(await count(omar, table), table).toBe(total);
      expect(await count(nadia, table), table).toBe(0);
      expect(await count(rafi, table), table).toBe(0);
      expect(await count(lena, table), table).toBe(0);
    }
    expect(await count(tariq, 'webhook_api')).toBe(1);
    expect(await count(tariq, 'webhook_outgoing')).toBe(0);
    expect(await count(omar, 'webhook_channels')).toBe(3); // the Engineering token reaches two channels, the Marketing token one; a hook has none
  });

  it('the delivery record has no privilege for the request role', async () => {
    expect(await code(as(omar, (tx) => tx.query('SELECT 1 FROM app.webhook_deliveries')))).toBe('42501');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.webhook_deliveries (webhook_id, message_id, workspace_id, status) VALUES ($1, $2, $3, 'retrying')`, [hookId, randomUUID(), omar.workspaceId])))).toBeUndefined();
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.webhook_deliveries')).rowCount)).toBe(1);
  });

  it('nobody on the request role writes the tables', async () => {
    for (const sql of [
      `UPDATE app.webhook_api SET scopes = ARRAY['chat.update']::text[] WHERE webhook_id = '${tokenId}'`,
      `DELETE FROM app.webhook_api WHERE webhook_id = '${tokenId}'`,
      `UPDATE app.webhook_channels SET position = 5 WHERE webhook_id = '${tokenId}'`,
      `DELETE FROM app.webhook_channels WHERE webhook_id = '${tokenId}'`,
      `UPDATE app.webhook_outgoing SET url = 'https://evil.example/' WHERE webhook_id = '${hookId}'`,
      `DELETE FROM app.webhook_outgoing WHERE webhook_id = '${hookId}'`,
      `UPDATE app.webhooks SET kind = 'incoming' WHERE id = '${tokenId}'`,
    ]) {
      expect(await code(as(omar, (tx) => tx.query(sql))), sql).toBe('42501');
    }
  });

  it('the token hash cannot be read by the request role, and the lookup index exists', async () => {
    expect(await code(as(omar, (tx) => tx.query('SELECT secret_hash FROM app.webhook_secrets')))).toBe('42501');
    const idx = await sys(async (tx) => (await tx.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'app' AND indexname = 'webhook_secrets_hash'`)).rowCount);
    expect(idx).toBe(1);
    const stored = await sys(async (tx) => (await tx.query<{ secret_hash: Buffer }>('SELECT secret_hash FROM app.webhook_secrets WHERE webhook_id = $1', [tokenId])).rows[0]!.secret_hash);
    expect(stored.equals(hash(1))).toBe(true);
  });

  it('only a lead of the channel\'s team or an owner can make a token or a hook', async () => {
    expect(await code(makeToken(nadia, engChannel, 'by member', 3))).toBe('42501');
    expect(await code(makeToken(tariq, engChannel, 'by other lead', 4))).toBe('42501');
    expect(await code(makeToken(lena, engChannel, 'by guest', 5))).toBe('42501');
    expect(await code(makeHook(nadia, engChannel, 'by member'))).toBe('42501');
    expect(await code(makeHook(tariq, engChannel, 'by other lead'))).toBe('42501');
  });

  it('an outgoing hook also needs a maker who can read the channel: a lead who is not in a private channel is refused, a token is not', async () => {
    const priv = await sys(async (tx) => {
      const t = await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE name = $1', ['Engineering']);
      const c = await tx.query<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, team_id, kind, name, private, created_by) VALUES ($1, $2, 'channel', $3, true, $4) RETURNING id`,
        [omar.workspaceId, t.rows[0]!.id, `priv-${randomUUID().slice(0, 8)}`, omar.actorId],
      );
      return c.rows[0]!.id;
    });
    expect(await code(makeHook(omar, priv, 'unreadable'))).toBe('42501');
    // an API token only writes, so it stays with the lead; a member of the channel can read it and may make the hook
    expect(await code(makeToken(omar, priv, 'writer', 30))).toBeUndefined();
    await sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [priv, omar.personId]));
    expect(await code(makeHook(omar, priv, 'readable'))).toBeUndefined();
  });

  it('a token reaches channels of its own team only, and never an unknown channel', async () => {
    expect(await code(makeToken(omar, engChannel, 'cross team', 6, ['chat.postMessage'], [mktChannel]))).toBe('23514');
    expect(await code(makeToken(omar, engChannel, 'ghost', 7, ['chat.postMessage'], [randomUUID()]))).toBeDefined();
    // an unknown channel gets the same refusal as one the caller may not manage: nothing tells whether it exists
    expect(await code(makeToken(omar, randomUUID(), 'no channel', 8))).toBe('42501');
  });

  it('checks the shape: a hash of 32 bytes, known methods, and a bounded list of trigger words', async () => {
    expect(await code(as(omar, (tx) => tx.query(`SELECT app.integrations_create('api', $1::uuid, 'short', NULL, $2, ARRAY['chat.postMessage']::text[], ARRAY[]::uuid[], NULL, NULL, NULL, NULL)`, [engChannel, Buffer.alloc(5)])))).toBe('22000');
    expect(await code(makeToken(omar, engChannel, 'bad scope', 9, ['chat.delete']))).toBe('23514');
    expect(await code(makeToken(omar, engChannel, 'no scope', 10, []))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`SELECT app.integrations_create('outgoing', $1::uuid, 'many', NULL, NULL, NULL, NULL, 'https://example.com/in', ARRAY['1','2','3','4','5','6','7','8','9','10','11']::text[], 'starts', 'abcdefabcdefabcdef')`, [engChannel])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`SELECT app.integrations_create('incoming', $1::uuid, 'wrong kind', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, [engChannel])))).toBe('22000');
  });

  it('a channel holds at most 20 integrations of all kinds together', async () => {
    const channel = await sys(async (tx) => {
      const t = await tx.query<{ id: string }>(`SELECT id FROM app.teams WHERE name = 'Engineering'`);
      return (await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, kind, name, created_by) VALUES ($1, $2, 'channel', $3, $4) RETURNING id`, [omar.workspaceId, t.rows[0]!.id, `full-${randomUUID().slice(0, 8)}`, omar.actorId])).rows[0]!.id;
    });
    for (let i = 0; i < 10; i += 1) await makeToken(omar, channel, `t${i}`, 20 + i);
    for (let i = 0; i < 10; i += 1) await makeHook(omar, channel, `h${i}`);
    expect(await code(makeToken(omar, channel, 'one too many', 40))).toBe('23514');
    expect(await code(makeHook(omar, channel, 'one too many'))).toBe('23514');
  });

  it('rotate and revoke by a lead work on a token; another team\'s lead and a member cannot', async () => {
    expect(await code(as(tariq, (tx) => tx.query('SELECT app.webhooks_rotate($1::uuid, $2)', [tokenId, hash(50)])))).toBeDefined();
    expect(await code(as(nadia, (tx) => tx.query('SELECT * FROM app.webhooks_revoke($1::uuid)', [tokenId])))).toBeDefined();
    expect(await code(as(omar, (tx) => tx.query('SELECT app.webhooks_rotate($1::uuid, $2)', [tokenId, hash(50)])))).toBeUndefined();
    const stored = await sys(async (tx) => (await tx.query<{ secret_hash: Buffer }>('SELECT secret_hash FROM app.webhook_secrets WHERE webhook_id = $1', [tokenId])).rows[0]!.secret_hash);
    expect(stored.equals(hash(50))).toBe(true);
    expect(await code(as(tariq, (tx) => tx.query('SELECT * FROM app.webhooks_revoke($1::uuid)', [mktTokenId])))).toBeUndefined();
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.webhook_secrets WHERE webhook_id = $1', [mktTokenId])).rowCount)).toBe(0);
  });

  it('each integration gets its own system-kind actor, never a person', async () => {
    const kinds = await sys(async (tx) => (await tx.query<{ kind: string }>(`SELECT a.kind FROM app.webhooks w JOIN app.actors a ON a.id = w.actor_id WHERE w.kind IN ('api', 'outgoing')`)).rows.map((r) => r.kind));
    expect(kinds.length).toBeGreaterThanOrEqual(3);
    expect(new Set(kinds)).toEqual(new Set(['system']));
  });

  it('deleting an integration removes its rows in the satellite tables', async () => {
    const id = await makeHook(omar, engChannel2, 'to delete');
    await sys((tx) => tx.query(`INSERT INTO app.webhook_deliveries (webhook_id, message_id, workspace_id, status) VALUES ($1, $2, $3, 'dead')`, [id, randomUUID(), omar.workspaceId]));
    await sys((tx) => tx.query('DELETE FROM app.webhooks WHERE id = $1', [id]));
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.webhook_outgoing WHERE webhook_id = $1', [id])).rowCount)).toBe(0);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.webhook_deliveries WHERE webhook_id = $1', [id])).rowCount)).toBe(0);
  });
});

import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  webhooksMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Bundle D, webhooks 0004 (pnpm test:rls): an endpoint that an outside app calls. A team's leads and workspace admins make and read it, nobody on the request role writes the tables, the
// deliveries and the run latch are the system role's alone, a repeat delivery never starts a second run, and the origin card is shown to people who read the channel only.

const { omar, nadia, rafi, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let engChannel = '';
let engPrivate = '';
let mktChannel = '';
let botId = '';
let hookId = '';
let eventId = '';
const runIds: string[] = [];

const make = (p: Persona, channel: string, provider = 'github', slug = 'github-main', filter: string[] = []): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ id: string }>('SELECT app.integrations_create_provider($1, $2, NULL, $3, $4, $5::text[]) AS id', [channel, `Hook ${slug}`, provider, slug, filter])).rows[0]!.id);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, webhooksMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    const ch = async (team: string, name: string, priv: boolean): Promise<string> =>
      (await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, kind, name, private, created_by) VALUES ($1, $2, 'channel', $3, $4, $5) RETURNING id`, [omar.workspaceId, team, name, priv, omar.actorId])).rows[0]!.id;
    engChannel = await ch(ENG, 'pe-eng', false);
    engPrivate = await ch(ENG, 'pe-eng-private', true);
    mktChannel = await ch(TEAM_IDS.Marketing, 'pe-mkt', false);
    await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [engPrivate, omar.personId]);
    botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
         VALUES ($1, $2, 'pe-helper', 'helper', 'Helps', 'agent', 'hermes', 'team', $3, 'active', '{"runner": "default"}') RETURNING id`,
        [omar.workspaceId, ENG, 'a'.repeat(64)],
      )
    ).rows[0]!.id;
  });
  hookId = await make(omar, engChannel);
  eventId = await sys(async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.webhook_provider_events (workspace_id, team_id, webhook_id, provider, delivery_key, kind, title, url, actor_label, payload)
         VALUES ($1, $2, $3, 'github', 'delivery-abcdef123456', 'issue.opened', 'Build is red', 'https://example.test/1', 'someone', '{}') RETURNING id`,
        [omar.workspaceId, ENG, hookId],
      )
    ).rows[0]!.id,
  );
  for (let i = 0; i < 2; i++) {
    runIds.push(
      await sys(async (tx) =>
        (await tx.query<{ id: string }>(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, channel_id, status) VALUES ($1, $2, $3, 'webhook', $4, 'running') RETURNING id`, [omar.workspaceId, botId, ENG, engChannel])).rows[0]!.id,
      ),
    );
  }
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the new tables pass the RLS harness', () => {
  it('forced RLS, a rls: comment, and the right privileges', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const rows = (
        await admin.query<{ relname: string; force: boolean; comment: string | null; app_select: boolean; app_write: boolean }>(
          `SELECT c.relname, c.relforcerowsecurity AS force, obj_description(c.oid) AS comment,
                  has_table_privilege('manythreads_app', c.oid, 'SELECT') AS app_select,
                  has_table_privilege('manythreads_app', c.oid, 'INSERT') OR has_table_privilege('manythreads_app', c.oid, 'UPDATE') OR has_table_privilege('manythreads_app', c.oid, 'DELETE') AS app_write
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'app' AND c.relname IN ('webhook_provider', 'webhook_provider_events', 'webhook_provider_runs') ORDER BY 1`,
        )
      ).rows;
      expect(rows.map((r) => r.relname)).toEqual(['webhook_provider', 'webhook_provider_events', 'webhook_provider_runs']);
      for (const r of rows) {
        expect(r.force, r.relname).toBe(true);
        expect(r.comment ?? '', r.relname).toMatch(/^rls: /);
        expect(r.app_write, r.relname).toBe(false);
      }
      expect(rows.map((r) => r.app_select)).toEqual([true, false, false]);
    } finally {
      await admin.end();
    }
  });
});

describe('making an endpoint', () => {
  it('a workspace admin and a team lead make one; a plain member, a lead of another team and a guest are refused', async () => {
    expect(await code(make(nadia, engChannel, 'github', 'by-nadia'))).toBe('42501');
    expect(await code(make(rafi, engChannel, 'github', 'by-rafi'))).toBe('42501');
    expect(await code(make(tariq, engChannel, 'github', 'by-tariq'))).toBe('42501');
    expect(await code(make(lena, engChannel, 'github', 'by-lena'))).toBe('42501');
    const id = await make(tariq, mktChannel, 'zendesk', 'support');
    expect(id).toBeTruthy();
  });

  it('the lead of a private channel they are not in is told to join first', async () => {
    expect(await code(make(tariq, engPrivate, 'github', 'sneaky'))).toBe('42501');
  });

  it('an unknown service, a bad short name and a duplicate live short name are refused; a revoked name can be used again', async () => {
    expect(await code(make(omar, engChannel, 'bitbucket', 'bb'))).toBe('23514');
    expect(await code(make(omar, engChannel, 'github', 'Bad Name'))).toBe('23514');
    expect(await code(make(omar, engChannel, 'github', 'github-main'))).toBe('23505');
    const second = await make(omar, engChannel, 'gitlab', 'gl');
    await q(omar, 'SELECT * FROM app.webhooks_revoke($1)', [second]);
    expect(await make(omar, engChannel, 'gitlab', 'gl')).toBeTruthy();
  });

  it('the endpoint is a provider-kind integration of the channel with its own system actor', async () => {
    const [row] = await q<{ kind: string; provider: string; slug: string }>(omar, 'SELECT w.kind, p.provider, p.slug FROM app.webhooks w JOIN app.webhook_provider p ON p.webhook_id = w.id WHERE w.id = $1', [hookId]);
    expect(row).toEqual({ kind: 'provider', provider: 'github', slug: 'github-main' });
  });
});

describe('reading and writing endpoints', () => {
  it('leads of the team and admins read them; members, other teams and the guest see none', async () => {
    expect(await q(omar, 'SELECT 1 FROM app.webhook_provider WHERE webhook_id = $1', [hookId])).toHaveLength(1);
    for (const p of [nadia, rafi, lena]) expect(await q(p, 'SELECT 1 FROM app.webhook_provider WHERE webhook_id = $1', [hookId]), p.name).toHaveLength(0);
    expect(await q(tariq, 'SELECT 1 FROM app.webhook_provider WHERE webhook_id = $1', [hookId]), 'tariq').toHaveLength(0);
  });

  it('nobody on the request role writes the table', async () => {
    expect(await code(q(omar, "UPDATE app.webhook_provider SET slug = 'x' WHERE webhook_id = $1", [hookId]))).toBe('42501');
    expect(await code(q(omar, 'DELETE FROM app.webhook_provider WHERE webhook_id = $1', [hookId]))).toBe('42501');
  });

  it('deliveries and the run latch cannot even be named by a person', async () => {
    for (const p of [omar, nadia, lena]) {
      expect(await code(q(p, 'SELECT * FROM app.webhook_provider_events')), p.name).toBe('42501');
      expect(await code(q(p, 'SELECT * FROM app.webhook_provider_runs')), p.name).toBe('42501');
    }
  });

  it('a delivery key repeats as a conflict; a kind has a known shape', async () => {
    const insert = (key: string, kind: string): Promise<unknown> =>
      sys((tx) => tx.query(`INSERT INTO app.webhook_provider_events (workspace_id, team_id, webhook_id, provider, delivery_key, kind) VALUES ($1, $2, $3, 'github', $4, $5)`, [omar.workspaceId, ENG, hookId, key, kind]));
    expect(await code(insert('delivery-abcdef123456', 'issue.opened'))).toBe('23505');
    expect(await code(insert('k2', 'Issue Opened'))).toBe('23514');
    expect(await code(insert('k3', 'pull_request.opened'))).toBeUndefined();
  });
});

describe('the run latch', () => {
  it('refuses the application role and every person', async () => {
    for (const p of [omar, nadia, lena]) expect(await code(q(p, 'SELECT app.webhooks_claim_run($1, $2, $3)', [eventId, botId, runIds[0]])), p.name).toBe('42501');
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const [row] = (await admin.query<{ app: boolean }>("SELECT has_function_privilege('manythreads_app', 'app.webhooks_claim_run(uuid, uuid, uuid)', 'EXECUTE') AS app")).rows;
      expect(row!.app).toBe(false);
    } finally {
      await admin.end();
    }
  });

  it('answers true the first time and false for a repeat or a second run of the same bot; false for an unknown delivery', async () => {
    const claim = (e: string, r: string): Promise<boolean> => sys(async (tx) => (await tx.query<{ c: boolean }>('SELECT app.webhooks_claim_run($1, $2, $3) AS c', [e, botId, r])).rows[0]!.c);
    expect(await claim(eventId, runIds[0]!)).toBe(true);
    expect(await claim(eventId, runIds[0]!)).toBe(false);
    expect(await claim(eventId, runIds[1]!)).toBe(false);
    expect(await claim('00000000-0000-7000-8000-000000000000', runIds[1]!)).toBe(false);
  });
});

describe('the origin of a run', () => {
  it('readers of the channel get the card without the payload; others get nothing', async () => {
    const [row] = await q<Record<string, unknown>>(omar, 'SELECT * FROM app.webhooks_run_origin($1)', [runIds[0]]);
    expect(row).toMatchObject({ provider: 'github', endpoint_name: 'Hook github-main', kind: 'issue.opened', title: 'Build is red', delivery_key: 'delivery' });
    expect(Object.keys(row!)).not.toContain('payload');
    expect(await q(nadia, 'SELECT * FROM app.webhooks_run_origin($1)', [runIds[0]])).toHaveLength(1);
    expect(await q(tariq, 'SELECT * FROM app.webhooks_run_origin($1)', [runIds[0]]), 'a person of another team').toEqual([]);
  });

  it('a run no delivery started has no origin; a person who cannot read the channel gets nothing', async () => {
    expect(await q(omar, 'SELECT * FROM app.webhooks_run_origin($1)', [runIds[1]])).toEqual([]);
    const privHook = await make(omar, engPrivate, 'github', 'private-hook');
    const privRun = await sys(async (tx) => {
      const ev = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.webhook_provider_events (workspace_id, team_id, webhook_id, provider, delivery_key, kind) VALUES ($1, $2, $3, 'github', 'priv-1', 'push') RETURNING id`,
          [omar.workspaceId, ENG, privHook],
        )
      ).rows[0]!.id;
      const run = (await tx.query<{ id: string }>(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, channel_id, status) VALUES ($1, $2, $3, 'webhook', $4, 'running') RETURNING id`, [omar.workspaceId, botId, ENG, engPrivate])).rows[0]!.id;
      await tx.query('SELECT app.webhooks_claim_run($1, $2, $3)', [ev, botId, run]);
      return run;
    });
    expect(await q(omar, 'SELECT * FROM app.webhooks_run_origin($1)', [privRun])).toHaveLength(1);
    expect(await q(nadia, 'SELECT * FROM app.webhooks_run_origin($1)', [privRun])).toEqual([]);
    expect(await q(lena, 'SELECT * FROM app.webhooks_run_origin($1)', [privRun])).toEqual([]);
  });
});

describe('revoking', () => {
  it('hands back the sealed signing secret id, switches the endpoint off and frees its short name', async () => {
    const id = await make(omar, engChannel, 'linear', 'lin');
    const [row] = await q<{ signing_secret_id: string | null }>(omar, 'SELECT * FROM app.webhooks_revoke($1)', [id]);
    expect(row).toEqual({ signing_secret_id: null });
    const [state] = await q<{ live: boolean }>(omar, 'SELECT live FROM app.webhook_provider WHERE webhook_id = $1', [id]);
    expect(state!.live).toBe(false);
    expect(await code(q(nadia, 'SELECT * FROM app.webhooks_revoke($1)', [hookId]))).toBe('42501');
  });
});

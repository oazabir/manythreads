import { createSystemPool, getSecret, putSecret, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginContext } from '@manythreads/sdk';
import {
  botRunnersMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personas,
  runtimeHermesMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveRunner } from '../src/resolve.ts';

// resolveRunner is the one place a runner's name becomes a place to run. It refuses what the admin has not allowed, and answers with the address and key only to
// the server code that calls it. The context here is the two things it needs: the system transaction and the secret reader.

const { omar } = personas;
let db: TestDatabase;
let sysPool: pg.Pool;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
let ctx: PluginContext;
const KEY = 'resolver-key-0123456789abcdef';

const insertRunner = (name: string, fields: { kind: string; enabled?: boolean; allTeams?: boolean; baseUrl?: string; secretId?: string | null; teams?: string[] }): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runners (workspace_id, name, label, kind, enabled, all_teams, base_url, secret_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready') RETURNING id`,
        [omar.workspaceId, name, `Label of ${name}`, fields.kind, fields.enabled ?? true, fields.allTeams ?? false, fields.baseUrl ?? null, fields.secretId ?? null],
      )
    ).rows[0]!.id;
    for (const team of fields.teams ?? []) await tx.query('INSERT INTO app.bot_runner_teams (runner_id, team_id) VALUES ($1, $2)', [id, team]);
    return id;
  });

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, runtimeHermesMigrationSource, botRunnersMigrationSource] });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  ctx = {
    db: { system: (fn: (tx: Tx) => Promise<unknown>, options?: { workspaceId?: string }) => withSystem(fn, { pool: sysPool, workspaceId: (options?.workspaceId ?? omar.workspaceId) as never }) },
    secrets: { get: (tx: Tx, id: string) => getSecret(tx, id) },
  } as unknown as PluginContext;
}, 120_000);
afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

const resolve = (runner: string, teamId: string = TEAM_IDS.Engineering) => resolveRunner(ctx, { teamId, runner });

describe('resolveRunner', () => {
  it('answers a Hermes gateway runner with its address and key, guarded, for a team on its list', async () => {
    const secretId = await sys((tx) => putSecret(tx, KEY));
    await insertRunner('gw', { kind: 'hermes_gateway', baseUrl: 'http://hermes.example.test:8642', secretId, teams: [TEAM_IDS.Engineering] });
    const answer = await resolve('gw');
    expect(answer).toMatchObject({ ok: true, target: { runner: 'gw', kind: 'hermes_gateway', address: 'http://hermes.example.test:8642', key: KEY, agent: 'hermes', guard: true, profileRule: '{bot}', status: 'ready' } });
  });

  it('refuses a runner outside the team\'s list, in words that hold no address or key', async () => {
    const answer = await resolve('gw', TEAM_IDS.Marketing);
    expect(answer).toMatchObject({ ok: false, reason: 'not_available_to_team' });
    expect(JSON.stringify(answer)).not.toMatch(/hermes\.example|resolver-key|Label of gw|"gw"/);
  });

  it('a runner for every team is open to every team; one switched off is open to none', async () => {
    await insertRunner('everyone', { kind: 'hermes_pod', allTeams: true });
    await sys((tx) => tx.query("INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, base_url) VALUES ($1, $2, 'managed', 'managed', 'http://pod.internal:8642')", [omar.workspaceId, TEAM_IDS.Marketing]));
    expect(await resolve('everyone', TEAM_IDS.Marketing)).toMatchObject({ ok: true, target: { kind: 'hermes_pod', address: 'http://pod.internal:8642', key: null, guard: false } });
    await sys((tx) => tx.query("UPDATE app.bot_runners SET enabled = false WHERE name = 'everyone'"));
    expect(await resolve('everyone', TEAM_IDS.Marketing)).toMatchObject({ ok: false, reason: 'disabled' });
    await sys((tx) => tx.query("UPDATE app.bot_runners SET enabled = true WHERE name = 'everyone'"));
  });

  it('a pod runner for a team with no pod yet, an unknown name and a name that is not a name are refused', async () => {
    expect(await resolve('everyone', TEAM_IDS.Engineering)).toMatchObject({ ok: false, reason: 'not_set_up' });
    expect(await resolve('nope')).toMatchObject({ ok: false, reason: 'unknown' });
    const odd = await resolve('<script>alert(1)</script>');
    expect(odd).toMatchObject({ ok: false, reason: 'unknown' });
    expect(JSON.stringify(odd)).not.toContain('script');
  });

  it('the kinds that cannot run a bot yet are refused as such; a gateway without a key is "not set up"', async () => {
    await insertRunner('later-claude', { kind: 'claude_cli', allTeams: true });
    await insertRunner('model', { kind: 'llm_gateway', allTeams: true });
    await insertRunner('half-made', { kind: 'hermes_gateway', allTeams: true, baseUrl: 'http://x.example.test' });
    expect(await resolve('later-claude')).toMatchObject({ ok: false, reason: 'not_runnable' });
    expect(await resolve('model')).toMatchObject({ ok: false, reason: 'not_runnable' });
    expect(await resolve('half-made')).toMatchObject({ ok: false, reason: 'not_set_up' });
  });

  it('a team of another workspace gets "unknown", not "not available"', async () => {
    expect(await resolve('gw', '00000000-0000-7000-8000-00000000dead')).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

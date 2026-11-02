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
import { modelRunnerNoReply, modelRunnerRefusal } from '@manythreads/shared';
import { checkPlacement, kindOf, resolveRunner, teamRunners } from '../src/resolve.ts';

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
    await insertRunner('half-made', { kind: 'hermes_gateway', allTeams: true, baseUrl: 'http://x.example.test' });
    expect(await resolve('later-claude')).toMatchObject({ ok: false, reason: 'not_runnable' });
    expect(await resolve('half-made')).toMatchObject({ ok: false, reason: 'not_set_up' });
  });

  it('a team of another workspace gets "unknown", not "not available"', async () => {
    expect(await resolve('gw', '00000000-0000-7000-8000-00000000dead')).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

describe('an LLM gateway runner (P19-10)', () => {
  it('runs bots once it names a model alias: no address, no key, not guarded, the alias in the answer', async () => {
    await insertRunner('model', { kind: 'llm_gateway', allTeams: true });
    expect(await resolve('model')).toMatchObject({ ok: false, reason: 'not_set_up' });
    await sys((tx) => tx.query("UPDATE app.bot_runners SET model_alias = 'smart' WHERE name = 'model'"));
    const answer = await resolve('model');
    expect(answer).toMatchObject({ ok: true, target: { runner: 'model', kind: 'llm_gateway', address: null, key: null, guard: false, modelAlias: 'smart' } });
  });

  it('is never what a Hermes runner answers: the others carry no model alias', async () => {
    expect(await resolve('gw')).toMatchObject({ ok: true, target: { modelAlias: null } });
  });

  it('is not a default or a pod runner for any team', async () => {
    const info = await teamRunners(ctx, { teamId: TEAM_IDS.Engineering });
    expect(info.podRunners).not.toContain('model');
    expect(info.defaultRunner).not.toBe('model');
  });

  it('says what kind a runner is, with its alias, and nothing for a name that is not one', async () => {
    expect(await sys((tx) => kindOf(tx as never, { teamId: TEAM_IDS.Engineering, runner: 'model' }))).toEqual({ kind: 'llm_gateway', modelAlias: 'smart' });
    expect(await sys((tx) => kindOf(tx as never, { teamId: TEAM_IDS.Engineering, runner: 'gw' }))).toEqual({ kind: 'hermes_gateway', modelAlias: null });
    expect(await sys((tx) => kindOf(tx as never, { teamId: TEAM_IDS.Engineering, runner: 'nope' }))).toBeNull();
  });

  it('cannot take a bot that asks for a shell, files or a browser: the placement check refuses it in plain words, and passes it when it asks for none', async () => {
    const refused = await sys((tx) => checkPlacement(tx as never, { teamId: TEAM_IDS.Engineering, runner: 'model', runtimeGrants: ['shell', 'files'] }));
    expect(refused).toEqual({ ok: false, message: modelRunnerRefusal('Label of model', ['shell', 'files']) });
    expect((refused as { message: string }).message).toContain('only calls a model');
    expect((refused as { message: string }).message).toContain('shell, files');
    expect(await sys((tx) => checkPlacement(tx as never, { teamId: TEAM_IDS.Engineering, runner: 'model', runtimeGrants: [] }))).toEqual({ ok: true });
    expect(await sys((tx) => checkPlacement(tx as never, { teamId: TEAM_IDS.Engineering, runner: 'model' }))).toEqual({ ok: true });
  });

  it('cannot take a bot with no way to post its reply: refused with what to add, accepted with messages.post, answer.post or a namespace grant, and not asked when the grants are not given', async () => {
    const team = TEAM_IDS.Engineering;
    const refused = await sys((tx) => checkPlacement(tx as never, { teamId: team, runner: 'model', runtimeGrants: [], nativeGrants: ['memory.recall'] }));
    expect(refused).toEqual({ ok: false, message: modelRunnerNoReply('Label of model') });
    expect((refused as { message: string }).message).toContain('add messages.post (or answer.post)');
    for (const native of [['messages.post'], ['answer.post'], ['messages.*'], ['answer.*']]) {
      expect(await sys((tx) => checkPlacement(tx as never, { teamId: team, runner: 'model', nativeGrants: native })), native.join()).toEqual({ ok: true });
    }
    expect(await sys((tx) => checkPlacement(tx as never, { teamId: team, runner: 'model', nativeGrants: [] }))).toMatchObject({ ok: false });
    // a shell is named first when both problems stand
    expect(await sys((tx) => checkPlacement(tx as never, { teamId: team, runner: 'model', runtimeGrants: ['shell'], nativeGrants: [] }))).toEqual({ ok: false, message: modelRunnerRefusal('Label of model', ['shell']) });
    // a Hermes runner is never asked
    expect(await sys((tx) => checkPlacement(tx as never, { teamId: team, runner: 'gw', nativeGrants: [] }))).toEqual({ ok: true });
  });

  it('leaves a Hermes runner as it was for a bot that asks for a shell', async () => {
    expect(await sys((tx) => checkPlacement(tx as never, { teamId: TEAM_IDS.Engineering, runner: 'gw', runtimeGrants: ['shell'] }))).toEqual({ ok: true });
  });
});

describe('the run-start refusals (P19-03)', () => {
  it('say who the bot runs on and why, in one plain sentence, with no address or key', async () => {
    await sys((tx) => tx.query("UPDATE app.bot_runners SET enabled = false WHERE name = 'gw'"));
    const off = await resolve('gw');
    expect(off).toMatchObject({ ok: false, reason: 'disabled', message: 'This bot runs on Label of gw, which an admin has switched off.' });
    expect(JSON.stringify(off)).not.toMatch(/hermes\.example|resolver-key/);
    await sys((tx) => tx.query("UPDATE app.bot_runners SET enabled = true WHERE name = 'gw'"));
  });

  it('turn a run away in every state a runner cannot serve, and let ready and not-set-up (with an address and key) through', async () => {
    for (const status of ['waiting_for_sign_in', 'starting', 'needs_sign_in', 'waiting_for_node', 'moving', 'paused']) {
      await sys((tx) => tx.query('UPDATE app.bot_runners SET status = $1 WHERE name = $2', [status, 'gw']));
      const answer = await resolve('gw');
      expect(answer, status).toMatchObject({ ok: false, reason: 'not_ready' });
      expect(JSON.stringify(answer)).not.toMatch(/hermes\.example|resolver-key/);
    }
    await sys((tx) => tx.query("UPDATE app.bot_runners SET status = 'not_set_up' WHERE name = 'gw'"));
    expect(await resolve('gw')).toMatchObject({ ok: true });
    await sys((tx) => tx.query("UPDATE app.bot_runners SET status = 'ready' WHERE name = 'gw'"));
    expect(await resolve('gw')).toMatchObject({ ok: true });
  });
});

describe("checkPlacement (the loader's question)", () => {
  const check = (runner: string, teamId: string = TEAM_IDS.Engineering) => sys((tx) => checkPlacement(tx as never, { teamId, runner }));

  it('passes a runner the team may use, also when it is switched off', async () => {
    expect(await check('gw')).toEqual({ ok: true });
    await sys((tx) => tx.query("UPDATE app.bot_runners SET enabled = false WHERE name = 'gw'"));
    expect(await check('gw')).toEqual({ ok: true });
    await sys((tx) => tx.query("UPDATE app.bot_runners SET enabled = true WHERE name = 'gw'"));
  });

  it('refuses a name that is no runner and a runner the team is not on, in the same words', async () => {
    const missing = await check('does-not-exist');
    const hidden = await check('gw', TEAM_IDS.Marketing);
    expect(missing.ok).toBe(false);
    expect(hidden.ok).toBe(false);
    expect(JSON.stringify(hidden)).not.toMatch(/Label of gw|hermes\.example/);
    expect((hidden as { message: string }).message.replace('"gw"', '"X"')).toBe((missing as { message: string }).message.replace('"does-not-exist"', '"X"'));
  });
});

describe('teamRunners', () => {
  it('names the default runner only when the team may use it, and the pod runners the team may use', async () => {
    await sys((tx) => tx.query("UPDATE app.bot_runners SET is_default = true WHERE name = 'gw'"));
    expect(await teamRunners(ctx, { teamId: TEAM_IDS.Engineering })).toMatchObject({ defaultRunner: 'gw' });
    expect((await teamRunners(ctx, { teamId: TEAM_IDS.Marketing })).defaultRunner).toBeNull();
    expect((await teamRunners(ctx, { teamId: TEAM_IDS.Marketing })).podRunners).toContain('everyone');
    await sys((tx) => tx.query("UPDATE app.bot_runners SET enabled = false WHERE name = 'gw'"));
    expect((await teamRunners(ctx, { teamId: TEAM_IDS.Engineering })).defaultRunner).toBeNull();
    await sys((tx) => tx.query("UPDATE app.bot_runners SET enabled = true, is_default = false WHERE name = 'gw'"));
  });
});

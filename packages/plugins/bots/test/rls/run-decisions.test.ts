import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import { ActorId, type RunId } from '@manythreads/shared';
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
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P7-07: who may read what a run's gate, guard and tool door decided, and who may write it. A line is read with its run (a conversation run is its
// asker's alone, every other run the team's readers) and is written only through app.run_decision_append by the run itself.

const { omar, nadia, rafi, sameera, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
let routineRunId = '';
let convRunId = '';

const subjects = async (p: Persona): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ subject: string }>('SELECT subject FROM app.run_decisions ORDER BY subject')).rows.map((r) => r.subject));

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
       VALUES ($1, $2, 'decider', 'decider', 'Decides', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runner": "default"}') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    const routine = await tx.query<{ id: string }>(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status) VALUES ($1, $2, $3, 'mention', $4, 'running') RETURNING id`,
      [omar.workspaceId, bot.rows[0]!.id, ENG, nadia.actorId],
    );
    routineRunId = routine.rows[0]!.id;
    const conv = await tx.query<{ id: string }>(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status) VALUES ($1, $2, $3, 'conversation', $4, 'running') RETURNING id`,
      [omar.workspaceId, bot.rows[0]!.id, ENG, nadia.actorId],
    );
    convRunId = conv.rows[0]!.id;
    await tx.query(
      `INSERT INTO app.run_decisions (run_id, seq, kind, subject, outcome) VALUES ($1, 0, 'gate', 'routine-gate', 'passed'), ($2, 0, 'gate', 'conversation-gate', 'held')`,
      [routineRunId, convRunId],
    );
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('run_decisions (P7-07)', () => {
  it('is read with its run: a conversation run is its asker alone, every other run the team readers', async () => {
    expect(await subjects(nadia)).toEqual(['conversation-gate', 'routine-gate']);
    expect(await subjects(rafi)).toEqual(['routine-gate']);
    expect(await subjects(omar)).toEqual(['routine-gate']);
    expect(await subjects(sameera)).toEqual([]);
    expect(await subjects(lena)).toEqual([]);
  });

  it('is not written by a person: no insert, update or delete through the app role', async () => {
    const insert = `INSERT INTO app.run_decisions (run_id, seq, kind, subject, outcome) VALUES ($1, 5, 'gate', 'x', 'passed')`;
    expect(await code(as(nadia, (tx) => tx.query(insert, [routineRunId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(insert, [routineRunId])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.run_decisions SET outcome = 'held'")))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.run_decisions')))).toBe('42501');
  });

  it('is written through the append door by the run itself, and only for that run', async () => {
    const actor = { ...personaActor(nadia), runId: routineRunId as RunId };
    const seq = await withActor(
      actor,
      async (tx) =>
        (await tx.query<{ n: number }>(`SELECT app.run_decision_append('tool', 'messages.post', 'allowed', 'thread-1', NULL, '{"reason":"granted"}'::jsonb) AS n`)).rows[0]?.n,
      { pool: appPool },
    );
    expect(seq).toBe(1);
    // without a run on the transaction nobody can append
    expect(await code(as(nadia, (tx) => tx.query(`SELECT app.run_decision_append('tool', 'x', 'allowed', NULL, NULL, '{}'::jsonb)`)))).toBeDefined();
    // a bot in the run (not on the team's reader list) still lands its line, in its own run
    const bot = { kind: 'bot' as const, id: ActorId.parse(randomUUID()), workspaceId: omar.workspaceId, runId: routineRunId as RunId };
    const next = await withActor(
      bot,
      async (tx) => (await tx.query<{ n: number }>(`SELECT app.run_decision_append('guard', 'model', 'redact', NULL, NULL, '{}'::jsonb) AS n`)).rows[0]?.n,
      { pool: appPool },
    );
    expect(next).toBe(2);
    expect(await subjects(rafi)).toEqual(['messages.post', 'model', 'routine-gate']);
    // the other run took nothing
    expect(await subjects(nadia)).toEqual(['conversation-gate', 'messages.post', 'model', 'routine-gate']);
  });

  it('refuses an outcome or a kind outside the lists, and keeps no more than 300 lines a run', async () => {
    const actor = { ...personaActor(nadia), runId: routineRunId as RunId };
    expect(
      await code(withActor(actor, (tx) => tx.query(`SELECT app.run_decision_append('tool', 'x', 'maybe', NULL, NULL, '{}'::jsonb)`), { pool: appPool })),
    ).toBe('23514');
    expect(
      await code(withActor(actor, (tx) => tx.query(`SELECT app.run_decision_append('wish', 'x', 'allowed', NULL, NULL, '{}'::jsonb)`), { pool: appPool })),
    ).toBe('23514');
    await withActor(
      actor,
      async (tx) => {
        for (let i = 0; i < 310; i += 1) await tx.query(`SELECT app.run_decision_append('tool', 'bulk', 'allowed', NULL, NULL, '{}'::jsonb)`);
      },
      { pool: appPool },
    );
    const count = await sys(async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM app.run_decisions WHERE run_id = $1', [routineRunId])).rows[0]!.n));
    expect(count).toBe(300);
  });
});

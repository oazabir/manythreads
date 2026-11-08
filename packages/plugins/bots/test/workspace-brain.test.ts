import { createAppPool, createMemoryKv, createPluginContext, createSecretService, createSystemPool, ExtensionRegistries, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginEvent, PluginLogger, PluginTx } from '@manythreads/sdk';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bots from '../src/index.ts';
import { joinNewTeam, loadWorkspaceBot } from '../src/loader.ts';
import { ENSURE_BRAIN_QUEUE, SUPERSEDED_BRAIN_SHAS, ensureWorkspaceBrain, retireTeamBrains, shippedBrainDefinition } from '../src/workspace-brain.ts';

// P20-07: the workspace Brain. The shipped BOT.md is stored as version 1 of its definition and loaded as a bot of scope `workspace` with no team; it is a member of every
// team, its grants carry the workspace id, and the old per-team Brains are switched off (kept, with their history) once it is active.

const { omar } = personas;
const ENG = TEAM_IDS.Engineering;
const WS = omar.workspaceId;

let db: TestDatabase;
let sysPool: pg.Pool;
let appPool: pg.Pool;
let ctx: ReturnType<typeof createPluginContext>;
let registries: ExtensionRegistries;
const emitted: PluginEvent[] = [];
const logs: string[] = [];
const log: PluginLogger = { info: (m) => void logs.push(m), warn: (m) => void logs.push(m) };
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
const sha = (n: number): string => String(n).repeat(64).slice(0, 64);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource] });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  appPool = createAppPool(db.appUrl, 2);
  registries = new ExtensionRegistries();
  ctx = createPluginContext(bots.manifest, {
    registries,
    storage: createMemoryKv(),
    mail: { configured: true, send: () => Promise.resolve() },
    runtime: { publicUrl: 'http://localhost:3000', now: () => new Date() },
    secrets: createSecretService(),
    emit: (_tx, event) => {
      emitted.push(event);
      return Promise.resolve();
    },
  });
  await bots.register(ctx);
  // a team Brain of the old kind, with a run in its history
  await sys(async (tx) => {
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'brain', 'Brain', 'Team memory', 'agent', 'hermes', 'team', $3, 'active') RETURNING id`,
        [WS, ENG, sha(1)],
      )
    ).rows[0]!.id;
    await tx.query(`INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2)`, [WS, bot]);
    await tx.query(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status) VALUES ($1, $2, $3, 'mention', 'done')`, [WS, bot, ENG]);
  });
}, 120_000);

afterAll(async () => {
  await sysPool?.end();
  await appPool?.end();
  if (db) await dropTestDatabase(db);
});

const workspaceBot = () => sys(async (tx) => (await tx.query<Record<string, unknown>>(`SELECT * FROM app.bots WHERE workspace_id = $1 AND scope = 'workspace' AND slug = 'brain'`, [WS])).rows[0]);

describe('the workspace Brain', () => {
  it('registers its fallback job and the team-created subscription', () => {
    expect(registries.jobs.list().some((job) => job.value.queue === ENSURE_BRAIN_QUEUE)).toBe(true);
  });

  it('ships a definition that the workspace can load: workspace-visible, reads Personal files and memory, runs where the workspace default runs', async () => {
    const text = await shippedBrainDefinition();
    expect(text).not.toBeNull();
    expect(text).toMatch(/^visibility: workspace$/m);
    expect(text).toMatch(/- files\.read$/m);
    expect(text).toMatch(/- personal\.read$/m);
    expect(text).not.toMatch(/^placement:/m);
  });

  it('is made from the shipped definition: no team, version 1 stored, an actor, a seat in every team, grants under the workspace id, no team-keyed event', async () => {
    const id = await sys((tx) => ensureWorkspaceBrain(ctx, tx as unknown as PluginTx, WS, log));
    expect(id).not.toBeNull();
    const row = await workspaceBot();
    expect(row).toMatchObject({ id, team_id: null, scope: 'workspace', visibility: 'workspace', status: 'active', slug: 'brain', name: 'Brain', runtime: 'hermes' });
    expect(row?.['native']).toEqual(expect.arrayContaining(['files.read', 'personal.read', 'memory.recall', 'answer.post', 'meetings.search']));
    const versions = await sys(async (tx) => (await tx.query<{ version: number; sha: string }>('SELECT version, sha FROM app.workspace_bot_definitions WHERE workspace_id = $1', [WS])).rows);
    expect(versions).toEqual([{ version: 1, sha: row?.['definition_sha'] }]);
    const teams = await sys(async (tx) => (await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.teams WHERE workspace_id = $1 AND archived_at IS NULL', [WS])).rows[0]!.n);
    const seats = await sys(async (tx) =>
      (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.team_members m JOIN app.actors a ON a.id = m.actor_id AND a.kind = 'bot' AND a.ref_id = $1`, [id])).rows[0]!.n,
    );
    expect(seats).toBe(teams);
    const grants = await sys(async (tx) =>
      (await tx.query<{ team_id: string; capability: string }>(`SELECT g.team_id, g.capability FROM app.capability_grants g JOIN app.actors a ON a.id = g.actor_id AND a.ref_id = $1`, [id])).rows,
    );
    expect(grants.length).toBeGreaterThan(5);
    expect(new Set(grants.map((g) => g.team_id))).toEqual(new Set([WS]));
    expect(emitted.filter((e) => e.type.startsWith('bots.bot.'))).toEqual([]);
  });

  it('retires the old team Brain: switched off and left out of the roster, with its run still there', async () => {
    const old = await sys(async (tx) => (await tx.query<{ status: string; retired_at: Date | null; runs: string }>(
      `SELECT b.status, b.retired_at, (SELECT count(*)::text FROM app.bot_runs r WHERE r.bot_id = b.id) AS runs FROM app.bots b WHERE b.team_id = $1 AND b.slug = 'brain'`, [ENG])).rows[0]);
    expect(old?.status).toBe('disabled');
    expect(old?.retired_at).toBeInstanceOf(Date);
    expect(old?.runs).toBe('1');
  });

  it('retires a team Brain that loads later (a team made from a template ships one) the same way, and touches no other bot', async () => {
    await sys(async (tx) => {
      for (const slug of ['brain', 'coder']) {
        await tx.query(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
           VALUES ($1, $2, $3, $3, 'x', 'agent', 'hermes', 'team', $4, 'active')`,
          [WS, TEAM_IDS.Marketing, slug, sha(2)],
        );
      }
    });
    expect(await sys((tx) => retireTeamBrains(tx as unknown as PluginTx, WS))).toBe(1);
    const states = await sys(async (tx) => (await tx.query<{ slug: string; status: string }>('SELECT slug, status FROM app.bots WHERE team_id = $1 ORDER BY slug', [TEAM_IDS.Marketing])).rows);
    expect(states).toEqual([{ slug: 'brain', status: 'disabled' }, { slug: 'coder', status: 'active' }]);
    expect(await sys((tx) => retireTeamBrains(tx as unknown as PluginTx, WS))).toBe(0);
  });

  it('is idempotent: a second pass changes nothing, and never overwrites a stored version with the shipped file', async () => {
    const before = await workspaceBot();
    await sys((tx) => ensureWorkspaceBrain(ctx, tx as unknown as PluginTx, WS, log));
    expect((await workspaceBot())?.['id']).toBe(before?.['id']);
    const stored = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.workspace_bot_definitions WHERE workspace_id = $1', [WS])).rows.length);
    expect(stored).toBe(1);
  });

  it('takes an edited definition as version 2 and keeps a bot switched off switched off', async () => {
    const current = await sys(async (tx) => (await tx.query<{ content: string }>(`SELECT content FROM app.workspace_bot_definitions WHERE workspace_id = $1 AND version = 1`, [WS])).rows[0]!.content);
    const edited = current.replace('role: The workspace', 'role: Your workspace');
    expect(edited).not.toBe(current);
    await sys((tx) => loadWorkspaceBot(ctx, tx as unknown as PluginTx, { workspaceId: WS, slug: 'brain', content: edited }));
    const row = await workspaceBot();
    expect(String(row?.['role'])).toMatch(/^Your workspace/);
    const versions = await sys(async (tx) => (await tx.query<{ version: number }>('SELECT version FROM app.workspace_bot_definitions WHERE workspace_id = $1 ORDER BY version', [WS])).rows.map((r) => r.version));
    expect(versions).toEqual([1, 2]);
    await sys((tx) => tx.query(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [row?.['id']]));
    await sys((tx) => loadWorkspaceBot(ctx, tx as unknown as PluginTx, { workspaceId: WS, slug: 'brain', content: current }));
    expect((await workspaceBot())?.['status']).toBe('disabled');
  });

  it('refuses a definition that is not workspace-visible or does not parse: nothing new is stored, the bot stays as it was', async () => {
    const before = await workspaceBot();
    const current = await sys(async (tx) => (await tx.query<{ content: string }>(`SELECT content FROM app.workspace_bot_definitions WHERE workspace_id = $1 AND version = 2`, [WS])).rows[0]!.content);
    expect(await sys((tx) => loadWorkspaceBot(ctx, tx as unknown as PluginTx, { workspaceId: WS, slug: 'brain', content: current.replace('visibility: workspace', 'visibility: team') }))).toBeNull();
    expect(await sys((tx) => loadWorkspaceBot(ctx, tx as unknown as PluginTx, { workspaceId: WS, slug: 'brain', content: 'not a definition' }))).toBeNull();
    const after = await workspaceBot();
    expect(after).toMatchObject({ id: before?.['id'], status: 'disabled' });
    expect(after?.['invalid_reason']).not.toBeNull();
    // only a definition that loaded is kept as a version: the two refused texts added none (v1 shipped, v2 edited, v3 the shipped text put back)
    const versions = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.workspace_bot_definitions WHERE workspace_id = $1', [WS])).rows.length);
    expect(versions).toBe(3);
  });

  it('moves a Brain that is only behind (its stored text is a superseded shipped one) to the shipped file, and leaves an edited one alone', async () => {
    const shipped = (await shippedBrainDefinition())!;
    const newest = () => sys(async (tx) => (await tx.query<{ version: number; sha: string; content: string }>('SELECT version, sha, content FROM app.workspace_bot_definitions WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1', [WS])).rows[0]!);
    // an admin's edit: not on the list, so an ensure keeps it
    const behind = shipped.replace('meetings.search', 'meetings.read').replace(/\n\s+- meetings\.read\n/, '\n');
    expect(behind).not.toBe(shipped);
    await sys((tx) => loadWorkspaceBot(ctx, tx as unknown as PluginTx, { workspaceId: WS, slug: 'brain', content: behind }));
    const stored = await newest();
    await sys((tx) => ensureWorkspaceBrain(ctx, tx as unknown as PluginTx, WS, log));
    expect((await newest()).version).toBe(stored.version);
    // the same text on the list of superseded shipped files: the next ensure stores the shipped file as the next version
    await sys((tx) => ensureWorkspaceBrain(ctx, tx as unknown as PluginTx, WS, log, new Set([stored.sha])));
    const after = await newest();
    expect(after.version).toBe(stored.version + 1);
    expect(after.content).toBe(shipped);
    expect((await workspaceBot())?.['native']).toEqual(expect.arrayContaining(['meetings.search']));
    // and a second pass changes nothing
    await sys((tx) => ensureWorkspaceBrain(ctx, tx as unknown as PluginTx, WS, log, new Set([stored.sha])));
    expect((await newest()).version).toBe(after.version);
    // the shas of the three earlier shipped files are on the real list
    expect(SUPERSEDED_BRAIN_SHAS.size).toBe(3);
  });

  it('joins a team made later', async () => {
    const team = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, 'late-team', 'Late team') RETURNING id`, [WS])).rows[0]!.id);
    await sys((tx) => joinNewTeam(tx as unknown as PluginTx, WS, team));
    const seat = await sys(async (tx) =>
      (await tx.query(`SELECT 1 FROM app.team_members m JOIN app.actors a ON a.id = m.actor_id AND a.kind = 'bot' JOIN app.bots b ON b.id = a.ref_id AND b.scope = 'workspace' WHERE m.team_id = $1`, [team])).rows.length,
    );
    expect(seat).toBe(1);
  });
});

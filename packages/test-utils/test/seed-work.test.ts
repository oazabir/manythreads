import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KAHF_WORKSPACE_ID, ownerSql, personas, seedWorld, SEED_WORK, startTestServer, TEAM_IDS, type TestServer } from '../src/index.ts';

// Seed v6 (PLAN P6-11): the Engineering team's board, rhythms, page and production environment. The database comes from a started test
// server (its plugin migrations create the tasks, rhythms, bots and repo tables, and it loads the coder bot from the v4 placeholder).
let server: TestServer;
let storageDir: string;
const servers: TestServer[] = [];
const sqlOn = <T extends Record<string, unknown>>(s: TestServer, text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(s.db.ownerUrl, text, params);
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => sqlOn<T>(server, text, params);
const options = { content: true, repo: true, work: true, workOptions: { botWaitMs: 60_000 } } as const;
const TABLES = ['tasks', 'task_events', 'task_claims', 'boards', 'goals', 'environments', 'rhythms', 'rhythm_runs', 'repo_commits'] as const;
const counts = async (s: TestServer): Promise<Record<string, number>> =>
  Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, Number((await sqlOn<{ n: number }>(s, `SELECT count(*)::int AS n FROM app.${t}`))[0]?.n)] as const)));

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'manythreads-seed6-blobs-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
  process.env['MANYTHREADS_CLOCK'] = 'fixed';
  server = await startTestServer();
  servers.push(server);
}, 120_000);

afterAll(async () => {
  delete process.env['MANYTHREADS_CLOCK'];
  for (const s of servers) await s.close();
  rmSync(storageDir, { recursive: true, force: true });
});

describe('seedWorld with work (seed v6)', () => {
  it('writes the environment, board, cards, disabled rhythms, past runs, contract and page; a second run writes nothing', async () => {
    const first = await seedWorld(server.db, options);
    expect(first.work).toMatchObject({ skipped: null, notes: [] });
    expect(first.work?.written).toBeGreaterThan(0);

    expect(await sql(`SELECT name, protected, needs_approval FROM app.environments WHERE team_id = $1`, [TEAM_IDS.Engineering])).toEqual([
      { name: 'production', protected: true, needs_approval: true },
    ]);
    const cards = await sql<{ state: string; kind: string; tested_sha: string | null; owner_kind: string | null }>(
      `SELECT t.state, t.kind, t.tested_sha, a.kind AS owner_kind FROM app.tasks t LEFT JOIN app.actors a ON a.id = t.owner_id WHERE t.team_id = $1`,
      [TEAM_IDS.Engineering],
    );
    expect(new Set(cards.map((c) => c.state))).toEqual(new Set(['open', 'in_progress', 'verify', 'waiting_on_person', 'done']));
    expect(cards.some((c) => c.owner_kind === 'person')).toBe(true);
    expect(cards.some((c) => c.owner_kind === 'bot')).toBe(true);
    expect(cards.some((c) => c.kind === 'code' && c.state === 'done' && c.tested_sha !== null)).toBe(true);
    expect(await sql(`SELECT name FROM app.boards WHERE team_id = $1 AND channel_id IS NULL`, [TEAM_IDS.Engineering])).toEqual([{ name: 'Engineering board' }]);
    expect(
      await sql(
        `SELECT b.name, c.name AS channel, (SELECT count(*)::int FROM app.tasks t WHERE t.board_id = b.id) AS cards
           FROM app.boards b JOIN app.channels c ON c.id = b.channel_id WHERE b.team_id = $1`,
        [TEAM_IDS.Engineering],
      ),
    ).toEqual([{ name: 'Bot Board', channel: 'dev', cards: 1 }]);

    expect(await sql(`SELECT kind, enabled, next_run_at FROM app.rhythms WHERE team_id = $1 ORDER BY kind`, [TEAM_IDS.Engineering])).toEqual([
      { kind: 'heartbeat', enabled: false, next_run_at: null },
      { kind: 'routine', enabled: false, next_run_at: null },
    ]);
    const runs = await sql<{ status: string; reason: string }>(`SELECT status, reason FROM app.rhythm_runs WHERE team_id = $1 ORDER BY status`, [TEAM_IDS.Engineering]);
    expect(runs.map((r) => r.status)).toEqual(['done', 'failed']);
    expect(runs[1]?.reason).not.toBe('');

    const files = (await sql<{ path: string }>(`SELECT path FROM app.repo_entries WHERE team_id = $1 AND path IN ($2, $3)`, [TEAM_IDS.Engineering, SEED_WORK.routinePath, SEED_WORK.pagePath])).map((r) => r.path);
    expect(files.sort()).toEqual([SEED_WORK.pagePath, SEED_WORK.routinePath].sort());

    // History as the tasks functions write it: the creator makes the card, the owner claims it, moves are legal and the times only go up.
    const done = SEED_WORK.cards.done;
    const events = await sql<{ type: string; actor_id: string; data: Record<string, unknown>; created_at: Date }>(
      `SELECT type, actor_id, data, created_at FROM app.task_events WHERE task_id = $1 ORDER BY created_at, id`,
      [done],
    );
    expect(events.map((e) => e.type)).toEqual(['created', 'claimed', 'state_changed', 'completed']);
    expect(events[0]?.actor_id).toBe(personas.omar.actorId);
    expect(events[1]?.actor_id).toBe(personas.nadia.actorId);
    expect(events[2]?.data).toEqual({ from: 'in_progress', to: 'verify' });
    expect(events[3]?.data).toEqual({ from: 'verify', to: 'done' });
    const [task] = await sql<{ completed_at: Date; updated_at: Date }>(`SELECT completed_at, updated_at FROM app.tasks WHERE id = $1`, [done]);
    expect(task?.completed_at.getTime()).toBe(events[3]?.created_at.getTime());
    expect(task?.updated_at.getTime()).toBe(events[3]?.created_at.getTime());
    // live claims: the six owned cards that are not done; the two done cards have theirs released
    expect(await sql(`SELECT count(*)::int AS n FROM app.task_claims WHERE released_at IS NULL`)).toEqual([{ n: 6 }]);

    const before = await counts(server);
    const again = await seedWorld(server.db, options);
    expect(again.work).toMatchObject({ skipped: null, written: 0 });
    expect(await counts(server)).toEqual(before);
  }, 180_000);

  it('never puts back what a person deleted, and leaves a card they moved where it is', async () => {
    await sql(`UPDATE app.tasks SET state = 'verify' WHERE id = $1`, [SEED_WORK.cards.open]);
    await sql(`DELETE FROM app.tasks WHERE id = $1`, [SEED_WORK.cards.verify]);
    await sql(`DELETE FROM app.rhythms WHERE id = $1`, [SEED_WORK.rhythms.heartbeat]);
    await sql(`DELETE FROM app.environments WHERE team_id = $1`, [TEAM_IDS.Engineering]);
    await seedWorld(server.db, options);
    expect(await sql(`SELECT state FROM app.tasks WHERE id = $1`, [SEED_WORK.cards.open])).toEqual([{ state: 'verify' }]);
    expect(await sql(`SELECT 1 FROM app.tasks WHERE id = $1`, [SEED_WORK.cards.verify])).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.rhythms WHERE id = $1`, [SEED_WORK.rhythms.heartbeat])).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.environments WHERE team_id = $1`, [TEAM_IDS.Engineering])).toEqual([]);
  });

  it('the Rhythms API lists the rhythms that are left, switched off', async () => {
    const res = await fetch(`${server.url}/api/teams/engineering/rhythms`, {
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: personas.omar.actorId, workspaceId: KAHF_WORKSPACE_ID }) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { enabled: boolean }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items.every((r) => !r.enabled)).toBe(true);
  });
});

describe('seed v6 next to rows a person made first', () => {
  it('uses a production environment and a Bot Board that already exist under other ids, and still succeeds', async () => {
    const s = await startTestServer();
    servers.push(s);
    await seedWorld(s.db, { content: true, repo: true });
    const [dev] = await sqlOn<{ id: string }>(s, `SELECT id FROM app.channels WHERE team_id = $1 AND name = 'dev'`, [TEAM_IDS.Engineering]);
    await sqlOn(s, `INSERT INTO app.environments (workspace_id, team_id, name, created_by) VALUES ($1, $2, 'production', $3)`, [KAHF_WORKSPACE_ID, TEAM_IDS.Engineering, personas.omar.actorId]);
    await sqlOn(s, `INSERT INTO app.boards (workspace_id, team_id, channel_id, name, created_by) VALUES ($1, $2, $3, 'Bot Board', $4)`, [KAHF_WORKSPACE_ID, TEAM_IDS.Engineering, dev?.id, personas.omar.actorId]);
    const result = await seedWorld(s.db, options);
    expect(result.work).toMatchObject({ skipped: null, notes: [] });
    const [env] = await sqlOn<{ id: string }>(s, `SELECT id FROM app.environments WHERE team_id = $1`, [TEAM_IDS.Engineering]);
    expect(env?.id).not.toBe(SEED_WORK.environment.id);
    expect(await sqlOn(s, `SELECT environment_id FROM app.tasks WHERE id = $1`, [SEED_WORK.cards.done])).toEqual([{ environment_id: env?.id }]);
    const [board] = await sqlOn<{ id: string }>(s, `SELECT id FROM app.boards WHERE channel_id = $1`, [dev?.id]);
    expect(board?.id).not.toBe(SEED_WORK.boards.bot.id);
    expect(await sqlOn(s, `SELECT board_id FROM app.tasks WHERE id = $1`, [SEED_WORK.cards.botBoard])).toEqual([{ board_id: board?.id }]);
  }, 240_000);
});

describe('seed v6 when the coder bot is not loaded', () => {
  it('leaves the bot part out with a note and throws nothing; the core part is still seeded once', async () => {
    const s = await startTestServer();
    servers.push(s);
    await seedWorld(s.db, { content: true }); // no repositories, so no bots/coder/BOT.md and no bot row
    const first = await seedWorld(s.db, { content: true, work: true, workOptions: { botWaitMs: 0 } });
    expect(first.work?.skipped).toBeNull();
    expect(first.work?.notes.join(' ')).toMatch(/coder bot is not loaded/);
    expect(await sqlOn(s, `SELECT count(*)::int AS n FROM app.rhythms`)).toEqual([{ n: 0 }]);
    expect((await sqlOn<{ n: number }>(s, `SELECT count(*)::int AS n FROM app.tasks`))[0]?.n).toBe(6);
    const second = await seedWorld(s.db, { content: true, work: true, workOptions: { botWaitMs: 0 } });
    expect(second.work).toMatchObject({ written: 0 });
  }, 240_000);
});

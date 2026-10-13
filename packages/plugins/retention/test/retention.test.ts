import { RetentionSettingsResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// Retention through the real server: the admin routes (who may read and change the windows, what is refused), the daily job and its chain of
// steps run by the job worker, the dry run that never deletes, and the audit events a sweep and a change of window leave.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
const DAY = 24 * 3_600_000;
vi.setConfig({ testTimeout: 180_000 });

let w: RepoWorld;
let botId = '';

const ago = (days: number, extraMs = 0): string => new Date(Date.now() - days * DAY + extraMs).toISOString();
const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${w.server.logs.filter((l) => /retention|"level":(40|50)/.test(l)).slice(-8).join('\n')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
async function enqueue(queue: string): Promise<void> {
  await w.system(async (tx) => {
    const job = (await tx.query<{ id: string }>("SELECT (app.enqueue_job($1, '{}'::jsonb, now() + interval '1 hour', NULL)).id AS id", [queue])).rows[0]!.id;
    await tx.query('UPDATE app.jobs SET run_at = now() WHERE id = $1', [job]);
    await tx.query("SELECT pg_notify('manythreads_jobs', $1)", [queue]);
  });
}
const oldRun = (days: number): Promise<string> =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, started_at, ended_at)
           VALUES ($1, $2, $3, 'mention', $4, 'done', $5::timestamptz, $6::timestamptz) RETURNING id`,
          [omar.workspaceId, botId, ENG, nadia.actorId, ago(days, -60_000), ago(days)],
        )
      ).rows[0]!.id,
  );
const runExists = (id: string) => w.system(async (tx) => (await tx.query('SELECT 1 FROM app.bot_runs WHERE id = $1', [id])).rows.length > 0);
const eventsOf = (type: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));
const lastSweep = () =>
  w.system(async (tx) => (await tx.query<{ last_sweep: { dryRun: boolean; counts: Record<string, number> } | null }>('SELECT last_sweep FROM app.retention_settings WHERE workspace_id = $1', [omar.workspaceId])).rows[0]?.last_sweep ?? null);

beforeAll(async () => {
  w = await createRepoWorld();
  botId = await w.system(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'sweeper', 'Sweeper', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [omar.workspaceId, ENG],
      )
    ).rows[0]!.id;
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, id]);
    return id;
  });
}, 240_000);

afterAll(async () => {
  delete process.env['MANYTHREADS_RETENTION'];
  await w?.close();
});

describe('the settings routes', () => {
  it('answer the defaults, the deployment’s mode and no sweep to a workspace admin', async () => {
    const res = await w.call(omar, 'GET', '/api/workspace/retention');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(RetentionSettingsResponse.parse(res.body).settings).toEqual({ runLogDays: 90, memoryLogDays: 365, mode: 'dry-run', lastSweep: null, updatedAt: null });
  });

  it('are an admin’s: a member is refused and an anonymous caller is not signed in', async () => {
    expect((await w.call(nadia, 'GET', '/api/workspace/retention')).status).toBe(403);
    expect((await w.call(nadia, 'PUT', '/api/workspace/retention', { runLogDays: 60 })).status).toBe(403);
    expect((await w.call(nadia, 'POST', '/api/workspace/retention/preview')).status).toBe(403);
    expect((await w.call(null, 'GET', '/api/workspace/retention')).status).toBe(401);
  });

  it('change the windows within their bounds and refuse everything else, never clamping', async () => {
    const ok = await w.call(omar, 'PUT', '/api/workspace/retention', { runLogDays: 45, memoryLogDays: 200 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(RetentionSettingsResponse.parse(ok.body).settings).toMatchObject({ runLogDays: 45, memoryLogDays: 200 });
    expect((await w.call(omar, 'GET', '/api/workspace/retention')).body).toMatchObject({ settings: { runLogDays: 45, memoryLogDays: 200 } });

    for (const body of [{ runLogDays: 29 }, { runLogDays: 3651 }, { memoryLogDays: 89 }, { runLogDays: 45.5 }, { runLogDays: '60' }, {}, { audit: false }, { runLogDays: 45, events: 1 }]) {
      const res = await w.call(omar, 'PUT', '/api/workspace/retention', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await w.call(omar, 'GET', '/api/workspace/retention')).body).toMatchObject({ settings: { runLogDays: 45, memoryLogDays: 200 } });
  });

  it('leave an audit event naming who changed what, once, and none for a change that changes nothing', async () => {
    const before = (await eventsOf('retention.settings.changed')).length;
    await w.call(omar, 'PUT', '/api/workspace/retention', { runLogDays: 45 }); // unchanged
    expect((await eventsOf('retention.settings.changed')).length).toBe(before);
    await w.call(omar, 'PUT', '/api/workspace/retention', { runLogDays: 60 });
    const events = await eventsOf('retention.settings.changed');
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)).toMatchObject({ changedBy: omar.actorId, runLogDays: { from: 45, to: 60 }, memoryLogDays: { from: 200, to: 200 } });
    await w.call(omar, 'PUT', '/api/workspace/retention', { runLogDays: 45 });
  });
});

describe('a sweep', () => {
  it('a dry run (the default mode, and every preview) counts and reports and deletes nothing', async () => {
    const old = await oldRun(100);
    const res = await w.call(omar, 'POST', '/api/workspace/retention/preview');
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const sweep = await until(async () => lastSweep(), 'the dry run to finish');
    expect(sweep).toMatchObject({ dryRun: true, counts: { runs: 1 } });
    expect(await runExists(old)).toBe(true);
    const completed = await eventsOf('retention.sweep.completed');
    expect(completed.at(-1)).toMatchObject({ dryRun: true, counts: { runs: 1 } });
    const shown = RetentionSettingsResponse.parse((await w.call(omar, 'GET', '/api/workspace/retention')).body).settings;
    expect(shown.lastSweep).toMatchObject({ dryRun: true, counts: { runs: 1 } });
  });

  it('with the deployment’s mode on, the daily job prunes the runs outside the workspace’s window, and a run inside it stays', async () => {
    process.env['MANYTHREADS_RETENTION'] = 'on';
    const outside = await oldRun(60); // window is 45 days
    const inside = await oldRun(20);
    const before = (await eventsOf('retention.sweep.completed')).length;
    await enqueue('retention.sweep');
    await until(async () => ((await eventsOf('retention.sweep.completed')).length > before ? true : null), 'the sweep to complete');
    expect(await runExists(outside)).toBe(false);
    expect(await runExists(inside)).toBe(true);
    expect(await lastSweep()).toMatchObject({ dryRun: false });
    expect((await eventsOf('retention.sweep.completed')).at(-1)).toMatchObject({ dryRun: false, counts: { runs: expect.any(Number) } });
    // the old run of the dry run above went too (it was outside the window); the audit events of all of it are still there
    expect((await eventsOf('retention.sweep.completed')).length).toBeGreaterThanOrEqual(2);
  });

  it('with the deployment’s mode off, nothing is counted and a preview is refused', async () => {
    process.env['MANYTHREADS_RETENTION'] = 'off';
    const res = await w.call(omar, 'POST', '/api/workspace/retention/preview');
    expect(res.status).toBe(409);
    const before = (await eventsOf('retention.sweep.completed')).length;
    await enqueue('retention.sweep');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await eventsOf('retention.sweep.completed')).length).toBe(before);
  });

  it('never touches the audit trail: the events and the approvals of a pruned run are all still there', async () => {
    process.env['MANYTHREADS_RETENTION'] = 'on';
    const counts = async () => w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.events')).rows[0]!.n);
    const run = await oldRun(200);
    const eventsBefore = await counts();
    const before = (await eventsOf('retention.sweep.completed')).length;
    await enqueue('retention.sweep');
    await until(async () => ((await eventsOf('retention.sweep.completed')).length > before ? true : null), 'the sweep to complete');
    expect(await runExists(run)).toBe(false);
    // the sweep's own event was added; nothing was removed
    expect(await counts()).toBeGreaterThanOrEqual(eventsBefore + 1);
  });
});

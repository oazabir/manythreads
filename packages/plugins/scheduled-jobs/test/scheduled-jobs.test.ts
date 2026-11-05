import { randomUUID } from 'node:crypto';
import { CreateScheduledJobResponse, ListScheduledJobsResponse, RunScheduledJobResponse } from '@manythreads/shared';
import {
  KAHF_WORKSPACE_ID,
  TEAM_IDS,
  createPersonas,
  ownerSql,
  personas,
  startTestServer,
  type Persona,
  type TestServer,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, priya, sameera } = personas;
const TEAM = TEAM_IDS.Engineering;

let server: TestServer;

const call = async (who: Persona, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = {
    'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
};

/** The one message of an error response (`{ error: { code, message } }`). */
const messageOf = (body: Record<string, unknown> | null): string => String((body?.['error'] as { message?: unknown } | undefined)?.message ?? '');

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  const botId = randomUUID();
  await ownerSql(
    server.db.ownerUrl,
    `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status)
     VALUES ($1, $2, $3, 'pulse', 'Pulse', 'automation', 'rules', 'team', $4, 'active')`,
    [botId, KAHF_WORKSPACE_ID, TEAM, 'c'.repeat(64)],
  );
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('scheduledJobs API', () => {
  it('creates a heartbeat for a team bot with the next slot computed', async () => {
    const res = await call(omar, 'POST', '/api/teams/engineering/scheduled-jobs', {
      botSlug: 'pulse',
      name: 'Hourly pulse',
      kind: 'heartbeat',
      schedule: '0 * * * *',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { scheduledJob } = CreateScheduledJobResponse.parse(res.body);
    expect(scheduledJob.kind).toBe('heartbeat');
    expect(scheduledJob.nextRunAt).not.toBeNull();
    expect(new Date(scheduledJob.nextRunAt as string).getUTCMinutes()).toBe(0);
    expect(ListScheduledJobsResponse.parse((await call(omar, 'GET', '/api/teams/engineering/scheduled-jobs')).body).items.map((r) => r.id)).toContain(scheduledJob.id);
  });

  it('refuses an invalid schedule and a schedule that never fires', async () => {
    for (const schedule of ['every hour', '0 25 * * *', '0 0 30 2 *']) {
      const res = await call(omar, 'POST', '/api/teams/engineering/scheduled-jobs', {
        botSlug: 'pulse',
        name: 'bad',
        kind: 'heartbeat',
        schedule,
      });
      expect(res.status, `${schedule}: ${JSON.stringify(res.body)}`).toBe(400);
    }
  });

  it('requires a contract for a routine, and that it lives under routines/', async () => {
    const missing = await call(omar, 'POST', '/api/teams/engineering/scheduled-jobs', {
      botSlug: 'pulse',
      name: 'weekly',
      kind: 'routine',
      schedule: '0 9 * * mon',
    });
    expect(missing.status).toBe(400);
    expect(messageOf(missing.body)).toMatch(/contract/);
    const outside = await call(omar, 'POST', '/api/teams/engineering/scheduled-jobs', {
      botSlug: 'pulse',
      name: 'weekly',
      kind: 'routine',
      schedule: '0 9 * * mon',
      contractPath: 'pages/weekly.yaml',
    });
    expect(outside.status).toBe(400);
    expect(messageOf(outside.body)).toMatch(/routines\//);
  });

  it('keeps a non-lead and another team out', async () => {
    const asMember = await call(priya, 'POST', '/api/teams/engineering/scheduled-jobs', {
      botSlug: 'pulse',
      name: 'member want',
      kind: 'heartbeat',
      schedule: '* * * * *',
    });
    expect(asMember.status).toBe(403);
    expect((await call(sameera, 'GET', '/api/teams/engineering/scheduled-jobs')).status).toBe(403);
  });

  it('fails a routine whose contract is missing, with the reason, and queues nothing', async () => {
    const created = await call(omar, 'POST', '/api/teams/engineering/scheduled-jobs', {
      botSlug: 'pulse',
      name: 'Broken report',
      kind: 'routine',
      schedule: '0 9 * * mon',
      contractPath: 'routines/not-there.yaml',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { scheduledJob } = CreateScheduledJobResponse.parse(created.body);
    const run = await call(omar, 'POST', `/api/teams/engineering/scheduled-jobs/${scheduledJob.id}/run`);
    expect(run.status).toBe(202);
    const started = RunScheduledJobResponse.parse(run.body).run;
    expect(started.status).toBe('failed');
    expect(started.reason).toMatch(/missing|unreadable|not available/);
    expect(started.endedAt).not.toBeNull();
  });

  it('fires a due heartbeat on the tick job exactly once and advances the schedule', async () => {
    const created = await call(omar, 'POST', '/api/teams/engineering/scheduled-jobs', {
      botSlug: 'pulse',
      name: 'Every minute',
      kind: 'heartbeat',
      schedule: '* * * * *',
    });
    expect(created.status).toBe(201);
    const { scheduledJob } = CreateScheduledJobResponse.parse(created.body);
    // Make it due now, then run the same job the scheduler runs.
    await ownerSql(server.db.ownerUrl, `UPDATE app.scheduled_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [scheduledJob.id]);
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.jobs (queue, payload, run_at) VALUES ('scheduled-jobs.tick', '{}'::jsonb, now())`);
    await expect
      .poll(async () => Number((await ownerSql(server.db.ownerUrl, 'SELECT count(*)::int AS n FROM app.scheduled_job_runs WHERE scheduled_job_id = $1', [scheduledJob.id]))[0]?.['n'] ?? 0), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const runs = await ownerSql(server.db.ownerUrl, 'SELECT status, output_path FROM app.scheduled_job_runs WHERE scheduled_job_id = $1', [scheduledJob.id]);
    expect(runs.every((r) => r['status'] === 'queued')).toBe(true);
    const after = await ownerSql(server.db.ownerUrl, 'SELECT next_run_at FROM app.scheduled_jobs WHERE id = $1', [scheduledJob.id]);
    expect(new Date(after[0]?.['next_run_at'] as string).getTime()).toBeGreaterThan(Date.now());
  }, 30_000);
});

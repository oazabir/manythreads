import { randomUUID } from 'node:crypto';
import { DeliveriesResponse } from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P35-05: the delivery dashboard reads a team's delivery threads (runs, cards, pull requests, approvals, the people's nudges) and the week per bot; spend is
// shown to a workspace admin only. A real server and database; the rows are written as the runtime and the tasks plugin would.

const { omar, nadia } = personas;
const TEAM = TEAM_IDS.Engineering;
let server: TestServer;

async function get(who: { actorId: string }, path: string) {
  const res = await fetch(`${server.url}${path}`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }) } });
  return { status: res.status, body: (await res.json()) as unknown };
}
async function post(who: { actorId: string }, path: string, body: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
}, 180_000);
afterAll(async () => {
  await server?.close();
});

describe('the delivery dashboard', () => {
  it('lists a delivery thread with its runs, cards, pull request, approval and nudges, and the week per bot; spend for an admin only', async () => {
    const dev = ((await post(omar, '/api/teams/engineering/channels', { name: 'dev' }))['channel'] as { id: string }).id;
    const root = String((await post(nadia, `/api/channels/${dev}/messages`, { channelId: dev, body: '@engineer make the widget list keep its sort\nmore words', threadRootId: null }))['id']);
    const reply = await post(nadia, `/api/channels/${dev}/messages`, { channelId: dev, body: 'any news?', threadRootId: root });
    expect(reply['threadRootId']).toBe(root);
    const botId = randomUUID();
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status, placement) VALUES ($1, $2, $3, 'coder', 'Coder', 'agent', 'hermes', 'team', $4, 'active', '{"runs_on":"devbox-codex"}')`, [botId, KAHF_WORKSPACE_ID, TEAM, 'a'.repeat(64)]);
    const runs = [randomUUID(), randomUUID()];
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.bot_runs (id, workspace_id, bot_id, team_id, trigger_type, status, started_at, ended_at, reply_root_id) VALUES ($1, $3, $4, $5, 'mention', 'done', now() - interval '20 minutes', now() - interval '10 minutes', $6), ($2, $3, $4, $5, 'task_assigned', 'failed', now() - interval '9 minutes', now() - interval '8 minutes', $6)`, [runs[0], runs[1], KAHF_WORKSPACE_ID, botId, TEAM, root]);
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.llm_spend (workspace_id, team_id, bot_id, run_id, alias, cost_usd) VALUES ($1, $2, $3, $4, 'smart', 0.42)`, [KAHF_WORKSPACE_ID, TEAM, botId, runs[0]]);
    const task = randomUUID();
    await ownerSql(
      server.db.ownerUrl,
      `INSERT INTO app.tasks (id, workspace_id, team_id, title, kind, branch, thread_root_id, created_by, state, tested_sha, completed_at,
                              pull_request_project, pull_request_number, pull_request_url, pull_request_state, pull_request_origin, pull_request_head_ref, pull_request_head_sha, pull_request_base_ref)
       VALUES ($1, $2, $3, 'Keep the sort', 'code', $4, $5, $6, 'done', $7, now(), 'widgets', 12, 'https://github.com/acme/widgets/pull/12', 'merged', 'https://github.com/acme/widgets', $4, $7, 'main')`,
      [task, KAHF_WORKSPACE_ID, TEAM, `card-${task.slice(0, 8)}`, root, omar.actorId, 'c'.repeat(40)],
    );

    const admin = DeliveriesResponse.parse((await get(omar, '/api/teams/engineering/deliveries?days=7')).body);
    const d = admin.deliveries.find((x) => x.rootId === root)!;
    expect(d).toMatchObject({ channelName: 'dev', runs: 2, failedRuns: 1, bots: ['coder'], cards: 1, doneCards: 1, nudges: 1, spendUsd: 0.42 });
    expect(d.title).toBe('@engineer make the widget list keep its sort');
    expect(d.pullRequests).toEqual([{ number: 12, url: 'https://github.com/acme/widgets/pull/12', state: 'merged' }]);
    expect(d.finishedAt).not.toBeNull();
    expect(d.runMinutes).toBeCloseTo(11, 0);
    expect(admin.bots.find((b) => b.slug === 'coder')).toMatchObject({ runner: 'devbox-codex', runs: 2, failedRuns: 1, spendUsd: 0.42 });

    // a member sees the work, not the money
    const member = DeliveriesResponse.parse((await get(nadia, '/api/teams/engineering/deliveries?days=7')).body);
    expect(member.deliveries.find((x) => x.rootId === root)).toMatchObject({ runs: 2, spendUsd: null });
    expect(member.bots.find((b) => b.slug === 'coder')?.spendUsd).toBeNull();
    expect((await get(nadia, '/api/teams/engineering/deliveries?days=99')).status).not.toBe(200);
  });
});

describe('the weekly report', () => {
  it('says what finished and what is open, the runs, failures and nudges, and what merged; never the money', async () => {
    const { weeklyReport } = await import('../src/deliveries.ts');
    const base = { channelId: randomUUID(), channelName: 'dev', startedAt: new Date().toISOString(), bots: ['coder'], cards: 1, approvals: 0, spendUsd: 3.5 };
    const text = weeklyReport({
      deliveries: [
        { ...base, rootId: randomUUID(), title: 'Keep the sort', finishedAt: new Date().toISOString(), minutes: 42, runs: 6, failedRuns: 1, runMinutes: 30, doneCards: 1, pullRequests: [{ number: 12, url: null, state: 'merged' }], nudges: 1 },
        { ...base, rootId: randomUUID(), title: 'Dark mode', finishedAt: null, minutes: null, runs: 2, failedRuns: 0, runMinutes: 5, doneCards: 0, pullRequests: [], nudges: 0 },
      ],
      bots: [{ slug: 'coder', name: 'Coder', runner: null, runs: 8, failedRuns: 1, avgMinutes: 4, spendUsd: 3.5 }],
    });
    expect(text).toContain('1 finished, 1 open; 8 bot runs (1 failed); 1 nudge from people; merged #12');
    expect(text).toContain('- Keep the sort — 42 min, 6 runs, 1 nudges');
    expect(text).toContain('Still open: Dark mode');
    expect(text).toContain('Failures: Coder 1');
    expect(text).not.toContain('$');
  });
});

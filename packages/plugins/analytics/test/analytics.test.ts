import { createHash, randomUUID } from 'node:crypto';
import { emit, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import type { BotUsageResponse, TeamUsageResponse, WorkspaceUsageResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';
import { appendRows, derivedId, retainEvents, rollupDays, rollupRange, sweepSources, type EventRow } from '../src/index.ts';

// The usage pages end to end (PLAN P8-11): real events through the server and the outbox, the sweep of the three tables no event covers, the rollup, the
// three routes as different people, and a scan of every stored row for text that must never be there.
// Personas: Omar is the workspace admin and Engineering's lead; Nadia is an Engineering member; Tariq leads Marketing (no admin right); Lena is a guest.

const { omar, nadia, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;
vi.setConfig({ testTimeout: 60_000 });

const CANARY = { ip: '198.51.100.88', session: 'CANARY-SESSION-ID-8812', model: 'CANARY-MODEL-NAME-8812' };

let w: RepoWorld;
const ids = { brain: randomUUID(), builder: randomUUID(), helper: randomUUID(), brainRun: randomUUID(), builderRun: randomUUID(), helperRun: randomUUID() };

const emitEvent = (event: Record<string, unknown>): Promise<unknown> =>
  w.system((tx) => emit(tx as Tx, { schemaVersion: 1, workspaceId: omar.workspaceId, ...event } as never));
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const count = async (where = 'true', args: unknown[] = []): Promise<number> =>
  Number((await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.analytics_events WHERE ${where}`, args))).rows[0]!.n);
const usage = <T>(who: typeof omar | null, path: string) => w.call<T & { error?: { code: string } }>(who, 'GET', path);

beforeAll(async () => {
  w = await createRepoWorld();
  await w.system(async (tx) => {
    const bot = (id: string, team: string, slug: string) =>
      tx.query(
        `INSERT INTO app.bots (id, workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, $4, 'agent', 'hermes', 'team', $5, 'active')`,
        [id, omar.workspaceId, team, slug, sha(slug)],
      );
    await bot(ids.brain, ENG, 'brain');
    await bot(ids.builder, ENG, 'builder');
    await bot(ids.helper, MKT, 'helper');
    const run = (id: string, botId: string, team: string, status: string) =>
      tx.query(`INSERT INTO app.bot_runs (id, workspace_id, bot_id, team_id, trigger_type, status, ended_at) VALUES ($1, $2, $3, $4, 'mention', $5, now())`, [id, omar.workspaceId, botId, team, status]);
    await run(ids.brainRun, ids.brain, ENG, 'done');
    await run(ids.builderRun, ids.builder, ENG, 'failed');
    await run(ids.helperRun, ids.helper, MKT, 'done');
    // the tables no event covers
    await tx.query(
      `INSERT INTO app.llm_spend (workspace_id, team_id, bot_id, run_id, session_id, alias, model, prompt_tokens, completion_tokens, cost_usd) VALUES
         ($1, $2, $3, $4, $7, 'smart', $8, 1000, 200, 0.5), ($1, $2, $5, $6, NULL, 'fast', 'small', 100, 20, 0.0125), ($1, $9, $10, NULL, NULL, 'fast', 'small', 10, 10, 0.25)`,
      [omar.workspaceId, ENG, ids.brain, ids.brainRun, ids.builder, ids.builderRun, CANARY.session, CANARY.model, MKT, ids.helper],
    );
    await tx.query(
      `INSERT INTO app.run_decisions (run_id, seq, kind, subject, outcome) VALUES ($1, 0, 'tool', 'files.write', 'allowed'), ($1, 1, 'tool', 'shell.run', 'denied'), ($1, 2, 'guard', 'smart', 'allow'), ($2, 0, 'tool', 'files.read', 'needs_approval')`,
      [ids.builderRun, ids.helperRun],
    );
    await tx.query(
      `INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, 0, 'knowledge', 'doc-1', 'team'), ($1, 1, 'knowledge', 'doc-2', 'person'), ($1, 2, 'message', 'm-1', 'channel')`,
      [ids.brainRun],
    );
    await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, budget_window, limit_usd) VALUES ($1, 'workspace', 'month', 10)`, [omar.workspaceId]);
  });

  // the events the platform writes while it works
  for (const [teamId, botId, runId, status] of [[ENG, ids.brain, ids.brainRun, 'done'], [ENG, ids.builder, ids.builderRun, 'failed'], [MKT, ids.helper, ids.helperRun, 'done']] as const) {
    await emitEvent({ type: 'bots.run.closed', teamId, botId, runId, trigger: 'mention', status });
  }
  const approvalId = randomUUID();
  await emitEvent({ type: 'approvals.approval.requested', teamId: ENG, approvalId, source: 'dispatch', tool: 'files.write', botId: ids.builder, runId: ids.builderRun, requesterId: omar.actorId });
  await emitEvent({ type: 'approvals.approval.decided', teamId: ENG, approvalId, source: 'dispatch', tool: 'files.write', botId: ids.builder, requesterId: omar.actorId, deciderId: omar.actorId, decision: 'approved' });
  const answer = { type: 'answer.answer.posted', botId: ids.brain, runId: ids.brainRun, channelId: randomUUID(), messageId: randomUUID(), threadRootId: null, citationCount: 3, droppedCount: 1, reachedCount: 6 };
  await emitEvent({ ...answer, askerPersonId: nadia.personId });
  await emitEvent({ ...answer, messageId: randomUUID(), askerPersonId: null, citationCount: 1, droppedCount: 0, reachedCount: 2 });
  await emitEvent({ type: 'identity.session.signed_in', personId: omar.personId, sessionId: randomUUID(), method: 'password', ip: CANARY.ip });
  await emitEvent({ type: 'identity.session.sign_in_failed', personId: nadia.personId, method: 'password', reason: 'wrong_password', ip: CANARY.ip });

  // the events are handed on by the outbox: wait for the last of them
  await vi.waitFor(async () => expect(await count(`metric IN ('run.count', 'approval.decided', 'answer.scoped', 'answer.full', 'signin.ok', 'signin.failed')`)).toBe(3 + 1 + 2 + 1 + 1), { timeout: 30_000, interval: 300 });
}, 240_000);

afterAll(async () => {
  await w?.close();
});

describe('the live emitters', () => {
  it('count a closed run, an approval, an answer (scoped or full) and a sign-in, each under the team and the bot it belongs to', async () => {
    const rows = (await w.system((tx) => tx.query<{ metric: string; team_id: string | null; bot_id: string | null; actor_id: string | null; value: number; dims: Record<string, unknown> }>(
      `SELECT metric, team_id, bot_id, actor_id, value, dims FROM app.analytics_events WHERE metric NOT LIKE 'llm.%' AND metric NOT IN ('tool.call', 'knowledge.hit') ORDER BY metric, value`,
    ))).rows;
    const of = (metric: string) => rows.filter((r) => r.metric === metric);
    expect(of('run.count').map((r) => [r.team_id, r.dims['status']]).sort()).toEqual([[ENG, 'done'], [ENG, 'failed'], [MKT, 'done']].sort());
    expect(of('approval.requested')).toHaveLength(1);
    expect(of('approval.decided')[0]).toMatchObject({ team_id: ENG, bot_id: ids.builder, dims: { decision: 'approved' } });
    // the answer event carries no team: the run's own row says it (Engineering)
    expect(of('answer.scoped')).toEqual([expect.objectContaining({ team_id: ENG, bot_id: ids.brain })]);
    expect(of('answer.full')).toEqual([expect.objectContaining({ team_id: ENG, bot_id: ids.brain })]);
    expect(of('answer.citations').map((r) => r.value).sort()).toEqual([1, 3]);
    expect(of('answer.dropped').map((r) => r.value).sort()).toEqual([0, 1]);
    // a sign-in belongs to a person, not to a team
    expect(of('signin.ok')[0]).toMatchObject({ actor_id: omar.actorId, team_id: null, dims: { method: 'password' } });
    expect(of('signin.failed')[0]).toMatchObject({ actor_id: nadia.actorId, team_id: null, dims: { reason: 'wrong_password' } });
  });
});

describe('the sweep of the tables no event covers', () => {
  it('stores a model call, a tool call and a knowledge document once each, and again changes nothing', async () => {
    const now = new Date();
    const first = await w.system((tx) => sweepSources(tx as unknown as PluginTx, now));
    expect(first.find((r) => r.source === 'run_decisions')?.read).toBe(3);
    const stored = await count(`metric IN ('llm.cost_micro', 'llm.tokens', 'tool.call', 'knowledge.hit')`);
    expect(stored).toBe(3 + 3 + 3 + 2);
    await w.system((tx) => sweepSources(tx as unknown as PluginTx, new Date(now.getTime() + 60_000)));
    expect(await count(`metric IN ('llm.cost_micro', 'llm.tokens', 'tool.call', 'knowledge.hit')`)).toBe(stored);
  });

  it('keeps what a gate decided out of the tool calls, and a message out of the knowledge hits', async () => {
    const kinds = (await w.system((tx) => tx.query<{ metric: string; dims: Record<string, string> }>(`SELECT metric, dims FROM app.analytics_events WHERE metric IN ('tool.call', 'knowledge.hit')`))).rows;
    expect(kinds.filter((r) => r.metric === 'tool.call').map((r) => r.dims['outcome']).sort()).toEqual(['allowed', 'denied', 'needs_approval']);
    expect(kinds.filter((r) => r.metric === 'knowledge.hit').map((r) => r.dims['scope']).sort()).toEqual(['person', 'team']);
  });
});

describe('the rollup', () => {
  it('adds the last two days up, and running it again gives the same rows', async () => {
    const now = new Date();
    const first = await w.system((tx) => rollupDays(tx as unknown as PluginTx, now));
    expect(first.groups).toBeGreaterThan(0);
    const snapshot = async () => (await w.system((tx) => tx.query(`SELECT day::text, team_id, bot_id, metric, dim, total, n FROM app.analytics_daily ORDER BY 1, 2, 3, 4, 5`))).rows;
    const a = await snapshot();
    await w.system((tx) => rollupDays(tx as unknown as PluginTx, now));
    expect(await snapshot()).toEqual(a);
    // a sign-in has no team and no bot: its row is one row, not one per run (NULLS NOT DISTINCT)
    expect(a.filter((r) => r.metric === 'signin.ok')).toHaveLength(1);
  });
});

describe('the usage pages', () => {
  it('give a workspace admin the whole workspace, money and budget included', async () => {
    const res = await usage<WorkspaceUsageResponse>(omar, '/api/workspace/usage?days=7');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body;
    expect(b.range.days).toBe(7);
    expect(b.daily).toHaveLength(7);
    expect(b.totals).toMatchObject({ runs: 3, failedRuns: 1, toolCalls: 3, toolsRefused: 1, toolsHeldForApproval: 1, approvalsAsked: 1, approvalsApproved: 1, approvalsDenied: 0, answers: 2, answersScoped: 1, answersFull: 1, knowledgeHits: 2 });
    expect(b.totals.spendUsd).toBeCloseTo(0.7625, 6);
    expect(b.totals.llmCalls).toBe(3);
    expect(b.spendByAlias.map((a) => a.alias)).toEqual(['smart', 'fast']);
    expect(b.budget).toMatchObject({ scope: 'workspace', window: 'month', limitUsd: 10 });
    expect(b.budget!.spentUsd).toBeGreaterThanOrEqual(0.7625);
    expect(b.quality).toMatchObject({ answers: 2, scoped: 1, full: 1, citations: 4, dropped: 1, sourcesReached: 8 });
    expect(b.quality.droppedShare).toBeCloseTo(0.2, 6);
    expect(b.signIns).toMatchObject({ ok: 1, failed: 1, byMethod: [{ method: 'password', count: 1 }] });
    expect(b.teams.map((t) => t.slug).sort()).toEqual(['engineering', 'marketing']);
    expect(b.bots.map((r) => r.slug).sort()).toEqual(['brain', 'builder', 'helper']);
    expect(b.daily.at(-1)!.runs).toBe(b.totals.runs);
  });

  it('are closed to everyone but a workspace admin (the workspace page), and to a stranger', async () => {
    expect((await usage(nadia, '/api/workspace/usage')).status).toBe(403);
    expect((await usage(tariq, '/api/workspace/usage')).status).toBe(403);
    expect((await usage(lena, '/api/workspace/usage')).status).toBe(403);
    expect((await usage(null, '/api/workspace/usage')).status).toBe(401);
    expect((await usage(omar, '/api/workspace/usage?days=0')).status).toBe(400);
    expect((await usage(omar, '/api/workspace/usage?days=9999')).status).toBe(400);
  });

  it('give a team member their team without any money, and Brain quality from the team\'s Brain', async () => {
    const res = await usage<TeamUsageResponse>(nadia, '/api/teams/engineering/usage');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body;
    expect(b.team).toMatchObject({ slug: 'engineering' });
    expect(b.brainSlug).toBe('brain');
    expect(b.totals.spendUsd).toBeNull();
    expect(b.totals.tokens).toBeNull();
    expect(b.totals.llmCalls).toBeNull();
    expect(b.spendByAlias).toEqual([]);
    expect(b.budget).toBeNull();
    expect(b.bots.every((r) => r.spendUsd === null)).toBe(true);
    expect(b.daily.every((d) => d.spendUsd === null)).toBe(true);
    expect(b.totals.runs).toBe(2);
    expect(b.bots.map((r) => r.slug).sort()).toEqual(['brain', 'builder']);
    expect(b.quality).toMatchObject({ answers: 2, scoped: 1, full: 1, citations: 4, dropped: 1 });
    // nothing of Marketing in it
    expect(JSON.stringify(b)).not.toContain('helper');
  });

  it('give an admin a team page with the team\'s spend', async () => {
    const res = await usage<TeamUsageResponse>(omar, '/api/teams/marketing/usage');
    expect(res.status).toBe(200);
    expect(res.body.totals.spendUsd).toBeCloseTo(0.25, 6);
    expect(res.body.spendByAlias).toEqual([expect.objectContaining({ alias: 'fast', calls: 1 })]);
    expect(res.body.brainSlug).toBeNull(); // no Brain here: the quality is of all its answers
  });

  it('keep one team away from another, and a guest away from every team', async () => {
    expect((await usage(tariq, '/api/teams/engineering/usage')).status).toBe(403);
    expect((await usage(nadia, '/api/teams/marketing/usage')).status).toBe(403);
    expect((await usage(lena, '/api/teams/engineering/usage')).status).toBe(403);
    expect((await usage(null, '/api/teams/engineering/usage')).status).toBe(401);
    expect((await usage(tariq, '/api/teams/engineering/bots/builder/usage')).status).toBe(403);
    expect((await usage(lena, '/api/teams/engineering/bots/builder/usage')).status).toBe(403);
  });

  it('give a bot its own numbers, and answer the same for a bot that is not there and one of another team', async () => {
    const res = await usage<BotUsageResponse>(nadia, '/api/teams/engineering/bots/builder/usage');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.bot.slug).toBe('builder');
    expect(res.body.totals).toMatchObject({ runs: 1, failedRuns: 1, toolCalls: 2, toolsRefused: 1, approvalsAsked: 1, spendUsd: null });
    const admin = await usage<BotUsageResponse>(omar, '/api/teams/engineering/bots/builder/usage');
    expect(admin.body.totals.spendUsd).toBeCloseTo(0.0125, 6);
    const missing = await usage(omar, '/api/teams/engineering/bots/nobody/usage');
    const foreign = await usage(omar, '/api/teams/engineering/bots/helper/usage');
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error?.code).toBe(missing.body.error?.code);
  });
});

describe('older days come from the daily rows', () => {
  it('reads a day five days ago from its rollup and not from the events, and keeps the month it came from', async () => {
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 5, 10));
    const row: EventRow = { id: randomUUID(), occurredAt: day, workspaceId: omar.workspaceId, teamId: MKT, actorId: null, botId: ids.helper, metric: 'run.count', value: 1, dims: { status: 'done' } };
    await w.system((tx) => appendRows(tx as unknown as PluginTx, [row, { ...row, id: randomUUID() }], now));
    await w.system((tx) => rollupRange(tx as unknown as PluginTx, new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())), new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1))));
    const daily = Number((await w.system((tx) => tx.query<{ n: string }>(`SELECT coalesce(sum(n), 0)::text AS n FROM app.analytics_daily WHERE metric = 'run.count' AND day = $1::date`, [day.toISOString().slice(0, 10)]))).rows[0]!.n);
    expect(daily).toBe(2);
    const res = await usage<TeamUsageResponse>(tariq, '/api/teams/marketing/usage?days=7');
    expect(res.body.daily.find((d) => d.day === day.toISOString().slice(0, 10))?.runs).toBe(2);
    // a 3-day look-back does not reach it
    const short = await usage<TeamUsageResponse>(tariq, '/api/teams/marketing/usage?days=3');
    expect(short.body.totals.runs).toBe(1);
  });
});

describe('content-blind', () => {
  it('stores no text that a person or a bot wrote or read: only ids, numbers and fixed words', async () => {
    const stored = JSON.stringify((await w.system((tx) => tx.query(`SELECT metric, value, dims, team_id, actor_id, bot_id FROM app.analytics_events`))).rows)
      + JSON.stringify((await w.system((tx) => tx.query(`SELECT metric, dim FROM app.analytics_daily`))).rows);
    for (const canary of [CANARY.ip, CANARY.session, 'doc-1', 'doc-2', 'm-1']) expect(stored).not.toContain(canary);
    // every label is short and plain
    const labels = (await w.system((tx) => tx.query<{ dim: string }>(`SELECT DISTINCT dim FROM app.analytics_daily`))).rows.map((r) => r.dim);
    expect(labels.every((l) => /^[a-z_ .:-]{0,40}$/i.test(l))).toBe(true);
  });
});

describe('retention', () => {
  it('rolls a month up before it is detached, so its days stay in the pages', async () => {
    const now = new Date();
    const old = new Date(Date.UTC(now.getUTCFullYear() - 3, 0, 15, 12));
    const detachedNames = await w.system(async (tx) => {
      // a window reaching back that far, only for this test's write
      await tx.query(`SELECT app.analytics_ensure_month($1::date, $1::date)`, [`${old.getUTCFullYear()}-01-01`]);
      await tx.query(`INSERT INTO app.analytics_events (id, occurred_at, workspace_id, team_id, bot_id, metric, value, dims) VALUES ($1, $2, $3, $4, $5, 'run.count', 1, '{"status":"done"}')`, [randomUUID(), old.toISOString(), omar.workspaceId, MKT, ids.helper]);
      return retainEvents(tx as unknown as PluginTx, now);
    });
    expect(detachedNames.some((n) => n.startsWith(`analytics_events_${old.getUTCFullYear()}_01_detached_`))).toBe(true);
    const kept = await w.system((tx) => tx.query<{ n: string }>(`SELECT sum(n)::text AS n FROM app.analytics_daily WHERE metric = 'run.count' AND day = $1::date`, [old.toISOString().slice(0, 10)]));
    expect(Number(kept.rows[0]?.n)).toBe(1);
  });
});

describe('delivery twice', () => {
  it('counts an event once even when it is delivered twice', async () => {
    const before = await count();
    const row: EventRow = { id: derivedId(randomUUID(), 'run.count'), occurredAt: new Date(), workspaceId: omar.workspaceId, teamId: ENG, actorId: null, botId: ids.brain, metric: 'run.count', value: 1, dims: { status: 'done' } };
    await w.system((tx) => appendRows(tx as unknown as PluginTx, [row], new Date()));
    await w.system((tx) => appendRows(tx as unknown as PluginTx, [row], new Date()));
    expect(await count()).toBe(before + 1);
  });
});

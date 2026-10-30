import { seedRepo } from '@manythreads/test-utils';
import type { EvalRun, GetBotEvalsResponse, RunEvalsResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';
import { setEvalAnswererOverride } from '../src/evals.ts';

// A bot's evals on the server (PLAN P7-08): a lead runs the set on demand and a member may not; a run is judged against BOT.md's minimum; an applied
// change to BOT.md (a proposal) starts a run of its own and a score below the minimum is flagged; the nightly pass and the stale-run pass work
// off the same job. The run is a job, so every assertion that follows a start waits for it.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 90_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
  await seedRepo(w.server.db, { attachments: false });
}, 180_000);
afterAll(async () => {
  setEvalAnswererOverride(null);
  await w?.close();
});

const team = 'engineering';
type Who = typeof omar;

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 40_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

const botMd = (name: string, native: string, evals: string | null): string => `---
schema: 1
name: ${name}
role: Answers in the evals tests
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [${native}]
model:
  aliases: [smart]
${evals === null ? '' : `evals:\n  set: ${evals}\n  minScore: 0.9\n`}---

# ${name}

Answer from the sources you can open. Say so when you do not know.
`;

const setYaml = (name: string): string => `schema: 1
set: ${name}
cases:
  - id: posts-its-answer
    question: What is the release step?
    expect:
      toolCalls:
        required: [answer.post]
    rationale: The bot has to post its answer.
  - id: posts-again
    question: And the next one?
    expect:
      mentions: ["canary"]
      toolCalls:
        required: [answer.post]
    rationale: And it has to keep saying the word.
`;

const getEvals = (who: Who, slug: string) => w.call<GetBotEvalsResponse>(who, 'GET', `/api/teams/${team}/bots/${slug}/evals`);
const runEvals = (who: Who, slug: string, body: Record<string, unknown> = {}) => w.call<RunEvalsResponse>(who, 'POST', `/api/teams/${team}/bots/${slug}/evals/run`, body);
const botLoaded = (slug: string) =>
  until(async () => (await w.call<{ bot: { id: string } }>(nadia, 'GET', `/api/teams/${team}/bots/${slug}`)).status === 200, `${slug} to load`);
const finished = (slug: string, pick: (r: EvalRun) => boolean = (r) => r.trigger === 'on_demand'): Promise<EvalRun> =>
  until(async () => {
    const body = (await getEvals(nadia, slug)).body;
    const hit = body.recent.find((r) => r.status !== 'running' && pick(r));
    return hit ? (body.latest?.id === hit.id ? body.latest : hit) : null;
  }, `a finished run of ${slug}`);

async function addBot(slug: string, native: string, evals: string | null, withSet = true): Promise<void> {
  const changes = [
    { op: 'put' as const, path: `bots/${slug}/BOT.md`, content: botMd(slug, native, evals) },
    ...(evals !== null && withSet ? [{ op: 'put' as const, path: `bots/${slug}/evals/${evals}.yaml`, content: setYaml(evals) }] : []),
  ];
  expect((await w.commit(omar, team, changes, `Add ${slug}`)).status).toBe(201);
  await botLoaded(slug);
  // adding a bot with a set is itself a change to its BOT.md: wait for the run that starts, so no test meets it half way
  if (evals !== null) {
    await until(async () => (await getEvals(nadia, slug)).body.recent.find((r) => r.trigger === 'on_commit'), `the first run of ${slug}`);
    await jobsIdle();
  }
}

describe('running a bot\'s evals on demand', () => {
  it('a lead runs the set; the verdict is judged against the minimum; a member reads it but cannot run', async () => {
    await addBot('p708-good', 'answer.post', 'qa');
    const started = await runEvals(omar, 'p708-good');
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(started.body.run).toMatchObject({ status: 'running', trigger: 'on_demand', mode: 'static', botSlug: 'p708-good' });

    const run = await finished('p708-good');
    // the second case also asks for words, which the free mode cannot judge: it passes on the call it requires and says the words were skipped
    expect(run).toMatchObject({ status: 'finished', set: 'qa', minScore: 0.9, total: 2, judged: 2, passed: 2, score: 1, ok: true, trigger: 'on_demand' });
    expect(run.commitSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(run.results.map((r) => r.skipped)).toEqual([[], ['mentions']]);

    const asMember = await getEvals(nadia, 'p708-good');
    expect(asMember.status).toBe(200);
    expect(asMember.body.canRun).toBe(false);
    expect(asMember.body.set).toEqual({ name: 'qa', minScore: 0.9 });
    expect(asMember.body.latest?.results.map((r) => r.caseId)).toEqual(['posts-its-answer', 'posts-again']);
    expect((await getEvals(omar, 'p708-good')).body.canRun).toBe(true);

    const refused = await runEvals(nadia, 'p708-good');
    expect(refused.status).toBe(403);
  });

  it('a bot whose definition lacks a required call scores below the minimum and the run says ok: false', async () => {
    await addBot('p708-weak', 'messages.post', 'qa');
    expect((await runEvals(omar, 'p708-weak')).status).toBe(202);
    const run = await finished('p708-weak');
    expect(run).toMatchObject({ status: 'finished', total: 2, passed: 0, score: 0, ok: false });
    expect(run.results.every((r) => !r.passed && r.reasons.some((x) => x.includes('answer.post')))).toBe(true);
  });

  it('a second run is refused while one is open, and an unknown bot is 404', async () => {
    await w.system(async (tx) => {
      const bot = (await tx.query<{ id: string }>("SELECT id FROM app.bots WHERE slug = 'p708-good'")).rows[0]!;
      await tx.query(
        `INSERT INTO app.bot_eval_runs (workspace_id, team_id, bot_id, bot_slug, set_name, trigger, mode) VALUES ($1, $2, $3, 'p708-good', 'qa', 'nightly', 'static')`,
        [omar.workspaceId, (await tx.query<{ team_id: string }>('SELECT team_id FROM app.bots WHERE id = $1', [bot.id])).rows[0]!.team_id, bot.id],
      );
    });
    expect((await runEvals(omar, 'p708-good')).status).toBe(409);
    expect((await runEvals(omar, 'no-such-bot')).status).toBe(404);
    // the hourly pass ends a run that has been open too long
    await w.system((tx) => tx.query("UPDATE app.bot_eval_runs SET started_at = now() - interval '3 hours' WHERE status = 'running'"));
    await queue('bots.eval-reap');
    const after = (await getEvals(nadia, 'p708-good')).body.recent;
    expect(after.some((r) => r.status === 'failed' && r.error?.includes('did not finish'))).toBe(true);
  });

  it('two requests at once start one run: the other is 409 (a lock per bot, not a read-then-write)', async () => {
    await addBot('p708-race', 'answer.post', 'qa');
    const answers = await Promise.all(Array.from({ length: 6 }, () => runEvals(omar, 'p708-race')));
    expect(answers.map((a) => a.status).sort(), JSON.stringify(answers.map((a) => a.body))).toEqual([202, 409, 409, 409, 409, 409]);
    await finished('p708-race');
    const rows = await w.system(async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.bot_eval_runs WHERE bot_slug = 'p708-race' AND trigger = 'on_demand'")).rows[0]!.n));
    expect(rows).toBe(1);
  });

  it('the same commit delivered twice makes one run', async () => {
    await addBot('p708-twice', 'answer.post', 'qa');
    await jobsIdle(); // the first delivery must be finished before it is counted (under load the run row lands after addBot returns)
    const rowsOf = () => w.system(async (tx) => (await tx.query<{ commit_sha: string }>("SELECT commit_sha FROM app.bot_eval_runs WHERE bot_slug = 'p708-twice' AND trigger = 'on_commit'")).rows);
    const first = await rowsOf();
    expect(new Set(first.map((r) => r.commit_sha)).size, JSON.stringify(first)).toBe(first.length);
    // the outbox delivers at least once: the same event again, long after the first job ended
    await w.system(async (tx) => {
      const t = (await tx.query<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM app.teams WHERE slug = $1', [team])).rows[0]!;
      await tx.query("SELECT app.enqueue_job('bots.eval-run', $1::jsonb, NULL, NULL)", [
        JSON.stringify({ workspaceId: t.workspace_id, teamId: t.id, botSlug: 'p708-twice', serial: `${t.id}:p708-twice`, trigger: 'on_commit', mode: 'static', runId: null, commitSha: first[first.length - 1]!.commit_sha }),
      ]);
    });
    await jobsIdle();
    expect(await rowsOf()).toHaveLength(first.length);
  });

  it('a bot with no set: an on-demand run fails in plain words, a commit makes no row', async () => {
    await addBot('p708-bare', 'answer.post', null);
    expect((await runEvals(omar, 'p708-bare')).status).toBe(202);
    const run = await finished('p708-bare');
    expect(run).toMatchObject({ status: 'failed', ok: null, total: 0 });
    expect(run.error).toContain('does not name a scenario set');
    // the failed run carries the placeholder name "-": it is not the bot's set
    expect((await getEvals(nadia, 'p708-bare')).body.set).toBeNull();
  });

  it('a set file that is missing fails the run and names the file', async () => {
    await addBot('p708-nofile', 'answer.post', 'qa', false);
    expect((await runEvals(omar, 'p708-nofile')).status).toBe(202);
    const run = await finished('p708-nofile');
    expect(run.status).toBe('failed');
    expect(run.error).toContain('bots/p708-nofile/evals/qa.yaml');
  });
});

describe('the model mode', () => {
  it('runs every case through the answerer and judges all assertions; an answerer that cannot answer fails the run', async () => {
    setEvalAnswererOverride(() => ({
      mode: 'model',
      async answer() {
        return {
          answer: { body: 'Hold the canary for thirty minutes.', citations: [], outsideScope: { count: 0, items: [] }, chips: [], toolCalls: ['answer.post'] },
          tokens: 42,
        };
      },
    }));
    expect((await runEvals(omar, 'p708-good', { mode: 'model' })).status).toBe(202);
    const run = await finished('p708-good', (r) => r.mode === 'model');
    expect(run).toMatchObject({ mode: 'model', status: 'finished', total: 2, passed: 2, ok: true, costTokens: 84 });

    setEvalAnswererOverride(() => ({
      mode: 'model',
      async answer() {
        // the second case misses the word the set asks for
        return { answer: { body: 'Nothing.', citations: [], outsideScope: { count: 0, items: [] }, chips: [], toolCalls: ['answer.post'] }, tokens: 1 };
      },
    }));
    await w.system((tx) => tx.query("UPDATE app.bot_eval_runs SET started_at = now() - interval '3 hours' WHERE status = 'running'"));
    expect((await runEvals(omar, 'p708-good', { mode: 'model' })).status).toBe(202);
    const worse = await until(async () => (await getEvals(nadia, 'p708-good')).body.recent.find((r) => r.mode === 'model' && r.status === 'finished' && r.passed === 1), 'the worse model run');
    expect(worse).toMatchObject({ passed: 1, score: 0.5, ok: false });
    expect((await getEvals(nadia, 'p708-good')).body.latest?.results.find((r) => !r.passed)?.reasons[0]).toContain('canary');

    setEvalAnswererOverride(null);
    // without a gateway binding for the alias there is no model to ask: the run fails and says why
    expect((await runEvals(omar, 'p708-good', { mode: 'model' })).status).toBe(202);
    const none = await until(async () => (await getEvals(nadia, 'p708-good')).body.recent.find((r) => r.mode === 'model' && r.status === 'failed'), 'the failed model run');
    expect(none.error).toMatch(/alias|model|gateway/i);
  });
});

describe('a change to BOT.md or its set', () => {
  it('an applied proposal for BOT.md runs the set at that commit, and a worse definition is flagged', async () => {
    const before = (await getEvals(nadia, 'p708-good')).body.recent.length;
    const seen = new Set((await getEvals(nadia, 'p708-good')).body.recent.map((r) => r.id));
    const worse = botMd('p708-good', 'messages.post', 'qa');
    const res = await w.call<{ proposal: { proposal: { status: string } } }>(omar, 'POST', `/api/teams/${team}/proposals`, { path: 'bots/p708-good/BOT.md', content: worse, applyNow: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await until(async () => (await getEvals(nadia, 'p708-good')).body.recent.find((r) => r.trigger === 'on_commit' && !seen.has(r.id)), 'the on-commit run');
    await jobsIdle();
    const run = (await getEvals(nadia, 'p708-good')).body.recent.find((r) => r.trigger === 'on_commit' && !seen.has(r.id))!;
    expect(run).toMatchObject({ trigger: 'on_commit', mode: 'static', status: 'finished', passed: 0, ok: false });
    expect(run.commitSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect((await getEvals(nadia, 'p708-good')).body.recent.length).toBeGreaterThan(before);

    // the event says so, without any case's text
    const events = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'bots.eval.run.finished' ORDER BY id")).rows);
    expect(events.some((e) => e.payload['slug'] === 'p708-good' && e.payload['trigger'] === 'on_commit' && e.payload['ok'] === false)).toBe(true);
  });

  it('a change to a file that is not a bot\'s BOT.md or set starts no run; a bot with no set starts none', async () => {
    const count = async (): Promise<number> => w.system(async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.bot_eval_runs WHERE bot_slug = 'p708-bare'")).rows[0]!.n));
    const before = await count();
    expect((await w.call(omar, 'POST', `/api/teams/${team}/proposals`, { path: 'TEAM.md', content: '# Team\n\nHello\n', applyNow: true })).status).toBe(201);
    expect(
      (await w.call(omar, 'POST', `/api/teams/${team}/proposals`, { path: 'bots/p708-bare/BOT.md', content: botMd('p708-bare', 'answer.post', null).replace('Answer from', 'Please answer from'), applyNow: true })).status,
    ).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await count()).toBe(before);
  });
});

describe('the nightly pass', () => {
  it('queues a static run for every active bot that has a set, and none for the others', async () => {
    const mark = await w.system(async (tx) => (await tx.query<{ now: Date }>('SELECT now()')).rows[0]!.now);
    await w.system((tx) => tx.query("UPDATE app.bot_eval_runs SET started_at = now() - interval '3 hours' WHERE status = 'running'"));
    await queue('bots.eval-nightly');
    await until(
      async () => {
        const rows = await w.system(async (tx) => (await tx.query<{ bot_slug: string }>("SELECT bot_slug FROM app.bot_eval_runs WHERE trigger = 'nightly' AND started_at >= $1 AND status <> 'running'", [mark])).rows);
        return rows.length >= 3 ? rows : null;
      },
      'the nightly runs',
    );
    const slugs = await w.system(async (tx) => (await tx.query<{ bot_slug: string }>("SELECT DISTINCT bot_slug FROM app.bot_eval_runs WHERE trigger = 'nightly' AND started_at >= $1", [mark])).rows.map((r) => r.bot_slug));
    expect(slugs).toContain('p708-good');
    expect(slugs).not.toContain('p708-bare');
  });
});

/** Every eval job has ended (a commit can queue more than one, and a test must not meet one half way). */
const jobsIdle = (): Promise<true> =>
  until(
    async () =>
      w.system(async (tx) => ((await tx.query("SELECT 1 FROM app.jobs WHERE queue = 'bots.eval-run' AND state NOT IN ('done', 'dead') LIMIT 1")).rows.length === 0 ? true : null)),
    'the eval jobs to end',
  ) as Promise<true>;

/** Run a cron queue now: the same trick the reaper test uses. */
async function queue(name: string): Promise<void> {
  const job = await w.system(async (tx) => {
    const id = (await tx.query<{ id: string }>("SELECT (app.enqueue_job($1, '{}'::jsonb, now() + interval '1 hour', NULL)).id AS id", [name])).rows[0]!.id;
    await tx.query('UPDATE app.jobs SET run_at = now() WHERE id = $1', [id]);
    await tx.query("SELECT pg_notify('manythreads_jobs', $1)", [name]);
    return id;
  });
  await until(async () => w.system(async (tx) => (['done', 'dead'].includes((await tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [job])).rows[0]?.state ?? '') ? true : null)), `the ${name} job`);
}

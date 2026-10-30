import type { PluginContext, PluginEvent, PluginTx, RepoProvider } from '@manythreads/sdk';
import {
  EvalResult,
  ProposalsProposalAppliedEvent,
  evalBotOfPath,
  loadBotEval,
  runEvalSet,
  staticAnswerer,
  type Answerer,
  type EvalMode,
  type EvalRun,
  type EvalTrigger,
  type LoadedEval,
} from '@manythreads/shared';
import { EvalModelUnavailable, modelAnswerer, type LlmEvalDoor } from './evals-answerer.ts';

// Running a bot's scenario set on the server (PLAN P7-08). Three things start a run, and all of them end in the one job below:
//  - a lead or admin asks for it (the route, evals-routes.ts): `on_demand`, static or with the model;
//  - a proposal that changed `bots/<slug>/BOT.md` or a file in its `evals/` folder was applied (`proposals.proposal.applied`): `on_commit`, static;
//  - the nightly pass: every active bot that has a set, `nightly`, static.
// The commit and nightly runs are free on purpose: nobody asked for them, so they must not spend money. They judge what a definition decides
// (the calls a case requires), which is exactly what a change that takes a capability away breaks; the cases that need the model's words are
// shown as "not checked" until someone runs the set with the model.
//
// The subscriber only marks the work (it enqueues a job): reading the repo and judging are not done in the outbox consumer's transaction. The job is
// `detached`: its reads and its final write are each one short system transaction, and nothing waits on the model inside one.

export const EVAL_QUEUE = 'bots.eval-run';
export const EVAL_NIGHTLY_QUEUE = 'bots.eval-nightly';
export const EVAL_REAP_QUEUE = 'bots.eval-reap';
/**
 * The most prompt text one model run may send (UTF-16 code units, the bot's prompt once per case plus a generous allowance for a case's world). A
 * BOT.md may be 256 KB and a set has up to 100 cases: unchecked, one click could send tens of megabytes to a paid model.
 */
export const EVAL_MODEL_MAX_PROMPT_CHARS = 2_000_000;
const EVAL_CASE_WORLD_CHARS = 8_000;
const EVAL_MAX_ATTEMPTS = 4;
/** A run still `running` this long after it started lost its worker; the hourly pass ends it as failed. */
export const EVAL_STALE_MINUTES = 60;

export type EvalRunRow = {
  id: string;
  bot_slug: string;
  set_name: string;
  commit_sha: string | null;
  trigger: string;
  mode: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  total: number;
  judged: number;
  passed: number;
  score: number | null;
  min_score: number;
  ok: boolean | null;
  cost_tokens: number;
  error: string | null;
  results: unknown;
};

export const EVAL_RUN_COLUMNS =
  'id, bot_slug, set_name, commit_sha, trigger, mode, status, started_at, finished_at, total, judged, passed, score, min_score, ok, cost_tokens, error, results';

/** The row as the API shows it. `withResults: false` leaves the per-case verdicts out (the list of recent runs). */
export function toEvalRun(r: EvalRunRow, withResults = true): EvalRun {
  const results = withResults && Array.isArray(r.results) ? r.results.flatMap((x) => {
    const parsed = EvalResult.safeParse(x);
    return parsed.success ? [parsed.data] : [];
  }) : [];
  return {
    id: r.id as EvalRun['id'],
    botSlug: r.bot_slug,
    set: r.set_name,
    commitSha: r.commit_sha,
    trigger: r.trigger as EvalTrigger,
    mode: r.mode as EvalMode,
    status: r.status as EvalRun['status'],
    startedAt: r.started_at.toISOString() as EvalRun['startedAt'],
    finishedAt: r.finished_at === null ? null : (r.finished_at.toISOString() as EvalRun['finishedAt']),
    total: r.total,
    judged: r.judged,
    passed: r.passed,
    score: r.score,
    minScore: r.min_score,
    ok: r.ok,
    costTokens: r.cost_tokens,
    error: r.error,
    results,
  };
}

/** Tests replace the answerer of a `model` run (the real one calls the gateway). Null puts the real one back. */
let answererOverride: ((def: { botId: string; runId: string }) => Answerer) | null = null;
export function setEvalAnswererOverride(fn: ((def: { botId: string; runId: string }) => Answerer) | null): void {
  answererOverride = fn;
}

interface JobPayload {
  workspaceId: string;
  teamId: string;
  botSlug: string;
  trigger: EvalTrigger;
  mode: EvalMode;
  /** An on-demand run is made by the route; the job finds it by this id. */
  runId: string | null;
  /** The commit an `on_commit` run was caused by. */
  commitSha: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readPayload(raw: Record<string, unknown>): JobPayload | null {
  const s = (k: string): string | null => (typeof raw[k] === 'string' ? (raw[k] as string) : null);
  const workspaceId = s('workspaceId');
  const teamId = s('teamId');
  const botSlug = s('botSlug');
  const trigger = s('trigger');
  const mode = s('mode');
  const runId = s('runId');
  const commitSha = s('commitSha');
  if (!workspaceId || !UUID.test(workspaceId) || !teamId || !UUID.test(teamId) || !botSlug) return null;
  if (trigger !== 'on_demand' && trigger !== 'on_commit' && trigger !== 'nightly') return null;
  if (mode !== 'static' && mode !== 'model') return null;
  if (runId !== null && !UUID.test(runId)) return null;
  return { workspaceId, teamId, botSlug, trigger, mode, runId, commitSha: commitSha !== null && /^[0-9a-f]{40,64}$/.test(commitSha) ? commitSha : null };
}

/** Plain words for a failure of the run itself. */
function plain(err: unknown): string {
  if (err instanceof EvalModelUnavailable) return err.message.slice(0, 900);
  return 'The run stopped before it could finish. Run it again; if it keeps failing, ask an administrator to look at the server log.';
}

async function readFileAt(repo: RepoProvider, tx: PluginTx, teamId: string, path: string, ref: string): Promise<string | null> {
  try {
    return Buffer.from((await repo.blob(tx, teamId, path, ref)).content).toString('utf8');
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

type Started =
  | { kind: 'skip' }
  | { kind: 'fail'; runId: string; botId: string; message: string }
  | { kind: 'run'; runId: string; botId: string; loaded: LoadedEval };

/** Step 1: find or make the run's row, read the files, judge nothing yet. One short system transaction. */
async function begin(ctx: PluginContext, tx: PluginTx, p: JobPayload): Promise<Started> {
  const bot = (await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2', [p.teamId, p.botSlug])).rows[0];
  if (!bot) {
    // the bot's row may not be loaded yet (a commit that created it is still being read): the job runs again with backoff
    if (p.trigger === 'on_commit') throw new Error(`bots: no bot "${p.botSlug}" loaded yet`);
    return { kind: 'skip' };
  }
  let row: { id: string; status: string } | undefined;
  if (p.runId !== null) {
    row = (await tx.query<{ id: string; status: string }>('SELECT id, status FROM app.bot_eval_runs WHERE id = $1 AND bot_id = $2', [p.runId, bot.id])).rows[0];
    if (!row || row.status !== 'running') return { kind: 'skip' };
  } else if (p.trigger === 'on_commit') {
    row = (
      await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM app.bot_eval_runs WHERE bot_id = $1 AND trigger = 'on_commit' AND commit_sha = $2 ORDER BY id DESC LIMIT 1`,
        [bot.id, p.commitSha],
      )
    ).rows[0];
    if (row && row.status !== 'running') return { kind: 'skip' };
  } else {
    row = (
      await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM app.bot_eval_runs WHERE bot_id = $1 AND trigger = $2 AND status = 'running' AND started_at > now() - interval '6 hours' ORDER BY id DESC LIMIT 1`,
        [bot.id, p.trigger],
      )
    ).rows[0];
  }

  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the repo provider is not registered');
  const ref = p.commitSha ?? (await repo.tree(tx, p.teamId, '', 'main')).commitSha;
  const loaded = await loadBotEval(p.botSlug, (path) => readFileAt(repo, tx, p.teamId, path, ref));

  // A commit or the night finds nothing to run for a bot without a set, or at a commit where its BOT.md is not there yet (the set file landed first): that is not worth a row.
  if (!loaded.ok && (loaded.kind === 'no_evals' || loaded.kind === 'no_definition') && p.trigger !== 'on_demand') return { kind: 'skip' };

  const setName = loaded.ok ? loaded.loaded.set.set : (loaded.set ?? '-');
  const minScore = loaded.ok ? loaded.loaded.minScore : (loaded.minScore ?? 0);
  let runId = row?.id;
  if (runId === undefined) {
    runId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_eval_runs (workspace_id, team_id, bot_id, bot_slug, set_name, commit_sha, trigger, mode, min_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [p.workspaceId, p.teamId, bot.id, p.botSlug, setName, ref, p.trigger, p.mode, minScore],
      )
    ).rows[0]!.id;
  } else {
    await tx.query('UPDATE app.bot_eval_runs SET set_name = $2, commit_sha = $3, min_score = $4 WHERE id = $1', [runId, setName, ref, minScore]);
  }
  if (!loaded.ok) return { kind: 'fail', runId, botId: bot.id, message: loaded.message.slice(0, 900) };
  return { kind: 'run', runId, botId: bot.id, loaded: loaded.loaded };
}

interface Outcome {
  status: 'finished' | 'failed';
  results: EvalResult[];
  total: number;
  judged: number;
  passed: number;
  score: number | null;
  ok: boolean | null;
  costTokens: number;
  error: string | null;
}

/** Step 3: write the verdict, once, and say so. */
async function finish(ctx: PluginContext, tx: PluginTx, p: JobPayload, runId: string, botId: string, o: Outcome): Promise<void> {
  const done = await tx.query<{ set_name: string; commit_sha: string | null; min_score: number; mode: string }>(
    `UPDATE app.bot_eval_runs
        SET status = $2, results = $3::jsonb, total = $4, judged = $5, passed = $6, score = $7, ok = $8, cost_tokens = $9, error = $10, finished_at = now()
      WHERE id = $1 AND status = 'running'
      RETURNING set_name, commit_sha, min_score, mode`,
    [runId, o.status, JSON.stringify(o.results), o.total, o.judged, o.passed, o.score, o.ok, o.costTokens, o.error],
  );
  const row = done.rows[0];
  if (!row) return;
  await ctx.audit.emit(tx, {
    type: 'bots.eval.run.finished',
    schemaVersion: 1,
    workspaceId: p.workspaceId,
    teamId: p.teamId,
    botId,
    slug: p.botSlug,
    runId,
    set: row.set_name,
    trigger: p.trigger,
    mode: row.mode,
    status: o.status,
    commitSha: row.commit_sha,
    total: o.total,
    judged: o.judged,
    passed: o.passed,
    score: o.score,
    minScore: row.min_score,
    ok: o.ok,
    at: ctx.runtime.now().toISOString(),
  });
}

const failedOutcome = (error: string): Outcome => ({ status: 'failed', results: [], total: 0, judged: 0, passed: 0, score: null, ok: null, costTokens: 0, error });

export function registerEvals(ctx: PluginContext): void {
  ctx.jobs.register(
    EVAL_QUEUE,
    async (raw, _unusable, job) => {
      const p = readPayload(raw);
      if (!p) {
        job.log.warn('bots: an eval job with an unreadable payload was dropped');
        return;
      }
      let started: Started;
      try {
        started = await job.transaction((tx) => begin(ctx, tx, p));
      } catch (err) {
        // the last attempt: an on-demand run the route already recorded would sit as "running" until the hourly pass; end it now, in words
        if (job.attempt >= EVAL_MAX_ATTEMPTS && p.runId !== null) {
          const runId = p.runId;
          await job.transaction(async (tx) => {
            const bot = (await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2', [p.teamId, p.botSlug])).rows[0];
            if (bot) await finish(ctx, tx, p, runId, bot.id, failedOutcome(plain(err)));
          });
        }
        throw err;
      }
      if (started.kind === 'skip') return;
      if (started.kind === 'fail') {
        await job.transaction((tx) => finish(ctx, tx, p, started.runId, started.botId, failedOutcome(started.message)));
        return;
      }
      let outcome: Outcome;
      const promptChars = started.loaded.set.cases.length * (started.loaded.definition.body.length + EVAL_CASE_WORLD_CHARS);
      if (p.mode === 'model' && promptChars > EVAL_MODEL_MAX_PROMPT_CHARS) {
        await job.transaction((tx) =>
          finish(ctx, tx, p, started.runId, started.botId, failedOutcome('This run would send more text to the model than one run may (the bot\'s prompt is sent once per case). Shorten the prompt or split the set, or run the free check.')),
        );
        return;
      }
      try {
        const answerer: Answerer =
          p.mode === 'static'
            ? staticAnswerer
            : answererOverride !== null
              ? answererOverride({ botId: started.botId, runId: started.runId })
              : modelAnswerer({
                  ctx,
                  llm: ctx.providers.get<LlmEvalDoor>('llm') ?? unavailableDoor,
                  transaction: (fn) => job.transaction(fn),
                  workspaceId: p.workspaceId,
                  teamId: p.teamId,
                  botId: started.botId,
                  runId: started.runId,
                });
        const { results, summary } = await runEvalSet(answerer, started.loaded.definition, started.loaded.set.cases, started.loaded.minScore, () => Date.now());
        outcome = { status: 'finished', results, ...summary, error: null };
      } catch (err) {
        job.log.warn(`bots: eval run ${started.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome = failedOutcome(plain(err));
      }
      await job.transaction((tx) => finish(ctx, tx, p, started.runId, started.botId, outcome));
    },
    // one run of a bot at a time: a commit that touches BOT.md and its set file queues two jobs for the same commit, and the second must see the first's row
    { detached: true, maxAttempts: EVAL_MAX_ATTEMPTS, concurrency: 2, serialKey: 'serial' },
  );

  // proposals.proposal.applied: mark the work and stop. The bots plugin does not depend on proposals, so it knows the event by name only.
  ctx.events.subscribe('proposals.proposal.applied', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ProposalsProposalAppliedEvent.parse(raw);
    const slug = evalBotOfPath(event.path);
    if (slug === null) return;
    // a deleted definition leaves nothing to run
    if (event.op === 'delete' && event.path.endsWith('/BOT.md')) return;
    const payload: Record<string, unknown> = {
      workspaceId: event.workspaceId,
      teamId: event.teamId,
      botSlug: slug,
      serial: `${event.teamId}:${slug}`,
      trigger: 'on_commit',
      mode: 'static',
      runId: null,
      commitSha: event.commitSha,
    };
    await ctx.jobs.enqueue(tx, EVAL_QUEUE, payload, { dedupeKey: `${event.teamId}:${slug}:${event.commitSha}` });
  });

  // The nightly pass: one job per active bot (the job drops the ones without a set). Cron jobs have no payload and no workspace.
  ctx.jobs.register(
    EVAL_NIGHTLY_QUEUE,
    async (_payload, tx, job) => {
      const bots = await tx.query<{ id: string; workspace_id: string; team_id: string; slug: string }>(
        `SELECT id, workspace_id, team_id, slug FROM app.bots WHERE status = 'active' ORDER BY created_at, id`,
      );
      const day = ctx.runtime.now().toISOString().slice(0, 10);
      for (const b of bots.rows) {
        await ctx.jobs.enqueue(
          tx,
          EVAL_QUEUE,
          { workspaceId: b.workspace_id, teamId: b.team_id, botSlug: b.slug, serial: `${b.team_id}:${b.slug}`, trigger: 'nightly', mode: 'static', runId: null, commitSha: null },
          { dedupeKey: `nightly:${b.id}:${day}` },
        );
      }
      job.log.info(`bots: queued the nightly eval pass for ${bots.rows.length} bot(s)`);
    },
    { cron: '27 3 * * *', maxAttempts: 1, concurrency: 1 },
  );

  // A run whose worker died stays `running` for ever, and the route refuses a second run while one is open: end it.
  ctx.jobs.register(
    EVAL_REAP_QUEUE,
    async (_payload, tx, job) => {
      const ended = await tx.query<{ id: string }>(
        `UPDATE app.bot_eval_runs
            SET status = 'failed', finished_at = now(), error = 'The run did not finish in time and was ended. Run it again.'
          WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)
          RETURNING id`,
        [EVAL_STALE_MINUTES],
      );
      if (ended.rows.length > 0) job.log.info(`bots: ${ended.rows.length} stale eval run(s) ended as failed`);
    },
    { cron: '53 * * * *', maxAttempts: 1, concurrency: 1 },
  );
}

const unavailableDoor: LlmEvalDoor = {
  id: 'none',
  async evalComplete() {
    return { ok: false, reason: 'unavailable', detail: 'The model gateway is not available on this server, so the evals cannot run with the model.' };
  },
};

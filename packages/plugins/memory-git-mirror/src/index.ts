import { definePlugin, type MemoryProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { ensureBundle, writeJournal } from './bundle.ts';
import { CONSUMED_EVENTS, registerConsumers } from './consumers.ts';
import { DRAIN_QUEUE, ENSURE_QUEUE, JOURNAL_QUEUE, JOURNAL_TEAM_QUEUE } from './constants.ts';
import { drainMirror } from './drain.ts';

export { decide } from './decide.ts';
export type { Decision, Resolution } from './decide.ts';
export { drainMirror } from './drain.ts';
export type { DrainStats } from './drain.ts';
export { ensureBundle, renderJournal, writeJournal, INDEX_PATH, LOG_PATH, journalPath } from './bundle.ts';
export { conceptDigest, conceptSourceId, documentIdFor, renderConcept } from './render.ts';
export { resolveConcept } from './concept.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** The UTC day before `now`: what the daily consolidation covers. */
export const yesterday = (now: Date): string => dayOf(new Date(now.getTime() - 24 * 3_600_000));

/** True for a real calendar date strictly before `today` (a journal is never written for a day that is not over). */
export const isPastDay = (date: string, today: string): boolean =>
  DATE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date && date < today;

const engineOn = (ctx: PluginContext): boolean => {
  const provider = ctx.providers.get<MemoryProvider>('memory');
  return provider !== undefined && provider.enabled;
};

/** A team id and a workspace id from a job payload (it is whatever was enqueued, by anyone who could call `ctx.jobs.enqueue`). */
const payloadIds = (payload: Record<string, unknown>): { workspaceId: string; teamId: string } | null => {
  const { workspaceId, teamId } = payload;
  return typeof workspaceId === 'string' && UUID.test(workspaceId) && typeof teamId === 'string' && UUID.test(teamId) ? { workspaceId, teamId } : null;
};

/**
 * memory-git-mirror: the OKF bundle's mirror between `memory/` in the team repo and the team's Hindsight bank (SPEC §12.1, PLAN P5-14).
 *
 *  * a commit under `memory/` re-retains each changed concept into the team's bank (document key: path + keyed content digest; tags: type, tags,
 *    origin, trust tier), and a delete or `status: deprecated` forgets it — through the memory provider (`provider.memory`) in a system
 *    transaction, the bank derived from the team the DATABASE says the path belongs to;
 *  * the first time a team's memory is used, its bundle root (`memory/index.md` with `okf_version: "0.2"`, `memory/log.md`) is written through
 *    the one repo writer;
 *  * the daily consolidation writes `memory/journal/<date>.md` (type `Journal`, `generated.by: process:journal`): counts and source links.
 *
 * Inert without an engine (`MANYTHREADS_HINDSIGHT_URL` unset): one `not_configured` line per team per day, nothing queued but the removal of
 * what the bank already holds, no write to any repository. docs/plugins/memory-git-mirror.md.
 */
export default definePlugin({
  manifest: {
    name: 'memory-git-mirror',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.subscribe', 'job.register'],
    events: { emits: [], consumes: [...CONSUMED_EVENTS] },
    // retain log + digest key + the authored verdict (memory), the index and the writer (repo-git), the bots and their runs (bots).
    dependsOn: ['memory', 'repo-git', 'bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerConsumers(ctx);

    // The drain: queued behind every change (after the debounce) and once a minute as the safety net. It talks to the engine, so a failure inside
    // it backs the concept off in its own row and never reaches the outbox; one attempt, because the work list is the retry.
    ctx.jobs.register(
      DRAIN_QUEUE,
      async (_payload, tx, job) => {
        const stats = await drainMirror(ctx, tx, job.log);
        if (stats.considered > 0) {
          job.log.info(
            `memory-git-mirror: considered ${stats.considered}: retained ${stats.retained}, forgot ${stats.forgotten}, withheld ${stats.withheld}, deferred ${stats.deferred}, unchanged ${stats.unchanged}, failed ${stats.failed}, dropped ${stats.dropped}`,
          );
        }
      },
      { cron: '* * * * *', maxAttempts: 1, concurrency: 1 },
    );

    // First use of a team's memory: its bundle root, once. Payload `{ workspaceId, teamId }` (the job runs scoped to that workspace, so the commit
    // event carries it).
    ctx.jobs.register(ENSURE_QUEUE, async (payload, tx, job) => {
      const ids = payloadIds(payload);
      if (ids === null || !engineOn(ctx)) return;
      const outcome = await ensureBundle(ctx, tx, ids.teamId);
      if (outcome === 'created') job.log.info(`memory-git-mirror: wrote the memory bundle root of team ${ids.teamId}`);
    });

    // The daily consolidation (02:23 UTC, the day before): the teams whose memory did something that day get one journal job each.
    ctx.jobs.register(
      JOURNAL_QUEUE,
      async (payload, tx, job) => {
        if (!engineOn(ctx)) return;
        const today = dayOf(ctx.runtime.now());
        const date = typeof payload['date'] === 'string' && isPastDay(payload['date'], today) ? payload['date'] : yesterday(ctx.runtime.now());
        const from = `${date}T00:00:00.000Z`;
        const to = new Date(Date.parse(from) + 24 * 3_600_000).toISOString();
        const teams = await tx.query<{ team_id: string; workspace_id: string }>(
          `SELECT DISTINCT l.team_id, l.workspace_id
             FROM app.memory_retain_log l JOIN app.teams t ON t.id = l.team_id
            WHERE l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz
              AND l.store = 'team_bank' AND l.outcome IN ('retained', 'forgotten') AND t.archived_at IS NULL`,
          [from, to],
        );
        for (const t of teams.rows) {
          await ctx.jobs.enqueue(tx, JOURNAL_TEAM_QUEUE, { workspaceId: t.workspace_id, teamId: t.team_id, date }, { dedupeKey: `journal:${t.team_id}:${date}` });
        }
        if (teams.rows.length > 0) job.log.info(`memory-git-mirror: ${teams.rows.length} team(s) to write a journal for ${date}`);
      },
      { cron: '23 2 * * *', maxAttempts: 1, concurrency: 1 },
    );

    ctx.jobs.register(JOURNAL_TEAM_QUEUE, async (payload, tx: PluginTx, job) => {
      const ids = payloadIds(payload);
      const date = payload['date'];
      if (ids === null || typeof date !== 'string' || !isPastDay(date, dayOf(ctx.runtime.now())) || !engineOn(ctx)) return;
      // The bundle root first: the journal is the first file a team's memory may get.
      await ensureBundle(ctx, tx, ids.teamId);
      const outcome = await writeJournal(ctx, tx, { teamId: ids.teamId, date });
      if (outcome === 'written') job.log.info(`memory-git-mirror: wrote the journal of team ${ids.teamId} for ${date}`);
    });
  },
});

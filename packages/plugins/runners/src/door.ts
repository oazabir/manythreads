import { RunnerUnavailableError, type PluginContext, type RunnerDispatch, type RunnerDoor, type RunnerJob } from '@manythreads/sdk';
import { ConnectionRegistry, finishJob, jobFrame, newJobState, sendFrame, type RunnerConnection } from './connections.ts';

// The `runner` provider (PLAN P6-06): the one way a plugin sends a job to a runner. It fails fast, with a sentence, when the runner is not
// connected to this process; the sentence is the run's failure reason and is also written as `runners.job.refused`.

async function whyUnavailable(ctx: PluginContext, teamId: string, runner: string): Promise<string> {
  const row = await ctx.db
    .system(async (tx) =>
      (
        await tx.query<{ workspace_id: string; runner_id: string | null; last_seen_at: Date | null }>(
          `SELECT t.workspace_id, r.id AS runner_id, r.last_seen_at
             FROM app.teams t LEFT JOIN app.runners r ON r.team_id = t.id AND r.name = $2
            WHERE t.id = $1::uuid`,
          [teamId, runner],
        )
      ).rows[0],
    )
    .catch(() => undefined);
  if (row && row.runner_id === null) return `this team has no runner called "${runner}" (register it, mint its token and start the runner program)`;
  const seen = row?.last_seen_at ? `last seen ${row.last_seen_at.toISOString()}` : 'never seen';
  return `the runner "${runner}" is not connected to this server (${seen}); start the runner program, or, when the server runs several replicas, it is connected to another one`;
}

async function refuse(ctx: PluginContext, teamId: string, runner: string, runId: string, reason: string): Promise<never> {
  await ctx.db
    .system(async (tx) => {
      const team = (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.teams WHERE id = $1::uuid', [teamId])).rows[0];
      if (!team) return;
      await ctx.audit.emit(tx, {
        type: 'runners.job.refused',
        workspaceId: team.workspace_id,
        teamId,
        runId,
        runner,
        reason: reason.slice(0, 500),
        at: ctx.runtime.now().toISOString(),
      });
    })
    .catch(() => undefined);
  throw new RunnerUnavailableError(reason);
}

/** After a stop, how long past the kill grace the server waits for the runner's `exit` before it gives up on the job. */
export const BACKSTOP_EXTRA_MS = 5_000;

export function createRunnerDoor(
  ctx: PluginContext,
  registry: ConnectionRegistry,
  options: { backstopExtraMs?: number; maxQueuedChars?: number } = {},
): RunnerDoor {
  const extraMs = options.backstopExtraMs ?? BACKSTOP_EXTRA_MS;
  return {
    id: 'runners',
    async dispatch({ teamId, runner, job }: { teamId: string; runner: string; job: RunnerJob }): Promise<RunnerDispatch> {
      const conn: RunnerConnection | undefined = registry.get(teamId, runner);
      if (!conn) return refuse(ctx, teamId, runner, job.runId, await whyUnavailable(ctx, teamId, runner));
      if (conn.jobs.size >= conn.hello.maxJobs) {
        return refuse(ctx, teamId, runner, job.runId, `the runner "${runner}" is full: it is running ${conn.jobs.size} job(s), its limit`);
      }
      if (conn.jobs.has(job.runId)) return refuse(ctx, teamId, runner, job.runId, `run ${job.runId} is already on the runner "${runner}"`);
      const state = newJobState(job.runId, options.maxQueuedChars);
      conn.jobs.set(job.runId, state);
      try {
        sendFrame(conn.socket, jobFrame({
          jobId: job.runId,
          runId: job.runId,
          profile: job.profile,
          prompt: job.prompt,
          runBudgetSeconds: job.runBudgetSeconds,
          maxTurns: job.maxTurns,
          killGraceSeconds: job.killGraceSeconds,
        }));
      } catch (err) {
        conn.jobs.delete(job.runId);
        return refuse(ctx, teamId, runner, job.runId, `the job could not be sent to the runner "${runner}": ${err instanceof Error ? err.message : String(err)}`);
      }
      let stopSent = false;
      /** The runner never answered the stop (it heartbeats but the job does not end, or the connection is gone): end the job here. */
      const giveUp = (why: string): void => {
        conn.jobs.delete(job.runId);
        finishJob(state, { code: null, signal: null, stderrTail: why });
      };
      return {
        lines: state.lines,
        exited: state.exited,
        stop: async () => {
          if (stopSent || state.done) return;
          stopSent = true;
          if (conn.closed) return giveUp(`the runner "${runner}" is not connected, so the job could not be stopped there`);
          try {
            sendFrame(conn.socket, { type: 'stop', jobId: job.runId });
          } catch {
            return giveUp(`the stop could not be sent to the runner "${runner}"`);
          }
          state.backstop = setTimeout(
            () => giveUp(`the runner "${runner}" did not report the job's exit after the stop; the server gave up on it`),
            job.killGraceSeconds * 1000 + extraMs,
          );
          state.backstop.unref?.();
        },
      };
    },
  };
}

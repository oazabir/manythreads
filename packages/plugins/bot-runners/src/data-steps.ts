import type { PluginContext, PluginTx } from '@manythreads/sdk';

// One-off data steps of bot-runners (a change to existing rows that must be audited, so it is TypeScript through `ctx.audit.emit`, not SQL in a migration). Each step runs once in
// one transaction as the system actor and then writes its name into `app.bot_runner_data_steps` (bot-runners 0010), which is the marker: a step whose name is there never runs
// again. The job runs on a short cron so a deploy is followed within minutes; once every step is marked, a run is one primary-key read. A crash before the commit leaves no
// marker and no change, so the next slot tries again (the kernel's jobs may run twice; the steps are written so a second run changes nothing).

/** The queue (the kernel wants `<plugin>.<name>`). */
export const DATA_STEPS_QUEUE = 'bot-runners.data-steps';

interface DataStep {
  /** The marker's name: lowercase words and dashes, never reused. */
  name: string;
  /** Does the change; answers how many rows it changed (for the log). */
  run(ctx: PluginContext, tx: PluginTx): Promise<number>;
}

/**
 * P35-01 (owner, 2026-11-20): full access is on by default for Claude Code and Codex. The runners that existed before it are switched on once, each with a
 * `bot_runner.runner.updated` event (`changed: ['full_access']`, the system actor) so the audit page says who changed it. Exactly the kinds the database allows
 * (`bot_runners_full_access_agent`): Claude Code and Codex pod runners, and server runners whose agent is Claude Code or Codex. A runner an admin switches off after this
 * stays off: the step never runs again.
 */
export const FULL_ACCESS_DEFAULT_STEP: DataStep = {
  name: 'full-access-default-2026-11-20',
  async run(ctx, tx) {
    const rows = (
      await tx.query<{ id: string; workspace_id: string; name: string }>(
        `UPDATE app.bot_runners SET full_access = true, updated_at = now()
          WHERE NOT full_access AND (kind IN ('claude_cli', 'codex_cli') OR (kind = 'server_agent' AND agent IN ('claude-code', 'codex')))
          RETURNING id, workspace_id, name`,
      )
    ).rows;
    if (rows.length === 0) return 0;
    const at = ctx.runtime.now().toISOString();
    await ctx.audit.emitMany(
      tx,
      rows.map((r) => ({ type: 'bot_runner.runner.updated', workspaceId: r.workspace_id, runnerId: r.id, name: r.name, changed: ['full_access'], actorId: tx.actor.id, at })),
    );
    return rows.length;
  },
};

export const DATA_STEPS: readonly DataStep[] = [FULL_ACCESS_DEFAULT_STEP];

/** Runs every step that has no marker yet, in order, on the caller's (system) transaction. Answers the names of the steps it ran. */
export async function runDataSteps(ctx: PluginContext, tx: PluginTx, log?: { info(message: string): void }, steps: readonly DataStep[] = DATA_STEPS): Promise<string[]> {
  const done = new Set((await tx.query<{ step: string }>('SELECT step FROM app.bot_runner_data_steps')).rows.map((r) => r.step));
  const ran: string[] = [];
  for (const step of steps) {
    if (done.has(step.name)) continue;
    // the marker first, under its primary key: a second worker running the same step at once waits here and then fails on the key, so the change is made once
    await tx.query('INSERT INTO app.bot_runner_data_steps (step) VALUES ($1)', [step.name]);
    const changed = await step.run(ctx, tx);
    log?.info(`bot-runners: data step ${step.name} changed ${changed} row(s)`);
    ran.push(step.name);
  }
  return ran;
}

export function registerDataSteps(ctx: PluginContext): void {
  ctx.jobs.register(
    DATA_STEPS_QUEUE,
    async (_payload, tx, job) => {
      await runDataSteps(ctx, tx, job.log);
    },
    { cron: '*/5 * * * *', maxAttempts: 3, concurrency: 1 },
  );
}

import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { RuntimeScheduledJobFinishedEvent, ScheduledJobsScheduledJobRanEvent } from '@manythreads/shared';
import { RUN_QUEUE, type RunPayload } from './run-job.ts';

// The `routine` trigger for a person's own routine (PLAN P20-10). The scheduled-jobs plugin files a firing of a routine that belongs to one person and says so with
// `scheduled_jobs.scheduled_job.ran` (status `queued`, no team); this turns it into exactly one bot run, the way router-scheduled-jobs.ts does for a team's schedule, with
// these differences:
//
//  * The asker is the routine's owner (the platform fills it in; the routine row cannot name anyone else), so the run reads what that person may read: the run's space
//    context (`app.run_space_context()`) sees a private conversation of the owner with the bot and decides the audience, the bot's `personal.read` and the owner's consent.
//  * The run answers in the owner's own conversation with the bot (`bot_conversation` channel), which makes it a private one. A routine whose owner has no such conversation
//    is settled `failed` with a plain sentence rather than guessed at.
//  * The bot does not need a `routine` trigger in its BOT.md: the person asked for this routine, no team lead did. The scheduler already checked the bot is on, the owner may
//    ask it, and the owner agreed to it reading their space; a bot that went inactive since is settled `failed`.
//  * The output is written to the owner's Personal files by the finishing step (scheduled-job-run.ts), never announced in a channel.

interface BotRow {
  id: string;
  team_id: string;
  name: string;
  status: string;
  [key: string]: unknown;
}

const OUTPUT_WORDS = { create: 'be saved as a new file (it must not exist yet)', replace: 'replace whatever is there', append: 'be added to the end of the file' } as const;

/** The prompt a firing of a personal routine starts its bot with. Pure. */
export function buildPersonalRoutinePrompt(input: { name: string; firedAt: string; prompt: string; outputPath: string; outputMode: 'create' | 'replace' | 'append' }): string {
  return [
    input.prompt.trim() !== '' ? input.prompt.trim() : `Run the routine "${input.name}".`,
    '',
    `This is your routine "${input.name}" (${input.firedAt}), set up by the person you work for. Your final reply is the output: it is saved as the file ${input.outputPath} in their own files and will ${OUTPUT_WORDS[input.outputMode]}.`,
    'Reply with the content of the file only, with no greeting and no comment about it. Do not send, post or change anything else; a change you ask for waits for the person to say yes.',
  ].join('\n');
}

/** True the first time a firing is seen, false for every later delivery. */
async function firstDelivery(tx: PluginTx, scheduledJobRunId: string): Promise<boolean> {
  const row = await tx.query(
    `INSERT INTO app.outbox_processed (subscriber, event_id) VALUES ('runtime-hermes:personalRoutine', md5($1)::uuid) ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
    [scheduledJobRunId],
  );
  return row.rows.length > 0;
}

export function registerPersonalRoutineRouter(ctx: PluginContext): void {
  ctx.events.subscribe('scheduled_jobs.scheduled_job.ran', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ScheduledJobsScheduledJobRanEvent.parse(raw);
    if (event.status !== 'queued' || event.teamId !== null || event.ownerPersonId === undefined || event.ownerPersonId === null) return;
    const ownerPersonId: string = event.ownerPersonId;
    if (!(await firstDelivery(tx, event.scheduledJobRunId))) return;

    const bot = (
      await tx.query<BotRow>(
        `SELECT b.id, b.team_id, b.name, b.status FROM app.bots b WHERE b.id = $1::uuid AND b.workspace_id = $2::uuid`,
        [event.botId, event.workspaceId],
      )
    ).rows[0];
    // a bot that is gone has no team to report with: the firing is failed by the scheduler's own sweep of stuck firings
    if (!bot) return;
    const fail = (reason: string): Promise<unknown> =>
      ctx.audit.emit(
        tx,
        RuntimeScheduledJobFinishedEvent.parse({
          type: 'runtime.scheduled_job.finished',
          schemaVersion: 1,
          workspaceId: event.workspaceId,
          teamId: bot.team_id,
          botId: event.botId,
          scheduledJobRunId: event.scheduledJobRunId,
          runId: null,
          status: 'failed',
          reason,
          outputPath: null,
          commitSha: null,
        }),
      );
    if (bot.status !== 'active') return void (await fail(`The bot ${bot.name} is not active, so it cannot run.`));

    const asker = (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'person' AND ref_id = $1::uuid AND workspace_id = $2::uuid`, [ownerPersonId, event.workspaceId])).rows[0];
    if (!asker) return void (await fail('The owner of this routine is no longer in the workspace.'));
    // the owner's own conversation with the bot: what makes the run a private one (the bot reads as the owner, in the owner's Personal space)
    const channel = (
      await tx.query<{ id: string }>(`SELECT id FROM app.channels WHERE kind = 'bot_conversation' AND bot_id = $1::uuid AND created_by = $2::uuid ORDER BY created_at LIMIT 1`, [bot.id, asker.id])
    ).rows[0];
    if (!channel) return void (await fail(`There is no conversation of yours with ${bot.name}. Open a chat with it once, then run the routine again.`));

    const outputPath = event.outputPath ?? '';
    const outputMode = event.outputMode ?? 'replace';
    const prompt = buildPersonalRoutinePrompt({ name: event.scheduledJobName || 'routine', firedAt: ctx.runtime.now().toISOString(), prompt: event.prompt, outputPath, outputMode });
    const payload: RunPayload = {
      workspaceId: event.workspaceId,
      botId: bot.id,
      teamId: bot.team_id,
      channelId: channel.id,
      trigger: 'routine',
      askerActorId: asker.id,
      replyRootId: null,
      runThreadId: null,
      prompt,
      text: prompt.slice(0, 40_000),
      scheduledJob: {
        scheduledJobRunId: event.scheduledJobRunId,
        kind: 'routine',
        outputPath,
        outputMode,
        modelAlias: event.modelAlias,
        effort: event.effort,
        personal: { ownerPersonId },
      },
    };
    await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:${bot.id}:scheduledJob:${event.scheduledJobRunId}` });
  });
}

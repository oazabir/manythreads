import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { RhythmsRhythmRanEvent, RuntimeRhythmFinishedEvent, type BotTrigger } from '@manythreads/shared';
import { RUN_QUEUE, type RunPayload } from './run-job.ts';

// The `routine` trigger (PLAN P6-08; SPEC §6.5, §7.1). The rhythms plugin files a firing and says so with `rhythms.rhythm.ran` (status
// `queued`); this turns that into exactly one bot run, the way `router-tasks.ts` turns a handover into one.
//
//  * The bot must be active and list a `routine` trigger in its BOT.md (a trigger that names a routine only matches that routine). A bot that
//    cannot be woken is not retried or skipped quietly: the firing is settled `failed` with a plain reason (`runtime.rhythm.finished`).
//  * Where the run answers: a rhythm has no thread to answer in, so the run posts at the top of the first public channel of the team that the
//    bot may post in (the same place the task cards go when nothing better exists). A routine's "wrote <page> · diff" line lands there.
//  * Exactly one run per firing: the job's dedupe key is the firing's id, and a durable latch row (like the task router's) keeps a second
//    delivery of the event, after the first run has finished, from starting another.
//  * The run's own prompt: a routine's contract prompt plus where the output goes; a heartbeat a short check-in; a task rhythm the card it made.
//    The rhythm's `model` / `effort` overrides travel in the payload and `run-job.ts` applies them.

interface BotRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  triggers: BotTrigger[] | null;
  actor_id: string;
  [key: string]: unknown;
}

const OUTPUT_WORDS = { create: 'create it (it must not exist yet)', replace: 'replace whatever is there', append: 'be added to the end of the page' } as const;

/** The prompt a firing starts its bot with. Pure. */
export function buildRhythmPrompt(input: {
  kind: 'heartbeat' | 'routine' | 'task';
  name: string;
  firedAt: string;
  prompt: string;
  outputPath: string | null;
  outputMode: 'create' | 'replace' | 'append' | null;
  card: { id: string; title: string; description: string } | null;
}): string {
  if (input.kind === 'routine') {
    const mode = OUTPUT_WORDS[input.outputMode ?? 'replace'];
    return [
      input.prompt.trim() !== '' ? input.prompt.trim() : `Run the routine "${input.name}".`,
      '',
      `This is the scheduled routine "${input.name}" (${input.firedAt}). Your final reply is the output: it is saved as the page ${input.outputPath ?? ''} and will ${mode}.`,
      'Reply with the content of the page only, with no greeting and no comment about it.',
    ].join('\n');
  }
  if (input.kind === 'task') {
    return [
      `Scheduled task from the "${input.name}" rhythm (${input.firedAt}).`,
      input.card ? `The card is "${input.card.title}" (id ${input.card.id}).\n${input.card.description}` : '',
      'Do the work, then reply with the result.',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }
  return [
    `Scheduled check-in: the "${input.name}" rhythm fired at ${input.firedAt}.`,
    'Look at what your team needs from you now and act on it with your tools if something needs it. If nothing does, reply "Nothing to report". Your reply is not posted; post in a channel yourself when something deserves it.',
  ].join('\n');
}

/** The first public channel of the team the bot may post in, or null. */
async function homeChannel(tx: PluginTx, teamId: string, botActorId: string): Promise<string | null> {
  return (
    (
      await tx.query<{ id: string }>(
        `SELECT c.id FROM app.channels c
          WHERE c.team_id = $1::uuid AND c.kind = 'channel' AND NOT c.private AND c.archived_at IS NULL
            AND app.channel_actor_can_post($2::uuid, c.id)
          ORDER BY c.position, c.created_at, c.id LIMIT 1`,
        [teamId, botActorId],
      )
    ).rows[0]?.id ?? null
  );
}

/** True the first time a firing is seen, false for every later delivery (kernel `outbox_processed`, written with the job). */
async function firstDelivery(tx: PluginTx, rhythmRunId: string): Promise<boolean> {
  const row = await tx.query(
    `INSERT INTO app.outbox_processed (subscriber, event_id) VALUES ('runtime-hermes:rhythm', md5($1)::uuid) ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
    [rhythmRunId],
  );
  return row.rows.length > 0;
}

export function registerRhythmRouter(ctx: PluginContext): void {
  ctx.events.subscribe('rhythms.rhythm.ran', async (raw: PluginEvent, tx: PluginTx) => {
    const event = RhythmsRhythmRanEvent.parse(raw);
    if (event.status !== 'queued') return;
    if (!(await firstDelivery(tx, event.rhythmRunId))) return;

    const fail = (reason: string): Promise<unknown> =>
      ctx.audit.emit(
        tx,
        RuntimeRhythmFinishedEvent.parse({
          type: 'runtime.rhythm.finished',
          schemaVersion: 1,
          workspaceId: event.workspaceId,
          teamId: event.teamId,
          botId: event.botId,
          rhythmRunId: event.rhythmRunId,
          runId: null,
          status: 'failed',
          reason,
          outputPath: null,
          commitSha: null,
        }),
      );

    const bot = (
      await tx.query<BotRow>(
        `SELECT b.id, b.slug, b.name, b.status, b.triggers, a.id AS actor_id
           FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id
          WHERE b.id = $1::uuid AND b.team_id = $2::uuid`,
        [event.botId, event.teamId],
      )
    ).rows[0];
    if (!bot) return void (await fail('The rhythm’s bot no longer exists on this team.'));
    if (bot.status !== 'active') return void (await fail(`The bot ${bot.name} is not active, so it cannot run.`));

    let routineSlug: string | null = null;
    if (event.kind === 'routine') {
      const path = (await tx.query<{ contract_path: string | null }>('SELECT contract_path FROM app.rhythms WHERE id = $1::uuid', [event.rhythmId])).rows[0]?.contract_path;
      routineSlug = path ? (path.split('/').pop() ?? '').replace(/\.ya?ml$/, '') : null;
    }
    const listed = (bot.triggers ?? []).some((t) => t.type === 'routine' && (t.routine === undefined || routineSlug === null || t.routine === routineSlug));
    if (!listed) {
      return void (await fail(`The bot ${bot.name} has no routine trigger in its BOT.md${routineSlug ? ` for "${routineSlug}"` : ''}, so a schedule cannot start it.`));
    }

    const channelId = await homeChannel(tx, event.teamId, bot.actor_id);
    if (!channelId) return void (await fail(`The bot ${bot.name} cannot post in any public channel of the team, so there is nowhere to put its output.`));

    const card =
      event.taskId === null
        ? null
        : (await tx.query<{ id: string; title: string; description: string }>('SELECT id, title, description FROM app.tasks WHERE id = $1::uuid AND team_id = $2::uuid', [event.taskId, event.teamId])).rows[0] ?? null;
    const prompt = buildRhythmPrompt({
      kind: event.kind,
      name: event.rhythmName || 'scheduled',
      firedAt: ctx.runtime.now().toISOString(),
      prompt: event.prompt,
      outputPath: event.outputPath,
      outputMode: event.outputMode,
      card,
    });
    const payload: RunPayload = {
      workspaceId: event.workspaceId,
      botId: bot.id,
      teamId: event.teamId,
      channelId,
      trigger: 'routine',
      askerActorId: null,
      replyRootId: null,
      runThreadId: null,
      prompt,
      text: prompt.slice(0, 40_000),
      rhythm: {
        rhythmRunId: event.rhythmRunId,
        kind: event.kind,
        outputPath: event.kind === 'routine' ? event.outputPath : null,
        outputMode: event.kind === 'routine' ? (event.outputMode ?? 'replace') : null,
        modelAlias: event.modelAlias,
        effort: event.effort,
      },
    };
    await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:${bot.id}:rhythm:${event.rhythmRunId}` });
  });
}

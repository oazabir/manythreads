import type { MessageProvider, PersonalFilesProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import {
  PERSONAL_ROUTINE_LIMITS,
  PERSONAL_ROUTINE_STOP_WORDS,
  ROUTINE_SOURCE_LABELS,
  ScheduledJobsScheduledJobRanEvent,
  ScheduledJobsScheduledJobStoppedEvent,
  inQuietHours,
  quietHoursEnd,
  type PersonalRoutineStopReason,
  type RoutineSource,
} from '@manythreads/shared';
import { parseContractText } from './personal-contract.ts';
import { getSettings, monthlyCapUsd, runBlocker, spentAsSystem } from './personal-limits.ts';
import type { PersonalJobRow, PersonalRunRow } from './personal-rows.ts';
import { nextRunFor } from './scheduler.ts';

// The firing of a person's own routines (PLAN P20-10, P20-14). The same steps serve the once-a-minute tick (which holds a routine back for quiet hours, the daily
// count, the minimum gap and a firing still going, and switches it off for a reason that will not mend itself) and the person's "Run now" (which skips only the
// quiet hours and the gap, because the person asked). A firing is a row in the ledger and the event `scheduled_jobs.scheduled_job.ran`; the runtime opens the run.

/** A row as the scheduler reads it: the job itself (no bot names needed). */
export type PersonalDueRow = Omit<PersonalJobRow, 'bot_slug' | 'bot_name' | 'lr_id' | 'lr_status' | 'lr_started_at' | 'lr_ended_at' | 'lr_reason'>;

const lookForText = (sources: readonly string[]): string =>
  sources.length === 0 ? '' : `\n\nLook only at: ${sources.map((s) => ROUTINE_SOURCE_LABELS[s as RoutineSource] ?? s).join(', ')}. Say where each thing you mention came from.`;

/** The prompt a firing starts the bot with (the person's own prompt, then the places it may look). */
export function buildFiringPrompt(contractPrompt: string, sources: readonly string[]): string {
  return `${contractPrompt.trim()}${lookForText(sources)}`.slice(0, 20_000);
}

/**
 * File one firing of a personal routine: read the contract from the owner's files (a missing or broken one is a failed firing with the reason, and no run), file the
 * ledger row, and announce it. Returns the ledger row.
 */
export async function startPersonalRun(ctx: PluginContext, tx: PluginTx, job: PersonalDueRow, now: Date): Promise<PersonalRunRow> {
  const files = ctx.providers.get<PersonalFilesProvider>('personal.files');
  let prompt = '';
  let failure: string | null = null;
  // callers check `runBlocker` first, which answers `bot_gone` for a routine without a bot
  if (job.bot_id === null) throw new Error('the bot that runs this routine is gone');
  if (!files) failure = 'Personal files are not available, so the routine file cannot be read.';
  else {
    try {
      const file = await files.read(tx, job.owner_person_id, job.contract_path);
      if (!file) failure = `Your routine file ${job.contract_path} is missing. Open the routine and save it again to make it.`;
      else prompt = buildFiringPrompt(parseContractText(file.text, job.contract_path).prompt, job.sources);
    } catch (err) {
      failure = (err instanceof Error ? err.message : 'The routine file could not be read.').slice(0, 500);
    }
  }
  const row = (
    await tx.query<PersonalRunRow>('SELECT * FROM app.scheduled_jobs_fire($1::uuid, $2, $3, $4)', [job.id, now, failure === null ? job.output_path : null, failure])
  ).rows[0];
  if (!row) throw new Error('the routine run was not recorded');
  await ctx.audit.emit(
    tx,
    ScheduledJobsScheduledJobRanEvent.parse({
      type: 'scheduled_jobs.scheduled_job.ran',
      schemaVersion: 1,
      workspaceId: job.workspace_id,
      teamId: null,
      ownerPersonId: job.owner_person_id,
      scheduledJobId: job.id,
      scheduledJobRunId: row.id,
      botId: job.bot_id,
      kind: 'routine',
      status: failure === null ? 'queued' : 'failed',
      outputPath: job.output_path,
      taskId: null,
      reason: failure ?? '',
      scheduledJobName: job.name,
      prompt: failure === null ? prompt : '',
      outputMode: failure === null ? (job.output_mode as 'create' | 'replace' | 'append') : null,
      modelAlias: null,
      effort: null,
    }),
  );
  return row;
}

/** True while a firing of this routine is still queued or running. */
export async function firingInFlight(tx: PluginTx, jobId: string): Promise<boolean> {
  return (await tx.query(`SELECT 1 FROM app.scheduled_job_runs WHERE scheduled_job_id = $1::uuid AND status IN ('queued', 'running') LIMIT 1`, [jobId])).rows.length > 0;
}

/** The platform switches a routine off for a reason that will not mend itself. The owner is told by `tellStops`. */
export async function stopRoutine(tx: PluginTx, jobId: string, reason: PersonalRoutineStopReason): Promise<void> {
  await tx.query(
    `UPDATE app.scheduled_jobs SET enabled = false, next_run_at = NULL, stopped_reason = $2, stopped_at = now(), stop_told_at = NULL, updated_at = now()
      WHERE id = $1::uuid AND stopped_reason IS NULL`,
    [jobId, reason],
  );
}

/** True when the routine already had its day's count of firings (`runsPerDay`) in the last 24 hours. "Run now" is held to this too. */
export async function pastDaysCount(tx: PluginTx, jobId: string, now: Date): Promise<boolean> {
  const n = Number(
    (await tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.scheduled_job_runs WHERE scheduled_job_id = $1::uuid AND started_at > $2::timestamptz - interval '24 hours'`, [jobId, now])).rows[0]?.n ?? 0,
  );
  return n >= PERSONAL_ROUTINE_LIMITS.runsPerDay;
}

/** Why a routine may not start another firing right now (it is skipped, not stopped), or null. */
async function holdReason(tx: PluginTx, job: PersonalDueRow, now: Date): Promise<'running' | 'gap' | 'per_day' | null> {
  if (await firingInFlight(tx, job.id)) return 'running';
  const recent = (
    await tx.query<{ last: Date | null; today: string }>(
      `SELECT max(started_at) AS last, count(*) FILTER (WHERE started_at > $2::timestamptz - interval '24 hours') AS today FROM app.scheduled_job_runs WHERE scheduled_job_id = $1::uuid`,
      [job.id, now],
    )
  ).rows[0];
  if (recent?.last && now.getTime() - recent.last.getTime() < PERSONAL_ROUTINE_LIMITS.minIntervalMinutes * 60_000) return 'gap';
  if (Number(recent?.today ?? 0) >= PERSONAL_ROUTINE_LIMITS.runsPerDay) return 'per_day';
  return null;
}

/**
 * One tick over the personal routines that are due. Each is checked in this order: can it run at all (bot, consent, membership, connections, the owner's status:
 * otherwise it is stopped), is it quiet time for its owner (held until the quiet hours end), has the month's allowance gone (stopped), is it already running or too
 * soon after the last firing or past its day's count (skipped, the schedule moves on). `FOR UPDATE SKIP LOCKED` keeps two replicas apart.
 */
export async function tickPersonalRoutines(ctx: PluginContext, tx: PluginTx, now: Date): Promise<number> {
  const due = (
    await tx.query<PersonalDueRow>(
      `SELECT * FROM app.scheduled_jobs WHERE enabled AND owner_person_id IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [now],
    )
  ).rows;
  let fired = 0;
  for (const job of due) {
    const setNext = (at: Date | null): Promise<unknown> => tx.query('UPDATE app.scheduled_jobs SET next_run_at = $2, updated_at = now() WHERE id = $1::uuid', [job.id, at]);
    const blocker = await runBlocker(tx, { personId: job.owner_person_id, botId: job.bot_id, sources: job.sources as RoutineSource[] });
    if (blocker !== null) {
      await stopRoutine(tx, job.id, blocker);
      continue;
    }
    const settings = await getSettings(tx, job.owner_person_id);
    const zone = settings.timeZone ?? job.time_zone;
    if (settings.quietHours && inQuietHours(now, zone, settings.quietHours)) {
      await setNext(quietHoursEnd(now, zone, settings.quietHours));
      continue;
    }
    const cap = await monthlyCapUsd(tx, job.workspace_id);
    if ((await spentAsSystem(tx, job.owner_person_id, now)) >= cap) {
      await stopRoutine(tx, job.id, 'spend_cap');
      continue;
    }
    if ((await holdReason(tx, job, now)) !== null) {
      await setNext(nextRunFor(job.schedule, now));
      continue;
    }
    await startPersonalRun(ctx, tx, job, now);
    fired += 1;
    await setNext(nextRunFor(job.schedule, now));
  }
  return fired;
}

/** The plain message a person is sent when the platform switches a routine off. */
export const stopMessage = (name: string, reason: PersonalRoutineStopReason): string =>
  `Your routine “${name}” was switched off because ${PERSONAL_ROUTINE_STOP_WORDS[reason]}. Open Files, then Routines, to look at it and turn it on again.`;

/** The job that tells owners about stopped routines. */
export const TELL_STOPS_QUEUE = 'scheduled-jobs.tell-stops';

/**
 * Tell each owner, once, that a routine of theirs was switched off: one message in their own Reminders conversation (where every notice for them lives) and the event
 * `scheduled_jobs.scheduled_job.stopped`, which the notifications plugin turns into a bell notification. `stop_told_at` is claimed in the same transaction.
 */
export async function tellStops(ctx: PluginContext, tx: PluginTx): Promise<number> {
  const rows = (
    await tx.query<{ id: string; workspace_id: string }>(
      `SELECT id, workspace_id FROM app.scheduled_jobs WHERE owner_person_id IS NOT NULL AND stopped_reason IS NOT NULL AND stop_told_at IS NULL ORDER BY stopped_at LIMIT 50`,
    )
  ).rows;
  const messages = ctx.providers.get<MessageProvider>('messages');
  let told = 0;
  for (const row of rows) {
    // one transaction for each: it acts for the routine's workspace, claims the notice (`stop_told_at`) and writes the message and the event together
    const done = await ctx.db.system(
      async (sys) => {
        const claimed = (
          await sys.query<{ id: string; workspace_id: string; owner_person_id: string; bot_id: string | null; name: string; stopped_reason: PersonalRoutineStopReason }>(
            `UPDATE app.scheduled_jobs SET stop_told_at = now()
              WHERE id = $1::uuid AND owner_person_id IS NOT NULL AND stopped_reason IS NOT NULL AND stop_told_at IS NULL
              RETURNING id, workspace_id, owner_person_id, bot_id, name, stopped_reason`,
            [row.id],
          )
        ).rows[0];
        if (!claimed) return false;
        // a person who has left cannot be told; the stop stands and is marked as told so it is not tried for ever
        const person = (await sys.query<{ status: string }>('SELECT status FROM app.people WHERE id = $1::uuid', [claimed.owner_person_id])).rows[0];
        if (!messages || person?.status !== 'active') return true;
        // from here the transaction acts as the Reminders sender: the message and the event are written under that actor, or the outbox would skip the event
        const senderId = (await sys.query<{ id: string }>('SELECT app.reminders_act_as() AS id')).rows[0]?.id;
        if (!senderId) return true;
        const asSender: PluginTx = { actor: { kind: 'system', id: senderId, workspaceId: claimed.workspace_id }, query: (text, values) => sys.query(text, values) };
        const channelId = (await sys.query<{ id: string }>('SELECT app.reminders_inbox($1::uuid) AS id', [claimed.owner_person_id])).rows[0]?.id ?? null;
        if (!channelId) return true;
        const posted = await messages.post(asSender, { channelId, body: stopMessage(claimed.name, claimed.stopped_reason), skipRefs: true });
        await ctx.audit.emit(
          asSender,
          ScheduledJobsScheduledJobStoppedEvent.parse({
            type: 'scheduled_jobs.scheduled_job.stopped',
            schemaVersion: 1,
            workspaceId: claimed.workspace_id,
            scheduledJobId: claimed.id,
            ownerPersonId: claimed.owner_person_id,
            botId: claimed.bot_id,
            reason: claimed.stopped_reason,
            messageId: posted.id,
            channelId,
          }),
        );
        return true;
      },
      { workspaceId: row.workspace_id },
    );
    if (done) told += 1;
  }
  return told;
}

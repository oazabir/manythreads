import { NEVER_APPROVAL_GATED, neverApprovalGatedReason, type CapabilityAuthorizeContext, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { APPROVAL_RUN_TIMEOUT_MINUTES, ApprovalResume, ApprovalsApprovalResumedEvent } from '@manythreads/shared';
import { z } from 'zod';
import { pushChanged } from './notify.ts';

// What approving a tool call does (PLAN P5-20, SPEC §7.3). The run that asked has already ended (`stopped`): a model cannot wait for a
// person, and the process is gone. So approving does the one thing the person approved — it re-runs *that call*, once, as the bot, with the
// arguments that were stored — and records what became of it on the approval, where the card in the thread shows it. It does not restart the
// conversation; the person can ask the bot again, and the call it would make is now done.
//
// "Once" is the point, because the call may be an email or a deploy. It is kept by three things together, not by a transaction:
//   1. two jobs. `approvals.resume` only *claims* the approval (`queued` → `running`, in its own committed transaction) and queues
//      `approvals.execute`; the claim is therefore durable before anything happens, and a crash after it leaves a visible `running` row;
//   2. both queues are `maxAttempts: 1` — a failed job is dead, never retried — and `approvals.execute` refuses to start when it is not the
//      first attempt (the reaper puts a job whose worker died back on its queue, whatever the queue's own limit says);
//   3. a sweep (`approvals.sweep`) turns an approved call still `queued` or `running` after a quarter of an hour into `failed`, with a sentence
//      that says it may or may not have happened — never into a re-run.
// The call itself runs in its own transaction (`asApproved`), which commits before the job's bookkeeping does: if the bookkeeping fails the
// call is not repeated, and the row says `running` until the sweep calls it.
//
// The re-run is exactly as constrained as the original: a new run is opened for the bot (same trigger, same asker while they are still on
// the team), the broker is asked about the call again (a grant removed since, a path the guard now refuses, ends the approval `failed` with the
// reason), and only the `needsApproval` flag is waived (`asApproved`: for exactly this capability, in this transaction), because a person has
// just answered it.

/** The queue the decide route puts an approved tool call on: it claims the approval and queues `EXECUTE_QUEUE`. */
export const RESUME_QUEUE = 'approvals.resume';

/** The queue that makes the call. Only `approvals.resume` puts a job here, after the claim has committed. */
export const EXECUTE_QUEUE = 'approvals.execute';

/** Lapsed pending approvals and approved calls that never finished are swept every five minutes. */
export const SWEEP_QUEUE = 'approvals.sweep';

/** `waits`: how many times this call has been put off because the run that asked for it was still going (the job re-queues itself, at most `MAX_WAITS`). */
const Payload = z.strictObject({ approvalId: z.uuid(), waits: z.number().int().min(0).max(1000).optional() });

/** The run that asked is normally stopped before anyone approves; if it is not yet, the call waits ten seconds at a time, for at most five minutes. */
const WAIT_MS = 10_000;
const MAX_WAITS = 30;

/** The repo path(s) the call names, which the broker's path guard must see (the same rule the MCP gateway applies at its door). */
function authorizeContext(input: Record<string, unknown>): CapabilityAuthorizeContext {
  const path = input['path'];
  const paths = input['paths'];
  return {
    ...(typeof path === 'string' ? { path } : {}),
    ...(Array.isArray(paths) && paths.every((p): p is string => typeof p === 'string') ? { paths } : {}),
  };
}

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  source: string;
  tool: string;
  bot_id: string | null;
  requester_id: string;
  requester_kind: string;
  channel_id: string | null;
  /** The channel the run answered in is private (a private channel, a DM, a bot conversation). */
  channel_private: boolean;
  thread_root_id: string | null;
  /** The run that asked: what it had read is what the re-run has read (`ctx.runs.inheritSources`, below). */
  run_id: string | null;
  /** The approval was filed from a run (`run_id` was set); `run_id` is NULL now when that run was deleted. */
  had_run: boolean;
  resume: unknown;
}

const clip = (text: string, max = 400): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The sentence a failed or finished call leaves on the approval: what the tool said, or what stopped it, never its arguments. */
function detailOf(result: unknown): { ok: boolean; detail: string } {
  if (result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
    const message = (result as { message?: unknown; code?: unknown }).message;
    const code = (result as { code?: unknown }).code;
    return { ok: false, detail: clip(typeof message === 'string' ? message : typeof code === 'string' ? code : 'The tool refused the call.') };
  }
  return { ok: true, detail: 'Ran as the bot after approval.' };
}

async function settle(
  ctx: PluginContext,
  tx: PluginTx,
  row: ClaimedRow,
  outcome: 'ran' | 'failed',
  detail: string,
): Promise<void> {
  // only a call that is still `running` is settled: a row the sweep already called failed is not rewritten behind its back
  const done = await tx.query("UPDATE app.approvals SET outcome = $2, outcome_detail = $3 WHERE id = $1::uuid AND outcome = 'running' RETURNING id", [row.id, outcome, detail]);
  if (done.rows.length === 0) return;
  await ctx.audit.emit(
    tx,
    ApprovalsApprovalResumedEvent.parse({
      type: 'approvals.approval.resumed',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      approvalId: row.id,
      source: row.source,
      tool: row.tool,
      botId: row.bot_id,
      outcome,
      // the event is team-wide; the sentence (what the tool said) belongs to a private conversation's people, so such an approval's event carries none
      detail: row.channel_private ? '' : detail,
    }),
  );
  await pushChanged(ctx, tx, row.id);
}

export function registerResumeJob(ctx: PluginContext): void {
  // Stage one: claim. Its transaction commits the claim and the follow-up job together, before anything is done.
  ctx.jobs.register(
    RESUME_QUEUE,
    async (raw, tx, job) => {
      const { approvalId } = Payload.parse(raw);
      const claimed = await tx.query(
        `UPDATE app.approvals SET outcome = 'running', started_at = now(), outcome_detail = 'Running after approval.'
          WHERE id = $1::uuid AND status = 'approved' AND outcome = 'queued' AND resume_kind = 'tool' RETURNING id`,
        [approvalId],
      );
      if (claimed.rows.length === 0) return; // already claimed (a second delivery), or not a tool call
      job.log.info(`approvals: approval ${approvalId} claimed`);
      await ctx.jobs.enqueue(tx, EXECUTE_QUEUE, { approvalId }, { dedupeKey: `approvals-execute:${approvalId}` });
    },
    { maxAttempts: 1 },
  );

  // Stage two: make the call. Never retried; never started twice.
  ctx.jobs.register(
    EXECUTE_QUEUE,
    async (raw, tx, job) => {
      const { approvalId, waits = 0 } = Payload.parse(raw);
      const row = (
        await tx.query<ClaimedRow>(
          `SELECT a.id, a.workspace_id, a.team_id, a.source, a.tool, a.bot_id, a.requester_id, ra.kind AS requester_kind,
                  a.channel_id, coalesce(c.private, false) AS channel_private, a.thread_root_id, a.run_id, a.had_run, a.resume
             FROM app.approvals a JOIN app.actors ra ON ra.id = a.requester_id LEFT JOIN app.channels c ON c.id = a.channel_id
            WHERE a.id = $1::uuid AND a.status = 'approved' AND a.outcome = 'running' AND a.resume_kind = 'tool'`,
          [approvalId],
        )
      ).rows[0];
      if (!row) return;
      const fail = (detail: string): Promise<void> => settle(ctx, tx, row, 'failed', detail);
      // A second attempt means the first did not report back: the call may have been made. It is never made again.
      if (job.attempt > 1) return fail('The call was interrupted; it may or may not have been made. Check before asking again.');

      const resume = ApprovalResume.safeParse(row.resume);
      if (!resume.success || resume.data.kind !== 'tool' || row.bot_id === null) return fail('The stored call could not be read.');
      const call = resume.data;
      const botId = row.bot_id;
      // Defence in depth: an approval for one of these is never filed, but a row from before that rule (or written some other way) is never run either.
      if (NEVER_APPROVAL_GATED.includes(call.capability)) return fail(neverApprovalGatedReason(call.capability));
      // What the stopped run had read decides what the re-run may write (memory rule): with that run gone there is nothing to inherit and the call
      // would pass for one that read nothing. Fail closed.
      if (row.had_run && row.run_id === null) return fail('The call was not made: the run that asked for it no longer exists, so what it had read cannot be carried over.');

      // The source log of the run that asked can still grow while that run is going, and a copy of it would not be the whole. A run that asked for
      // an approval ends `stopped` as soon as it notices; normally it has long before a person answers. If it has not, wait for it (a second job of
      // this queue, not a retry: this one finishes, so its "never twice" rule is untouched).
      if (row.run_id) {
        const origin = (await tx.query<{ running: boolean }>("SELECT (status = 'running' AND ended_at IS NULL) AS running FROM app.bot_runs WHERE id = $1::uuid", [row.run_id])).rows[0];
        if (origin?.running === true) {
          if (waits >= MAX_WAITS) return fail('The call was not made: the run that asked for it was still going after five minutes, so what it had read could not be carried over.');
          await ctx.jobs.enqueue(tx, EXECUTE_QUEUE, { approvalId, waits: waits + 1 }, { runAt: new Date(ctx.runtime.now().getTime() + WAIT_MS), dedupeKey: `approvals-execute:${approvalId}:${waits + 1}` });
          return;
        }
      }

      let opened: Awaited<ReturnType<PluginContext['runs']['open']>> | null = null;
      // The same asker while they are still on the team (a person-only scope such as `person:*` then still means what it meant); without them the
      // call is the bot's alone, which is never wider.
      for (const asker of row.requester_kind === 'person' ? [row.requester_id, null] : [null]) {
        try {
          opened = await ctx.runs.open({
            botId,
            teamId: row.team_id,
            workspaceId: row.workspace_id,
            trigger: call.trigger,
            askerActorId: asker,
            channelId: row.channel_id,
            replyRootId: row.thread_root_id,
            ttlSeconds: 120,
          });
          break;
        } catch (err) {
          if (asker === null) {
            job.log.warn(`approvals: no run for approval ${approvalId}: ${err instanceof Error ? err.message : String(err)}`);
            return fail('The bot is no longer on the team, so the call was not made.');
          }
        }
      }
      if (!opened) return fail('The call could not be started.');
      const { run } = opened;

      // The re-run is a NEW run with an empty source log, but what it writes was decided by a run that had read things: a private message, a
      // person's Drive. Without those lines the memory rule (the narrowest source a run read, SPEC 12.1) would see a run that read nothing and
      // retain text derived from them. So the re-run starts having read what the stopped run had read — all of it, in one statement with no cap:
      // a truncated copy would let a person line past the cut read as a clean run. If the copy cannot be made the call is not made.
      if (row.run_id) {
        try {
          await ctx.runs.inheritSources(run, row.run_id);
        } catch (err) {
          job.log.warn(`approvals: the re-run of approval ${approvalId} could not inherit its run's source log: ${err instanceof Error ? err.message : String(err)}`);
          await ctx.runs.close(run.runId, 'failed').catch(() => undefined);
          return fail('The call was not made: what the stopped run had read could not be carried over.');
        }
      }

      // The call is made (or refused) first; only then is anything recorded. What happens after the call has committed must never be able to
      // turn "it ran" into "it failed": settle `ran`, and let closing the run fail on its own.
      let verdict: { ok: boolean; detail: string };
      try {
        const decision = await ctx.runs.authorize(run, call.capability, authorizeContext(call.args));
        if (!decision.allowed) {
          verdict = { ok: false, detail: clip(`The bot may no longer make this call: ${decision.reason}`) };
        } else {
          verdict = detailOf(await ctx.runs.asApproved(run, call.capability, (inner) => ctx.runs.invoke(inner, call.capability, call.args)));
        }
      } catch (err) {
        job.log.warn(`approvals: approved call ${call.capability} (approval ${approvalId}) threw: ${err instanceof Error ? err.message : String(err)}`);
        verdict = { ok: false, detail: clip(`The call failed: ${err instanceof Error ? err.message : String(err)}`) };
      }
      await settle(ctx, tx, row, verdict.ok ? 'ran' : 'failed', verdict.detail);
      await ctx.runs.close(run.runId, verdict.ok ? 'done' : 'failed').catch((err: unknown) => {
        job.log.warn(`approvals: run ${run.runId} of approval ${approvalId} could not be closed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    { maxAttempts: 1 },
  );

  // The sweep: a pending approval nobody decided in time lapses; an approved call that never finished is called failed (never re-run).
  ctx.jobs.register(
    SWEEP_QUEUE,
    async (_raw, tx, job) => {
      const expired = await tx.query<{ id: string; team_id: string }>(
        `UPDATE app.approvals SET status = 'expired', decided_at = now()
          WHERE status = 'pending' AND expires_at <= now() RETURNING id, team_id`,
      );
      const stuck = await tx.query<{ id: string; workspace_id: string; team_id: string; source: string; tool: string; bot_id: string | null; was: string }>(
        `WITH stuck AS (
             SELECT id, outcome AS was FROM app.approvals
              WHERE status = 'approved' AND outcome IN ('queued', 'running')
                AND coalesce(started_at, decided_at) < now() - make_interval(mins => $1) FOR UPDATE)
           UPDATE app.approvals a SET outcome = 'failed',
                  outcome_detail = CASE WHEN s.was = 'running'
                    THEN 'It started but never reported back; it may or may not have been made. Check before asking again.'
                    ELSE 'It was approved but never started.' END
             FROM stuck s WHERE a.id = s.id
           RETURNING a.id, a.workspace_id, a.team_id, a.source, a.tool, a.bot_id, s.was`,
        [APPROVAL_RUN_TIMEOUT_MINUTES],
      );
      for (const row of stuck.rows) {
        await ctx.audit.emit(
          tx,
          ApprovalsApprovalResumedEvent.parse({
            type: 'approvals.approval.resumed',
            schemaVersion: 1,
            workspaceId: row.workspace_id,
            teamId: row.team_id,
            approvalId: row.id,
            source: row.source,
            tool: row.tool,
            botId: row.bot_id,
            outcome: 'failed',
            detail: row.was === 'running' ? 'Never reported back.' : 'Never started.',
          }),
        );
      }
      for (const row of [...expired.rows, ...stuck.rows]) await pushChanged(ctx, tx, row.id);
      if (expired.rows.length + stuck.rows.length > 0) job.log.info(`approvals: swept ${expired.rows.length} lapsed and ${stuck.rows.length} unfinished`);
    },
    { cron: '*/5 * * * *', maxAttempts: 1 },
  );
}

import type { CapabilityAuthorizeContext, PluginContext, PluginTx } from '@manythreads/sdk';
import { ApprovalResume, ApprovalsApprovalResumedEvent } from '@manythreads/shared';
import { z } from 'zod';
import { pushChanged } from './notify.ts';

// What approving a tool call does (PLAN P5-20, SPEC §7.3). The run that asked has already ended (`stopped`): a model cannot wait for a
// person, and the process is gone. So approving does the one thing the person approved — it re-runs *that call*, once, as the bot, with the
// arguments that were stored — and records what became of it on the approval, where the card in the thread shows it. It does not restart the
// conversation; the person can ask the bot again, and the call it would make is now done.
//
// The re-run is exactly as constrained as the original: a new run is opened for the bot (same trigger, same asker while they are still on
// the team), the broker is asked about the call again (a grant removed since, a path the guard now refuses — the approval then ends `failed`),
// and only the `needsApproval` flag is waived, because a person has just answered it. The call is claimed before it runs (`queued` → `ran`
// in one statement) and the job never throws, so a call is run at most once: a model-side effect is not something to replay blindly.

/** The queue the decide route puts an approved tool call on. */
export const RESUME_QUEUE = 'approvals.resume';

const Payload = z.strictObject({ approvalId: z.uuid() });

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
  thread_root_id: string | null;
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
  await tx.query('UPDATE app.approvals SET outcome = $2, outcome_detail = $3 WHERE id = $1::uuid', [row.id, outcome, detail]);
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
      detail,
    }),
  );
  await pushChanged(ctx, tx, row.team_id, row.id);
}

export function registerResumeJob(ctx: PluginContext): void {
  ctx.jobs.register(RESUME_QUEUE, async (raw, tx, job) => {
    const { approvalId } = Payload.parse(raw);
    // Claim it: the same statement that reads the stored call marks it `ran`, so a second delivery finds nothing to do.
    const row = (
      await tx.query<ClaimedRow>(
        `UPDATE app.approvals a SET outcome = 'ran', outcome_detail = 'Running after approval.'
           FROM app.actors ra
          WHERE a.id = $1::uuid AND a.status = 'approved' AND a.outcome = 'queued' AND a.resume_kind = 'tool' AND ra.id = a.requester_id
        RETURNING a.id, a.workspace_id, a.team_id, a.source, a.tool, a.bot_id, a.requester_id, ra.kind AS requester_kind,
                  a.channel_id, a.thread_root_id, a.resume`,
        [approvalId],
      )
    ).rows[0];
    if (!row) return;

    const fail = (detail: string): Promise<void> => settle(ctx, tx, row, 'failed', detail);
    const resume = ApprovalResume.safeParse(row.resume);
    if (!resume.success || resume.data.kind !== 'tool' || row.bot_id === null) return fail('The stored call could not be read.');
    const call = resume.data;
    const botId = row.bot_id;

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

    try {
      const decision = await ctx.runs.authorize(run, call.capability, authorizeContext(call.args));
      if (!decision.allowed) {
        await ctx.runs.close(run.runId, 'failed');
        return await fail(clip(`The bot may no longer make this call: ${decision.reason}`));
      }
      const result = await ctx.runs.asBot(run, (inner) => ctx.runs.invoke(inner, call.capability, call.args));
      const verdict = detailOf(result);
      await ctx.runs.close(run.runId, verdict.ok ? 'done' : 'failed');
      await settle(ctx, tx, row, verdict.ok ? 'ran' : 'failed', verdict.detail);
    } catch (err) {
      job.log.warn(`approvals: approved call ${call.capability} (approval ${approvalId}) threw: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.runs.close(run.runId, 'failed');
      await fail(clip(`The call failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

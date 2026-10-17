import type { PluginContext } from '@manythreads/sdk';
import { z } from 'zod';
import { EXECUTE_QUEUE } from './execute.ts';

/** The queue the decide route puts an approved tool call on: it claims the approval and queues `EXECUTE_QUEUE`. */
export const RESUME_QUEUE = 'approvals.resume';

/** `waits`: how many times this call has been put off because the run that asked for it was still going (the job re-queues itself until that run's own deadline, see `executeWait`). */
export const Payload = z.strictObject({ approvalId: z.uuid(), waits: z.number().int().min(0).max(1000).optional() });

/** Stage one: claim. Its transaction commits the claim and the follow-up job together, before anything is done. */
export function registerResumeClaim(ctx: PluginContext): void {
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
}

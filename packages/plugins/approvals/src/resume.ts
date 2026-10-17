import type { PluginContext } from '@manythreads/sdk';
import { registerResumeClaim } from './claim.ts';
import { registerExecuteJob } from './execute.ts';
import { registerSweepJob } from './sweep.ts';

export { RESUME_QUEUE } from './claim.ts';
export { EXECUTE_QUEUE } from './execute.ts';
export { SWEEP_QUEUE } from './sweep.ts';
export { executeWait } from './wait.ts';

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
//
// The stages live in `./claim.ts` (stage one), `./execute.ts` (stage two), `./sweep.ts` (the sweep) and `./wait.ts` (the pure wait rule);
// this module is the facade over them.
export function registerResumeJob(ctx: PluginContext): void {
  registerResumeClaim(ctx);
  registerExecuteJob(ctx);
  registerSweepJob(ctx);
}

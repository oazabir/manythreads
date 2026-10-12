import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ApprovalId, BotId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A bot's gate stopped a run before any model call (SPEC §7.3, PLAN P5-11). `stage` says which check fired: `exact` and `regex` are the
 * two kinds of entry in the bot's gate list (stage one); `classifier` is the local model deciding the message is on a gate-list topic
 * (stage two); `classifier_unavailable` is stage two failing to answer (no `local` alias, the proxy down), which holds the message too —
 * the gate fails closed. `entry` is the gate-list entry that matched (configuration, not message text); null for the classifier.
 * `approvalId` is the pending approval filed for it, or null when none could be (the approvals plugin is not loaded, or nobody but the
 * asker could decide it in that private conversation): the run stops either way.
 */
export const RuntimeGateHeldEvent = z.object({
  type: z.literal('runtime.gate.held'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  runId: RunId,
  stage: z.enum(['exact', 'regex', 'classifier', 'classifier_unavailable']),
  entry: z.string().nullable(),
  approvalId: ApprovalId.nullable(),
  at: IsoDateTime,
});
export type RuntimeGateHeldEvent = z.infer<typeof RuntimeGateHeldEvent>;

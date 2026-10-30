import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { GuardrailsPolicyChange, GuardrailsPolicyKind } from '../entities/guardrails.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * An admin changed the data-protection policy (PLAN P10-04): how a kind of finding is treated, a custom rule, or one team's list of reachable hosts.
 * `subject` names what changed by its short code (a detector name, a custom rule's name) and is null for a team list; it never carries a pattern, a host
 * or any text. Written only when something really changed.
 */
export const GuardrailsPolicyUpdatedEvent = z.object({
  type: z.literal('guardrails.policy.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  kind: GuardrailsPolicyKind,
  change: GuardrailsPolicyChange,
  subject: z.string().max(60).nullable(),
  teamId: TeamId.nullable(),
  changedBy: ActorId,
  at: IsoDateTime,
});
export type GuardrailsPolicyUpdatedEvent = z.infer<typeof GuardrailsPolicyUpdatedEvent>;

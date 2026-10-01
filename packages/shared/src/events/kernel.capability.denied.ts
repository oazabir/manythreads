import { z } from 'zod';
import { ActorId, RunId, WorkspaceId } from '../ids.ts';

/** The capability broker refused a request. Written for every denial (audit trail until the phase 10 console). */
export const KernelCapabilityDeniedEvent = z.object({
  type: z.literal('kernel.capability.denied'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  actorId: ActorId,
  actorKind: z.enum(['person', 'bot', 'system']),
  runId: RunId.nullable(),
  capability: z.string().min(1),
  reason: z.string().min(1),
  path: z.string().nullable(),
  trigger: z.string().nullable(),
});
export type KernelCapabilityDeniedEvent = z.infer<typeof KernelCapabilityDeniedEvent>;

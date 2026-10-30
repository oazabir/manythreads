import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/** An admin put the setup checklist away for good, after the first goal was sent. */
export const OnboardingChecklistDismissedEvent = z.object({
  type: z.literal('onboarding.checklist.dismissed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  dismissedBy: ActorId,
  at: IsoDateTime,
});
export type OnboardingChecklistDismissedEvent = z.infer<typeof OnboardingChecklistDismissedEvent>;

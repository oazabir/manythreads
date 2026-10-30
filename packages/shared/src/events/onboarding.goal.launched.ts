import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, TeamId, WorkspaceId } from '../ids.ts';

/** The first admin sent their first goal to Brain from the setup wizard. Carries where it went (team and conversation), never the words. */
export const OnboardingGoalLaunchedEvent = z.object({
  type: z.literal('onboarding.goal.launched'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  launchedBy: ActorId,
  at: IsoDateTime,
});
export type OnboardingGoalLaunchedEvent = z.infer<typeof OnboardingGoalLaunchedEvent>;

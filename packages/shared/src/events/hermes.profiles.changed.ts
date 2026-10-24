import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { TeamId, WorkspaceId } from '../ids.ts';

/**
 * The set of gateway profiles a team's managed Hermes pod must hold changed: a bot placed on the managed gateway was added, removed or edited,
 * or one of its credentials was rotated. A controller reacts by asking the `hermes.profiles` provider for `profilesForTeam` again.
 */
export const HermesProfilesChangedEvent = z.object({
  type: z.literal('hermes.profiles.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  at: IsoDateTime,
});
export type HermesProfilesChangedEvent = z.infer<typeof HermesProfilesChangedEvent>;

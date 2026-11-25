import { z } from 'zod';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** A meeting series (P17-05) was made, changed (its title or people) or stopped. Ids and times only: never its title, its agenda or anyone's name. */
export const MeetingsSeriesChangedEvent = z.object({
  type: z.literal('meetings.series.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  seriesId: z.uuid(),
  change: z.enum(['created', 'changed', 'stopped']),
  changedBy: ActorId,
  at: z.iso.datetime(),
});
export type MeetingsSeriesChangedEvent = z.infer<typeof MeetingsSeriesChangedEvent>;

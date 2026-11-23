import { z } from 'zod';
import { ActorId, ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * An incident (P35-07) was opened, is due a status update on its rhythm, or was resolved. The runtime wakes the team's alert-triage bot in the incident's
 * thread on each. No title or summary text rides along: the bot reads the thread.
 */
export const ChannelIncidentChangedEvent = z.object({
  type: z.literal('channel.incident.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  incidentId: z.uuid(),
  channelId: ChannelId,
  rootMessageId: MessageId,
  change: z.enum(['opened', 'update_due', 'resolved']),
  /** Who the bot works for: the person who opened it (or resolved it); null for the rhythm when the opener is gone. */
  actorId: ActorId.nullable(),
  /** The post-mortem page the resolve drafted (`pages/incidents/….md`), on `resolved`. */
  postmortemPath: z.string().max(300).nullable(),
});
export type ChannelIncidentChangedEvent = z.infer<typeof ChannelIncidentChangedEvent>;

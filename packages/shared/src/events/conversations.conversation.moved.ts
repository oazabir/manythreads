import { z } from 'zod';
import { BotId, ChannelId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A person's conversation with the workspace Brain moved to another team (P20-07): they left the team it was made in, so the platform re-seated the conversation
 * channel, its index rows and its files in their oldest remaining team. Messages, threads and ids are unchanged. Ids only, never any text.
 *
 * Deliberately carries no `teamId`, for the same reason as `conversations.conversation.started`: the stored event's `team_id` is taken from the payload, and a
 * team-scoped event is readable by every member of that team. The two teams are named `fromTeamId` and `toTeamId`, so the event stays workspace-scoped and only a
 * workspace admin's `events_select` reaches it.
 */
export const ConversationsConversationMovedEvent = z.object({
  type: z.literal('conversations.conversation.moved'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  botId: BotId,
  personId: PersonId,
  channelId: ChannelId,
  fromTeamId: TeamId,
  toTeamId: TeamId,
});
export type ConversationsConversationMovedEvent = z.infer<typeof ConversationsConversationMovedEvent>;

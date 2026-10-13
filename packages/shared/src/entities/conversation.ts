import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, ChannelId, MessageId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

// Conversations (SPEC §6.2, PLAN P5-16). A conversation is an ordinary thread: the root is the person's message in the
// unlisted per-(bot, person) channel of kind `bot_conversation`, and the bot replies in it. The `conversations` table is the
// index of those threads and the only place their visibility is recorded. Enums match the SQL CHECK exactly (a test compares both).

/**
 * Who may find a conversation in a list. `private` (the default, and what a row that was never changed holds): the person who asked and
 * nobody else. `shared`: the team the bot belongs to lists it under Shared (P5-17 sets it, with its masking rules, and says where).
 */
export const ConversationVisibility = z.enum(['private', 'shared']);
export type ConversationVisibility = z.infer<typeof ConversationVisibility>;

/** One conversation of a bot with a person: the index row of a thread in the bot's conversation channel. */
export const Conversation = z.object({
  /** The person's first message; the id of the thread. */
  threadRootId: MessageId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  /** Who asked: the only person who reads a `private` conversation. */
  personId: PersonId,
  channelId: ChannelId,
  visibility: ConversationVisibility,
  /** The channel it was shared to and the thread there (P5-17); null while private. */
  sharedTo: ChannelId.nullable(),
  sharedRootId: MessageId.nullable(),
  sharedBy: ActorId.nullable(),
  sharedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Conversation = z.infer<typeof Conversation>;

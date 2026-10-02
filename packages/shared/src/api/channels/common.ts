import { z } from 'zod';
import { Message, Emoji } from '../../entities/message.ts';
import { IsoDateTime } from '../../common/time.ts';

/** A channel name as a client may write it: with or without the leading `#` (the server stores it without). */
export const ChannelNameInput = z.string().regex(/^#?[a-z0-9][a-z0-9-]{0,62}$/, 'channel name like "dev" or "#dev"');
export type ChannelNameInput = z.infer<typeof ChannelNameInput>;

export const ChannelPurpose = z.string().trim().max(250);

/** What a reaction looks like to the caller: how many actors used the emoji, and whether the caller is one of them. */
export const ReactionSummary = z.object({ emoji: Emoji, count: z.number().int().positive(), mine: z.boolean() });
export type ReactionSummary = z.infer<typeof ReactionSummary>;

/**
 * A message as the channel view lists it: the stored message plus its reactions and, for a thread root, how many replies it has.
 * A deleted message keeps its row (so a thread keeps its place): `deletedAt` is set, `body` is a fixed tombstone and `bodyPlain` is empty.
 */
export const ChannelMessage = Message.extend({
  reactions: z.array(ReactionSummary),
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime.nullable(),
});
export type ChannelMessage = z.infer<typeof ChannelMessage>;

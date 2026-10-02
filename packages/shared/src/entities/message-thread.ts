import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MessageId, PersonId } from '../ids.ts';

/** One thread per root message, created by its first reply. `replyCount` counts replies that are not deleted. */
export const Thread = z.object({
  rootMessageId: MessageId,
  channelId: ChannelId,
  title: z.string(),
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime,
});
export type Thread = z.infer<typeof Thread>;

/** A person follows a thread: it shows in their Threads inbox. */
export const ThreadFollow = z.object({
  personId: PersonId,
  threadRootId: MessageId,
  createdAt: IsoDateTime,
});
export type ThreadFollow = z.infer<typeof ThreadFollow>;

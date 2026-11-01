import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, CustomEmojiId, WorkspaceId } from '../ids.ts';
import { CustomEmojiName } from '../entities/custom-emoji.ts';

/**
 * A workspace admin added or removed a custom emoji (PLAN P14-02). The set of pictures every message of the workspace may show is a thing admins
 * govern, so a change is an audited act: who, what name, when. The payload holds the name (2 to 32 lower-case letters, digits and underscores, so it
 * can hold nothing a person wrote beyond that) and ids, never the picture.
 */
export const ChannelCustomEmojiChangedEvent = z.object({
  type: z.literal('channel.custom_emoji.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  emojiId: CustomEmojiId,
  name: CustomEmojiName,
  change: z.enum(['added', 'deleted']),
  changedBy: ActorId,
  at: IsoDateTime,
});
export type ChannelCustomEmojiChangedEvent = z.infer<typeof ChannelCustomEmojiChangedEvent>;

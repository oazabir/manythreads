import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, FileId, MessageId, WorkspaceId } from '../ids.ts';
import { AnswerPayloadView } from './answer.ts';
import { MAX_ATTACHMENTS_PER_MESSAGE } from './file.ts';

/** A text that cannot be stored: the database refuses the NUL character (U+0000) in any text, so it is refused up front with a plain sentence rather than failing the save. */
export const NO_NUL_MESSAGE = 'the text has a null character (U+0000), which cannot be saved; remove it';
export const hasNul = (text: string): boolean => text.includes('\u0000');

/** A message body: 1 to 40,000 characters of markdown, with no null character. */
export const MessageBody = z
  .string()
  .min(1)
  .max(40_000)
  .refine((v) => !hasNul(v), { message: NO_NUL_MESSAGE }); // markdown

export const Message = z.object({
  id: MessageId,
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  authorId: ActorId,
  body: MessageBody,
  bodyPlain: z.string(), // derived by the server, used for search
  threadRootId: MessageId.nullable(),
  editedAt: IsoDateTime.nullable(),
  deletedAt: IsoDateTime.nullable(),
  meta: z.object({
    answerRef: z.string().optional(),
    /**
     * The Answer a bot finished its reply with (`answer.post`, PLAN P5-18): numbered citations, lineage, what was reached and what was out of
     * scope, whom it was for. Written only by the platform. A payload that does not read (a newer shape) is dropped, never the message.
     */
    answer: AnswerPayloadView.optional().catch(undefined),
    surfaceRef: z.string().optional(),
    /** Files attached to the message, in the order the sender listed them (rows of `files` in the same channel, uploaded by the author). */
    attachments: z.array(FileId).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  }),
  createdAt: IsoDateTime,
});
export type Message = z.infer<typeof Message>;

/** An emoji (or `:shortcode:`): no whitespace, at most 64 characters. */
export const Emoji = z.string().min(1).max(64).regex(/^\S+$/, 'an emoji has no spaces');
export type Emoji = z.infer<typeof Emoji>;

/** One actor reacted to one message with one emoji. */
export const Reaction = z.object({
  messageId: MessageId,
  actorId: ActorId,
  emoji: Emoji,
  createdAt: IsoDateTime,
});
export type Reaction = z.infer<typeof Reaction>;

export const MentionKind = z.enum(['person', 'bot', 'channel']);
export type MentionKind = z.infer<typeof MentionKind>;

/** A mention parsed out of a message: `mentionedId` is a person or bot actor id, or a channel id. */
export const Mention = z.object({
  messageId: MessageId,
  mentionedId: z.uuid(),
  kind: MentionKind,
  createdAt: IsoDateTime,
});
export type Mention = z.infer<typeof Mention>;

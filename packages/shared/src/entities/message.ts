import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, FileId, MeetingId, MessageId, WorkspaceId } from '../ids.ts';
import { AnswerPayloadView } from './answer.ts';
import { MessageVia } from './bridge.ts';
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

/** The longest voice message: five minutes. */
export const VOICE_MAX_MS = 300_000;

/**
 * What a voice message keeps beside its text (P14-17). The message's body is the transcript (so search, notifications and bots read it
 * with no extra code); the clip itself is a file attached to the message, and `fileId` names it again here so a reader knows which
 * attachment to draw as a player. `transcript` says where the body came from: `device` (the sender's own device wrote it), `edited`
 * (a person changed it afterwards) or `none` (no transcript: the body is only a stand-in line, see `voiceFallbackBody`).
 * `peaks` are up to 64 loudness values (0 to 255) for the waveform.
 */
export const VoiceMeta = z.strictObject({
  fileId: FileId,
  durationMs: z.number().int().min(500).max(VOICE_MAX_MS),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
    .nullable(),
  transcript: z.enum(['device', 'edited', 'none']),
  peaks: z.array(z.number().int().min(0).max(255)).max(64),
});
export type VoiceMeta = z.infer<typeof VoiceMeta>;

/** The body of a voice message that has no transcript: `Voice message (0:42)`. */
export function voiceFallbackBody(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const seconds = total % 60;
  return `Voice message (${Math.floor(total / 60)}:${seconds < 10 ? '0' : ''}${seconds})`;
}

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
    /** The id of the surface (a screen) a bot drew in this message's place (`surface.render`, P9-04): the client reads it in its channel and draws it. Written only by the platform. */
    surfaceRef: z.string().optional(),
    /** Files attached to the message, in the order the sender listed them (rows of `files` in the same channel, uploaded by the author). */
    attachments: z.array(FileId).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    /** A voice message (P14-17): the clip (also `attachments[0]`), its length, language and where the text came from. A value that does not read (a newer shape) is dropped, never the message. */
    voice: VoiceMeta.optional().catch(undefined),
    /** The run that failed and the category of why (`failure-notice.ts`): set on the notice a failed run leaves in its thread, by the platform alone. Chat offers Try again on it. */
    runFailure: z.string().max(40).optional().catch(undefined),
    /** The meeting a note-taker's direct message is about (P15-23): the client draws Open the notes, Share and Save buttons under the text. Written by the platform alone; a value that does not read is dropped, never the message. */
    meetingNotes: z.object({ meetingId: MeetingId }).optional().catch(undefined),
    /** The run that wrote a bot's message (stamped by the platform): the client asks `GET /api/runs/:runId/origin` for what started it and draws the origin card when a work app did (Bundle D, P16-10). A value that does not read is dropped, never the message. */
    runId: z.uuid().optional().catch(undefined),
    /** The chat app a message came across from (Bundle D bridges, P16-09): the web draws a small "via Telegram" note. Written by the bridges plugin alone; a value that does not read is dropped, never the message. */
    via: MessageVia.optional().catch(undefined),
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

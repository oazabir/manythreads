import { z } from 'zod';
import { Message, VoiceMeta } from '../../entities/message.ts';

export const PostMessageRequest = Message.pick({ channelId: true, body: true, threadRootId: true })
  .extend({
    /** Files already uploaded to this channel by the sender (`POST /api/channels/:channelId/files`); stored as `meta.attachments`. */
    attachments: Message.shape.meta.shape.attachments,
    /**
     * "Also send to channel" (P14-12), only with `threadRootId`: the reply is posted in the thread and the same text is posted again as a message
     * of the channel itself, marked as sent from that thread. The two are separate messages (editing one does not change the other).
     */
    alsoToChannel: z.boolean().optional(),
    /**
     * The writer confirmed that `@here` / `@channel` will notify a big room (P14-02, see api/channels/broadcast.ts). Without it the server refuses a message that
     * names either word in a room of more than 20 other readers (409 `broadcast_needs_confirmation`).
     */
    confirmBroadcast: z.boolean().optional(),
    /**
     * A voice message (P14-17): the clip is the one entry of `attachments` and `voice.fileId` names it; `body` is the transcript, or
     * `voiceFallbackBody(durationMs)` when there is none. Stored as `meta.voice`. People only, and not guests (403).
     */
    voice: VoiceMeta.optional(),
  })
  .strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

/** A role group the message named that was notified only in part: `reached` people could read it, `notified` were told (one message notifies a group's first 500). */
export const GroupMentionNotice = z.object({ handle: z.string(), reached: z.number().int().positive(), notified: z.number().int().positive() });
export type GroupMentionNotice = z.infer<typeof GroupMentionNotice>;

/** The new message; `groupNotices` appears only when a group mention was cut short, so the author can tell the rest in person. */
export const PostMessageResponse = Message.extend({ groupNotices: z.array(GroupMentionNotice).optional() });
export type PostMessageResponse = z.infer<typeof PostMessageResponse>;

export const postMessageRoute = { method: 'POST', path: '/api/channels/:channelId/messages' } as const;

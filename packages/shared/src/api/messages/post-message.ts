import { z } from 'zod';
import { Message } from '../../entities/message.ts';

export const PostMessageRequest = Message.pick({ channelId: true, body: true, threadRootId: true })
  .extend({
    /** Files already uploaded to this channel by the sender (`POST /api/channels/:channelId/files`); stored as `meta.attachments`. */
    attachments: Message.shape.meta.shape.attachments,
    /**
     * "Also send to channel" (P14-12), only with `threadRootId`: the reply is posted in the thread and the same text is posted again as a message
     * of the channel itself, marked as sent from that thread. The two are separate messages (editing one does not change the other).
     */
    alsoToChannel: z.boolean().optional(),
  })
  .strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const PostMessageResponse = Message;
export type PostMessageResponse = z.infer<typeof PostMessageResponse>;

export const postMessageRoute = { method: 'POST', path: '/api/channels/:channelId/messages' } as const;

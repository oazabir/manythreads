import { z } from 'zod';
import { Message } from '../../entities/message.ts';

export const PostMessageRequest = Message.pick({ channelId: true, body: true, threadRootId: true }).strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const PostMessageResponse = Message;
export type PostMessageResponse = z.infer<typeof PostMessageResponse>;

export const postMessageRoute = { method: 'POST', path: '/api/channels/:channelId/messages' } as const;

import { z } from 'zod';

/*
 * Answered before (P18-09, P35-06): in a help channel, what the composer shows while a question is being written. A knowledge passage of the channel's team
 * and earlier threads of the team, both read as the asker (a thread they cannot read is not here). Nothing is posted; the asker decides.
 */
export const AnsweredBeforeParams = z.object({ channelId: z.uuid() });
export const AnsweredBeforeQuery = z.object({ q: z.string().trim().min(12).max(500) });
export type AnsweredBeforeQuery = z.infer<typeof AnsweredBeforeQuery>;

export const AnsweredBeforeThread = z.object({
  kind: z.literal('thread'),
  rootId: z.uuid(),
  channelId: z.uuid(),
  channelName: z.string(),
  title: z.string(),
  /** The first reply by someone other than the asker of that thread: the likely answer. */
  answer: z.string().nullable(),
  replyCount: z.number().int(),
  lastReplyAt: z.string(),
});
export const AnsweredBeforePassage = z.object({
  kind: z.literal('knowledge'),
  base: z.string(),
  document: z.string(),
  section: z.string().nullable(),
  text: z.string(),
  file: z.string().nullable(),
});
export const AnsweredBeforeItem = z.discriminatedUnion('kind', [AnsweredBeforeThread, AnsweredBeforePassage]);
export type AnsweredBeforeItem = z.infer<typeof AnsweredBeforeItem>;
export const AnsweredBeforeResponse = z.object({
  /** False when the channel is not a help channel: the composer shows nothing. */
  help: z.boolean(),
  items: z.array(AnsweredBeforeItem),
});
export type AnsweredBeforeResponse = z.infer<typeof AnsweredBeforeResponse>;
export const answeredBeforeRoute = { method: 'GET', path: '/api/channels/:channelId/answered-before' } as const;

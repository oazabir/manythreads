import { AnswerScope, ChannelKind } from '@manythreads/shared';
import { z } from 'zod';

// What `app.answer_view` (migration 0001) answers: the run, one entry per cited source (same index as the citations the bot sent) and one per
// source the run read, each seen as the asker. Parsed here, once, so the builder below works on a typed value and a SQL change that drops a
// field fails loudly at the boundary instead of leaving a payload half-filled.

const Resolved = z.object({
  found: z.boolean(),
  /** How far the source reaches (`team`: anybody on the team may open it). */
  scope: AnswerScope.optional(),
  /** May the people who will read the reply open it? False for a private source cited into somebody else's channel. */
  audience: z.boolean().optional(),
  label: z.string().nullable().optional(),
  at: z.string().nullable().optional(),
  channelId: z.uuid().nullable().optional(),
  channelKind: ChannelKind.nullable().optional(),
  channelName: z.string().nullable().optional(),
  threadRootId: z.uuid().nullable().optional(),
  teamId: z.uuid().nullable().optional(),
  botId: z.uuid().nullable().optional(),
  botSlug: z.string().nullable().optional(),
});
export type Resolved = z.infer<typeof Resolved>;

const SourceRead = Resolved.extend({
  kind: z.string(),
  ref: z.string(),
  /** The scope the run's own source log gave the line (`person`: read through the asker's own connection). */
  logScope: AnswerScope,
});
export type SourceRead = z.infer<typeof SourceRead>;

export const AnswerView = z.object({
  run: z.object({
    runId: z.uuid(),
    botId: z.uuid(),
    botName: z.string().nullable(),
    botSlug: z.string().nullable(),
    alias: z.string().nullable(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    trigger: z.string(),
    hasAsker: z.boolean(),
    askerPersonId: z.uuid().nullable(),
    askerName: z.string().nullable(),
    channelId: z.uuid().nullable(),
    replyRootId: z.uuid().nullable(),
    /** The reply goes to the asker's own conversation: everybody who can read it is the asker. */
    private: z.boolean(),
  }),
  citations: z.array(Resolved),
  sources: z.array(SourceRead),
  bots: z.array(z.object({ id: z.uuid(), slug: z.string(), name: z.string() })),
});
export type AnswerView = z.infer<typeof AnswerView>;

/** The "I already answered" shape of the same function. */
export const AnswerAlready = z.object({ already: z.uuid() });

import { z } from 'zod';
import { ANSWER_LIMITS, AnswerPayload } from '../../entities/answer.ts';
import { BotId, ChannelId, MessageId } from '../../ids.ts';

// What a person can do with an answer in their own conversation (SPEC §6.3, §6.4, §12.4; PLAN P5-17): share it to a channel with masking,
// save it as a page, hand it to another bot. Every route is addressed by the answer's own message, in the caller's own conversation channel;
// the same message in anybody else's reading is a 404 (an admin included: the conversation is the asker's alone).
//
// The shapes are small on purpose. A request carries WHICH claims to remove (numbers) and never any text: what is posted is made by the server
// from the stored answer, so a request cannot add a word to it. The preview answers with the copy exactly as it would be posted and a digest of
// it; the share and the save take that digest back, so the person confirms precisely what is written (and a copy that would now read otherwise —
// a reader added to the channel since — is refused as changed, with a fresh preview to look at).

export const AnswerSharePathParams = z.object({ channelId: ChannelId, messageId: MessageId });
export type AnswerSharePathParams = z.infer<typeof AnswerSharePathParams>;

/** The citation numbers whose claims go from the copy (`[n]` of the answer). Numbers the answer has no citation for are refused. */
export const AnswerClaimsToRemove = z.array(z.number().int().min(1).max(ANSWER_LIMITS.citations)).max(ANSWER_LIMITS.citations);
export type AnswerClaimsToRemove = z.infer<typeof AnswerClaimsToRemove>;

/** Where a copy goes: a channel (a message there) or the team's pages (a file under `pages/answers/`). */
export const AnswerShareTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('channel'), channelId: ChannelId }),
  z.strictObject({ kind: z.literal('page') }),
]);
export type AnswerShareTarget = z.infer<typeof AnswerShareTarget>;

/** A sha-256 of what would be posted: 64 lower-case hex characters. */
export const AnswerShareDigest = z.string().regex(/^[0-9a-f]{64}$/, 'a sha-256 digest');

export const AnswerPreviewRequest = z.strictObject({
  target: AnswerShareTarget,
  remove: AnswerClaimsToRemove.default([]),
});
export type AnswerPreviewRequest = z.infer<typeof AnswerPreviewRequest>;

/** `kept`: the readers may open it and the copy keeps it. `masked`: the copy says "from <you>'s <kind> · not shared". `removed`: the sharer took its claim out. */
export const AnswerShareItemStatus = z.enum(['kept', 'masked', 'removed']);
export type AnswerShareItemStatus = z.infer<typeof AnswerShareItemStatus>;

export const AnswerShareItem = z.object({
  n: z.number().int().min(1).max(ANSWER_LIMITS.citations),
  /** `message`, `thread`, `page`, `file`, `run` (an open set, for sources that arrive later). */
  kind: z.string().min(1).max(32),
  status: AnswerShareItemStatus,
  /** What the source is called, for the sharer's eyes: the copy of a masked or removed one never carries it. */
  label: z.string().max(ANSWER_LIMITS.label),
});
export type AnswerShareItem = z.infer<typeof AnswerShareItem>;

export const AnswerShareCounts = z.object({
  kept: z.number().int().nonnegative(),
  masked: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Sentences of the text that went with the removed claims. */
  sentences: z.number().int().nonnegative(),
  /** Entries of "Sources reached" the readers may not open: counted as "not shared", never named. */
  sourcesDropped: z.number().int().nonnegative(),
});
export type AnswerShareCounts = z.infer<typeof AnswerShareCounts>;

/** Who reads the place the copy goes: `team` (the bot's team and workspace admins) or `wider` (somebody else may too: a guest, another team, a private room). */
export const AnswerShareAudience = z.enum(['team', 'wider']);
export type AnswerShareAudience = z.infer<typeof AnswerShareAudience>;

export const AnswerSharePreview = z.object({
  target: z.object({
    kind: z.enum(['channel', 'page']),
    channelId: ChannelId.nullable(),
    /** `releases` for a channel; null for a page. */
    name: z.string().nullable(),
    private: z.boolean(),
    /** The file the page would be, for a page target. */
    path: z.string().nullable(),
  }),
  audience: AnswerShareAudience,
  items: z.array(AnswerShareItem).max(ANSWER_LIMITS.citations),
  counts: AnswerShareCounts,
  /** The Answer exactly as it will be posted (or written to the page), masked and with the claims removed. */
  payload: AnswerPayload,
  digest: AnswerShareDigest,
});
export type AnswerSharePreview = z.infer<typeof AnswerSharePreview>;

export const ShareAnswerRequest = z.strictObject({
  targetChannelId: ChannelId,
  remove: AnswerClaimsToRemove.default([]),
  digest: AnswerShareDigest,
});
export type ShareAnswerRequest = z.infer<typeof ShareAnswerRequest>;

/** 201 the copy was posted; 200 `replayed`: the same share had been made, and this is that message. */
export const ShareAnswerResponse = z.object({
  messageId: MessageId,
  channelId: ChannelId,
  replayed: z.boolean(),
  counts: AnswerShareCounts,
});
export type ShareAnswerResponse = z.infer<typeof ShareAnswerResponse>;

export const SaveAnswerPageRequest = z.strictObject({
  remove: AnswerClaimsToRemove.default([]),
  digest: AnswerShareDigest,
});
export type SaveAnswerPageRequest = z.infer<typeof SaveAnswerPageRequest>;

/** 201 the page was written; 200 `created: false`: this answer had been saved already, and `path` is that page (it is never overwritten). */
export const SaveAnswerPageResponse = z.object({
  path: z.string(),
  created: z.boolean(),
  counts: AnswerShareCounts,
});
export type SaveAnswerPageResponse = z.infer<typeof SaveAnswerPageResponse>;

export const HandoffAnswerRequest = z.strictObject({ botId: BotId });
export type HandoffAnswerRequest = z.infer<typeof HandoffAnswerRequest>;

/** The thread the other bot was handed the answer in, in the caller's own conversation with it. */
export const HandoffAnswerResponse = z.object({
  channelId: ChannelId,
  threadRootId: MessageId,
  botSlug: z.string(),
  botName: z.string(),
  replayed: z.boolean(),
});
export type HandoffAnswerResponse = z.infer<typeof HandoffAnswerResponse>;

/** The channels a copy may be posted to: team channels the caller can post in (the picker's list). */
export const AnswerShareTargetsResponse = z.object({
  channels: z
    .array(
      z.object({
        id: ChannelId,
        name: z.string(),
        private: z.boolean(),
        teamSlug: z.string().nullable(),
        teamName: z.string().nullable(),
      }),
    )
    .max(200),
});
export type AnswerShareTargetsResponse = z.infer<typeof AnswerShareTargetsResponse>;

const base = '/api/channels/:channelId/messages/:messageId/answer';
export const answerShareTargetsRoute = { method: 'GET', path: `${base}/targets` } as const;
export const answerSharePreviewRoute = { method: 'POST', path: `${base}/preview` } as const;
export const shareAnswerRoute = { method: 'POST', path: `${base}/share` } as const;
export const saveAnswerPageRoute = { method: 'POST', path: `${base}/page` } as const;
export const handoffAnswerRoute = { method: 'POST', path: `${base}/handoff` } as const;

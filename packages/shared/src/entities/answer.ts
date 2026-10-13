import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotId, ChannelId, FileId, MessageId, PersonId, RunId, TeamId } from '../ids.ts';
import { ChannelKind } from './channel.ts';

// The Answer (SPEC §12.4 and §14, PLAN P5-18): what a bot finishes a reply with. The text is a message in the thread like any other; the payload
// rides on that message as `meta.answer`, and the client draws numbered citations, a lineage, what the run reached, what was out of scope, and
// whom the answer was for. Two shapes, on purpose:
//
//   * `AnswerInput` is what the bot SENDS (the `answer.post` tool): a body, the sources it cites by id, and suggestions. Strict. It carries no
//     label, no scope and no `answeredFor`: the platform reads those from the database, as the person who asked, and a bot cannot claim them.
//   * `AnswerPayload` is what is STORED and shown: the platform's reading of the same answer, after every citation was re-checked against the
//     asker's own visibility (a citation the asker cannot read is not in it — only a count and a kind, in `outsideScope`).
//
// Extending it (P5-27 adds the memory citation, P5-17 masks a copy for a channel) is additive: a new member of the `kind` union, a new optional
// field. A reader that meets a kind it does not know — `AnswerPayloadView`, the shape clients parse — keeps the citation as an "unsupported
// source" instead of failing the whole message.

/** Caps that keep a payload small: it is stored on the message row and travels with every read of the message. */
export const ANSWER_LIMITS = {
  body: 20_000,
  citations: 40,
  snippet: 300,
  label: 200,
  chips: 8,
  prompt: 500,
  outside: 12,
  sources: 100,
  alias: 100,
} as const;

/** The kinds of source an answer can cite in this version. P5-27 adds `memory`; the list is how clients tell "known" from "unsupported". */
export const ANSWER_CITATION_KINDS = ['message', 'thread', 'page', 'file', 'run'] as const;
export type AnswerCitationKind = (typeof ANSWER_CITATION_KINDS)[number];

/**
 * How far a source reaches, in the words the run's source log already uses (`app.run_source_log.scope`): `team` is a source anybody on the
 * team may open (a public channel, a team page or file, a run of the team); `channel` is one only the people of a private place may open
 * (a private channel, a direct message, a conversation); `person` is one that belongs to the asker alone (their own connection).
 */
export const AnswerScope = z.enum(['team', 'channel', 'person']);
export type AnswerScope = z.infer<typeof AnswerScope>;

const Label = z.string().max(ANSWER_LIMITS.label);
const Snippet = z.string().max(ANSWER_LIMITS.snippet);
/** An open set (`message`, `file`, `memory`, `drive`, ...): the platform adds kinds of source faster than this enum would. */
const SourceKind = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'a lowercase word');

// What the bot sends ----------------------------------------------------------------------------------------------------------------------

/** One source the answer cites, named by id. The citation's number is its position (1-based): the text refers to it as `[1]`, `[2]`, ... */
export const AnswerCitationInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), messageId: MessageId, snippet: Snippet.optional() }),
  z.strictObject({ kind: z.literal('thread'), threadRootId: MessageId, snippet: Snippet.optional() }),
  /** A file of a team repo (a page under `pages/`, a spec, a runbook); the run's own team when `teamId` is left out. */
  z.strictObject({ kind: z.literal('page'), path: z.string().min(1).max(1024), teamId: TeamId.optional(), snippet: Snippet.optional() }),
  /** A file uploaded to a channel or to the team's Files. */
  z.strictObject({ kind: z.literal('file'), fileId: FileId, snippet: Snippet.optional() }),
  z.strictObject({ kind: z.literal('run'), runId: RunId, snippet: Snippet.optional() }),
]);
export type AnswerCitationInput = z.infer<typeof AnswerCitationInput>;

/** A suggested next step, as the bot asks for it: a follow-up question, or a bot to hand the question and the answer to (named by slug). */
export const AnswerChipInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('followup'), prompt: z.string().min(1).max(ANSWER_LIMITS.prompt), label: z.string().min(1).max(120).optional() }),
  z.strictObject({ kind: z.literal('handoff'), botSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }),
]);
export type AnswerChipInput = z.infer<typeof AnswerChipInput>;

/**
 * Something the bot knows it could not reach (a connection that was not granted, a base it has no access to): a kind and a count, never a title —
 * what a person is not allowed to see is not named to them.
 */
export const AnswerOutsideInput = z.strictObject({ kind: SourceKind, count: z.number().int().min(1).max(1000) });
export type AnswerOutsideInput = z.infer<typeof AnswerOutsideInput>;

/** The arguments of the `answer.post` tool. Strict: `answeredFor`, `lineage` and every scope are the platform's to write. */
export const AnswerInput = z.strictObject({
  body: z.string().min(1).max(ANSWER_LIMITS.body),
  citations: z.array(AnswerCitationInput).max(ANSWER_LIMITS.citations).default([]),
  outsideScope: z.array(AnswerOutsideInput).max(ANSWER_LIMITS.outside).default([]),
  chips: z.array(AnswerChipInput).max(ANSWER_LIMITS.chips).default([]),
});
export type AnswerInput = z.infer<typeof AnswerInput>;

// What is stored and shown ----------------------------------------------------------------------------------------------------------------

const CitationBase = {
  /** The number the text refers to: the citation's position in what the bot sent (so a dropped citation leaves a gap, never a renumbering). */
  n: z.number().int().min(1).max(ANSWER_LIMITS.citations),
  /** What the platform read of the source, as the asker: a message's first words, a thread's title, a file's name. Never the bot's own words. */
  label: Label,
  scope: AnswerScope,
};

export const AnswerMessageCitation = z.object({
  kind: z.literal('message'),
  ...CitationBase,
  messageId: MessageId,
  channelId: ChannelId,
  /** The team of the channel (null for a direct message): the team whose address the link carries, which is not always the reader's current page's. */
  teamId: TeamId.nullable().default(null),
  /** Where it lives, so a client can open it without asking: a public channel's name, or what the place is (a direct message, a conversation). */
  channelKind: ChannelKind,
  channelName: z.string().max(80).nullable(),
  /** Set when the message is a reply: the thread it is in. */
  threadRootId: MessageId.nullable(),
});
export const AnswerThreadCitation = z.object({
  kind: z.literal('thread'),
  ...CitationBase,
  threadRootId: MessageId,
  channelId: ChannelId,
  /** The team of the channel (null for a direct message), as on a message citation. */
  teamId: TeamId.nullable().default(null),
  channelKind: ChannelKind,
  channelName: z.string().max(80).nullable(),
});
export const AnswerPageCitation = z.object({
  kind: z.literal('page'),
  ...CitationBase,
  teamId: TeamId,
  path: z.string().min(1).max(1024),
});
export const AnswerFileCitation = z.object({
  kind: z.literal('file'),
  ...CitationBase,
  fileId: FileId,
});
export const AnswerRunCitation = z.object({
  kind: z.literal('run'),
  ...CitationBase,
  runId: RunId,
  botId: BotId,
  /** The bot's slug, for the link to its page; null when the bot is gone. */
  botSlug: z.string().max(63).nullable(),
});

/** A citation the platform checked: every member names the source and carries the label and the reach the asker's view gave it. */
export const AnswerCitation = z.discriminatedUnion('kind', [
  AnswerMessageCitation,
  AnswerThreadCitation,
  AnswerPageCitation,
  AnswerFileCitation,
  AnswerRunCitation,
]);
export type AnswerCitation = z.infer<typeof AnswerCitation>;

/** A kind this version does not know: kept so the message still renders, shown as a neutral "unsupported source". */
export const AnswerUnsupportedCitation = z.looseObject({
  kind: z.string().refine((k) => !(ANSWER_CITATION_KINDS as readonly string[]).includes(k), 'a known kind has its own shape'),
  n: z.number().int().min(1).max(ANSWER_LIMITS.citations),
});
export type AnswerUnsupportedCitation = z.infer<typeof AnswerUnsupportedCitation>;

/** One step of the chain the answer was built from: the cited source, how old it is, and the words the bot quoted from it. */
export const AnswerLineageEntry = z.object({
  /** The citation this entry explains. */
  n: z.number().int().min(1).max(ANSWER_LIMITS.citations),
  kind: SourceKind,
  label: Label,
  /** When the source was written (a message's time, a file's upload, the page's last commit); null when the platform cannot tell. */
  at: IsoDateTime.nullable(),
  snippet: Snippet.nullable(),
});
export type AnswerLineageEntry = z.infer<typeof AnswerLineageEntry>;

/** Something the run read, from its source log: `full` through the team's own access, `scoped` through the asker's own connection. */
export const AnswerSourceReached = z.object({
  kind: SourceKind,
  ref: z.string().max(200),
  label: Label.nullable(),
  marker: z.enum(['full', 'scoped']),
});
export type AnswerSourceReached = z.infer<typeof AnswerSourceReached>;

/**
 * Why a source is not in the answer. `not_visible`: the asker cannot read it (or it is gone). `not_granted`: the bot told us it was not given
 * access. `not_shared`: the asker can read it, but the people who will read this reply cannot (a private source cited into a channel).
 * `not_reached`: the bot cited something its run did not read (the run's source log does not have it): it is neither looked up nor shown, so a
 * citation is no way to ask whether an id exists.
 */
export const AnswerOutsideReason = z.enum(['not_visible', 'not_granted', 'not_shared', 'not_reached']);
export type AnswerOutsideReason = z.infer<typeof AnswerOutsideReason>;

/** What was out of scope: how many, of which kind and why — never a title, a snippet or an id. */
export const AnswerOutsideScope = z.object({
  count: z.number().int().nonnegative(),
  items: z
    .array(z.object({ kind: SourceKind, reason: AnswerOutsideReason, count: z.number().int().min(1) }))
    .max(ANSWER_LIMITS.outside * 3),
});
export type AnswerOutsideScope = z.infer<typeof AnswerOutsideScope>;

/** Whom the answer was for. Stamped by the platform from the run — the bot has no say. */
export const AnswerAnsweredFor = z.object({
  /** The asking person; null for a run nobody asked (a routine, a webhook): such an answer reads as the team's. */
  personId: PersonId.nullable(),
  name: z.string().max(200).nullable(),
  /** `scoped`: every read ran with the asker's own visibility. `team`: no asker, so no wider view than the team's own. */
  scope: z.enum(['scoped', 'team']),
  /** The model alias the bot runs on (`smart`), as its definition names it. */
  alias: z.string().max(ANSWER_LIMITS.alias).nullable(),
  botId: BotId,
  runId: RunId,
});
export type AnswerAnsweredFor = z.infer<typeof AnswerAnsweredFor>;

/** A suggested next step. Only the data: what a chip does when it is chosen is the conversation view's (P5-17). */
export const AnswerChip = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('followup'), label: z.string().min(1).max(120), prompt: z.string().min(1).max(ANSWER_LIMITS.prompt) }),
  z.object({ kind: z.literal('handoff'), botId: BotId, botSlug: z.string().min(1).max(63), botName: z.string().min(1).max(120) }),
]);
export type AnswerChip = z.infer<typeof AnswerChip>;

/** The Answer, as stored on the message (`meta.answer`) and drawn by the `Answer` component. */
export const AnswerPayload = z.object({
  /** The shape's own version: a reader that sees a number it does not know shows the message text alone. */
  version: z.literal(1),
  body: z.string().min(1).max(ANSWER_LIMITS.body),
  citations: z.array(AnswerCitation).max(ANSWER_LIMITS.citations),
  lineage: z.array(AnswerLineageEntry).max(ANSWER_LIMITS.citations),
  sourcesReached: z.array(AnswerSourceReached).max(ANSWER_LIMITS.sources),
  outsideScope: AnswerOutsideScope,
  answeredFor: AnswerAnsweredFor,
  chips: z.array(AnswerChip).max(ANSWER_LIMITS.chips),
});
export type AnswerPayload = z.infer<typeof AnswerPayload>;

/**
 * The shape clients parse (`Message.meta.answer`): the same payload, but a citation of a kind this version does not know is read as
 * `AnswerUnsupportedCitation` rather than failing the message. A newer server may write kinds an older client has never seen.
 */
export const AnswerPayloadView = AnswerPayload.extend({
  citations: z.array(z.union([AnswerCitation, AnswerUnsupportedCitation])).max(ANSWER_LIMITS.citations),
});
export type AnswerPayloadView = z.infer<typeof AnswerPayloadView>;

/** True for a citation this version knows how to draw and open. */
export function isSupportedCitation(c: AnswerCitation | AnswerUnsupportedCitation): c is AnswerCitation {
  return (ANSWER_CITATION_KINDS as readonly string[]).includes(c.kind);
}

import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId, MessageId } from '../../ids.ts';
import { BotSlug } from '../bots/pairing.ts';
import { TeamSlug } from '../teams/common.ts';

// The bot page's Test action (PLAN P7-11, SPEC §9 Rehearse). A team lead or workspace admin asks one question of a bot that already exists, in their
// own conversation with it, and reads the answer there; every write the bot tries on the way is held back at the broker (the one place a tool
// call is judged) and listed as "not done — rehearsal". The caller never says a run is a rehearsal: this route is the only thing that makes one.

/** The longest question a test takes. A test is one question, not a document. */
export const BOT_TEST_QUESTION_MAX = 2000;

export const BotTestPathParams = z.object({ slug: TeamSlug, botSlug: BotSlug });
export type BotTestPathParams = z.infer<typeof BotTestPathParams>;

export const BotTestResultPathParams = z.object({ slug: TeamSlug, botSlug: BotSlug, messageId: MessageId });
export type BotTestResultPathParams = z.infer<typeof BotTestResultPathParams>;

/** The question, as typed. The server trims it; nothing else can be sent (no flag, no channel, no asker). */
export const BotTestRequest = z.strictObject({ question: z.string().trim().min(1).max(BOT_TEST_QUESTION_MAX) });
export type BotTestRequest = z.infer<typeof BotTestRequest>;

/** The question was posted into the caller's own conversation with the bot; the answer will be a reply in that thread. */
export const BotTestStarted = z.object({
  botName: z.string(),
  channelId: ChannelId,
  /** The question's message: the thread the bot answers in, and the key of the result. */
  messageId: MessageId,
});
export type BotTestStarted = z.infer<typeof BotTestStarted>;
export const botTestRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/test' } as const;

/**
 * Where the test stands. `waiting`: the bot has not finished (it may not have started). `answered`: the run ended and the thread holds the bot's reply.
 * `stopped`: the run ended without a reply on purpose (held for a person, refused at a check, or a definition a rehearsal cannot hold back). `failed`: the run broke.
 */
export const BotTestStatus = z.enum(['waiting', 'answered', 'stopped', 'failed']);
export type BotTestStatus = z.infer<typeof BotTestStatus>;

/**
 * One write the bot tried and the broker held back. `capability` is the tool's name (`messages.post`); `target` is the path, channel or card the call
 * named when it named one (never the text it would have written); `wouldWait` is true when a real call would have waited in the Approvals inbox.
 */
export const RehearsalIntercept = z.object({
  seq: z.number().int().nonnegative(),
  capability: z.string().min(1).max(100),
  target: z.string().max(300).nullable(),
  wouldWait: z.boolean(),
  at: IsoDateTime,
});
export type RehearsalIntercept = z.infer<typeof RehearsalIntercept>;

/**
 * What the answer rested on, said in the result so the page never has to guess: `none` (no knowledge base of this team holds a readable document for this
 * bot, so it answers from what it has), `not_used` (a base exists but the run did not search it), `used` (the run read at least one passage).
 */
export const BotTestKnowledge = z.enum(['none', 'not_used', 'used']);
export type BotTestKnowledge = z.infer<typeof BotTestKnowledge>;

/** The most intercepted writes a result lists; a run that tries more is cut here and the page says so with `interceptedMore`. */
export const BOT_TEST_INTERCEPTS_MAX = 50;

export const BotTestResult = z.object({
  messageId: MessageId,
  channelId: ChannelId,
  status: BotTestStatus,
  intercepted: z.array(RehearsalIntercept).max(BOT_TEST_INTERCEPTS_MAX),
  /** True when the run tried more writes than the list shows. */
  interceptedMore: z.boolean(),
  knowledge: BotTestKnowledge,
});
export type BotTestResult = z.infer<typeof BotTestResult>;
export const botTestResultRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/test/:messageId' } as const;

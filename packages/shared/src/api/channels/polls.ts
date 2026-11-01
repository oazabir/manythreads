import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { PollOptionList, PollQuestion, PollVoter, POLL_MAX_OPTIONS, PollView } from '../../entities/poll.ts';
import { ChannelId, MessageId, PollId } from '../../ids.ts';
import { ChannelMessage } from './common.ts';

// Polls (PLAN P14-07, plugin `channels`; docs/plugins/channels.md). A poll is a message of a channel; people who can read the channel vote, the author
// closes it early or it closes at its time, and the result is posted as a plain message. A bot may read a poll and its result but may not vote.

export const PollPathParams = z.object({ channelId: ChannelId, pollId: PollId });
export type PollPathParams = z.infer<typeof PollPathParams>;

export const PollChannelPathParams = z.object({ channelId: ChannelId });
export type PollChannelPathParams = z.infer<typeof PollChannelPathParams>;

/**
 * Create a poll as a new message of the channel (or a reply in a thread). `closesAt` is an exact moment (the browser works out "in 2 hours"), or
 * absent for a poll that stays open until its author closes it. One vote per person unless `multiple`; `anonymous` hides who voted for what from everyone.
 */
export const CreatePollRequest = z.strictObject({
  question: PollQuestion,
  options: PollOptionList,
  multiple: z.boolean().default(false),
  anonymous: z.boolean().default(false),
  closesAt: IsoDateTime.nullish(),
  threadRootId: MessageId.nullish(),
});
export type CreatePollRequest = z.input<typeof CreatePollRequest>;
export const createPollRoute = { method: 'POST', path: '/api/channels/:channelId/polls' } as const;
/** The new poll message, with its poll (`poll`). */
export const CreatePollResponse = ChannelMessage;
export type CreatePollResponse = z.infer<typeof CreatePollResponse>;

/**
 * Cast or change a vote: the options chosen (numbers into the poll's list, each once). It replaces any earlier vote of the caller; a single-choice
 * poll takes exactly one. Withdrawing is `DELETE` on the same path. Answers the poll as the caller sees it.
 */
export const VotePollRequest = z.strictObject({
  options: z
    .array(z.number().int().min(0).max(POLL_MAX_OPTIONS - 1))
    .min(1, 'Choose an option')
    .max(POLL_MAX_OPTIONS)
    .refine((list) => new Set(list).size === list.length, { message: 'An option can be chosen once' }),
});
export type VotePollRequest = z.infer<typeof VotePollRequest>;
export const votePollRoute = { method: 'PUT', path: '/api/channels/:channelId/polls/:pollId/vote' } as const;
export const withdrawVoteRoute = { method: 'DELETE', path: '/api/channels/:channelId/polls/:pollId/vote' } as const;
export const VotePollResponse = z.object({ poll: PollView });
export type VotePollResponse = z.infer<typeof VotePollResponse>;

/** The author closes a poll early. Closing a closed poll changes nothing. */
export const closePollRoute = { method: 'POST', path: '/api/channels/:channelId/polls/:pollId/close' } as const;
export const ClosePollResponse = z.object({ poll: PollView });
export type ClosePollResponse = z.infer<typeof ClosePollResponse>;

/**
 * The poll with its results. `voters` lists who voted for what in a **named** poll; it is null for an anonymous poll, whoever asks (the author and
 * a workspace admin included): nothing in the system can tell who voted for what in one.
 */
export const PollResultsResponse = z.object({ poll: PollView, voters: z.array(PollVoter).nullable() });
export type PollResultsResponse = z.infer<typeof PollResultsResponse>;
export const pollResultsRoute = { method: 'GET', path: '/api/channels/:channelId/polls/:pollId' } as const;

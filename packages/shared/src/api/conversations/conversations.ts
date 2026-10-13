import { z } from 'zod';
import { Page } from '../../common/page.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ConversationVisibility } from '../../entities/conversation.ts';
import { BotId, ChannelId, MessageId, PersonId } from '../../ids.ts';
import { BotSlug } from '../bots/pairing.ts';
import { TeamSlug } from '../teams/common.ts';

// Talking to a bot (SPEC §6.2, PLAN P5-16). The view is a list of the bot's conversations with the caller (Mine · Shared · Channel
// mentions) and a thread. Reading a thread and sending into it are the ordinary channel and thread routes; what is here is the part that is
// the plugin's own: opening the caller's conversation channel with a bot (which also says what to suggest) and the three lists.

/** What the chips show when the definition names none (`conversation.prompts` of BOT.md is optional). */
export const DEFAULT_CONVERSATION_PROMPTS: readonly string[] = [
  'What can you help me with?',
  'Summarise what changed this week',
  "What's blocked right now?",
];

export const ConversationPathParams = z.object({ slug: TeamSlug, botSlug: BotSlug });
export type ConversationPathParams = z.infer<typeof ConversationPathParams>;

/** Where the chips came from: the bot's own `conversation.prompts`, or the platform's defaults. */
export const ConversationPromptSource = z.enum(['definition', 'default']);
export type ConversationPromptSource = z.infer<typeof ConversationPromptSource>;

/**
 * The caller's conversation channel with this bot, made on first use (one channel per bot and person: private to that person, the bot answers
 * in it). Opening twice gives the same channel. The caller must sit on the bot's team and the bot must be active.
 */
export const OpenConversationResponse = z.object({
  botId: BotId,
  botName: z.string(),
  botRole: z.string(),
  /** The channel to post the first message into; `POST /api/channels/:id/messages` starts the conversation. */
  channelId: ChannelId,
  created: z.boolean(),
  /** At most six example questions. */
  prompts: z.array(z.string().min(1).max(200)).max(6),
  promptSource: ConversationPromptSource,
});
export type OpenConversationResponse = z.infer<typeof OpenConversationResponse>;
export const openConversationRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/conversation' } as const;

/** `mine`: the caller's own conversations with the bot. `shared`: the ones shared with the team. `mentions`: threads where the caller named the bot in a channel. */
export const ConversationScope = z.enum(['mine', 'shared', 'mentions']);
export type ConversationScope = z.infer<typeof ConversationScope>;

export const ListConversationsQuery = z.object({
  scope: ConversationScope.default('mine'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(256).optional(),
});
export type ListConversationsQuery = z.infer<typeof ListConversationsQuery>;

export const ConversationItemSource = z.enum(['conversation', 'mention']);
export type ConversationItemSource = z.infer<typeof ConversationItemSource>;

/**
 * One row of a list. `title` is the first words of the first message and `preview` the newest message of the thread, both read with the caller's
 * own visibility: for somebody else's shared conversation they come from the copy shared into a channel the caller can read, and are empty
 * when there is none (nothing of the private thread is ever copied onto an index row).
 */
export const ConversationListItem = z.object({
  /** The thread's root message. */
  threadRootId: MessageId,
  /** Where the thread lives: the bot conversation channel, or for a mention the channel the bot was named in. */
  channelId: ChannelId,
  source: ConversationItemSource,
  /** The `#name` of the channel for a mention; null for a conversation channel (it has no name). */
  channelName: z.string().nullable(),
  /** Who asked. */
  personId: PersonId,
  /** The caller asked it. */
  mine: z.boolean(),
  /** Null for a mention: that thread is in a channel and is as visible as the channel is. */
  visibility: ConversationVisibility.nullable(),
  title: z.string(),
  preview: z.string(),
  /** Who wrote the newest message; null for a thread nobody has answered yet and a message the caller cannot read. */
  lastAuthor: z.enum(['person', 'bot']).nullable(),
  lastActivityAt: IsoDateTime,
  replyCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  /** Where a shared conversation was posted for the team, when the caller can read that channel (P5-17 fills it). */
  sharedTo: z.object({ channelId: ChannelId, name: z.string().nullable(), rootId: MessageId.nullable() }).nullable(),
});
export type ConversationListItem = z.infer<typeof ConversationListItem>;

export const ListConversationsResponse = Page(ConversationListItem);
export type ListConversationsResponse = z.infer<typeof ListConversationsResponse>;
export const listConversationsRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/conversations' } as const;

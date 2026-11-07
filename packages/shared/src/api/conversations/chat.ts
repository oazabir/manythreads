import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { Message } from '../../entities/message.ts';
import { BotId, ChannelId, MessageId, RunId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';
import { BotSlug } from '../bots/pairing.ts';
import { TeamSlug } from '../teams/common.ts';

// The Chat screen (PLAN P20-16): a full chat with a bot, Brain by default, over the conversations of P5-16. Everything here is the part the
// conversation routes did not have: naming, pinning and deleting a conversation, regenerating an answer (the earlier ones are kept as
// variants), feedback, the model a person picks for a conversation, sending with that pick, and the live frames of a streamed answer.
// Reading a thread is still the channel and thread routes; the list is `listConversationsRoute` with `q`.

export const ChatPathParams = z.object({ slug: TeamSlug, botSlug: BotSlug });
export type ChatPathParams = z.infer<typeof ChatPathParams>;
export const ChatThreadPathParams = ChatPathParams.extend({ threadRootId: MessageId });
export type ChatThreadPathParams = z.infer<typeof ChatThreadPathParams>;
export const ChatTurnPathParams = ChatThreadPathParams.extend({ turnMessageId: MessageId });
export type ChatTurnPathParams = z.infer<typeof ChatTurnPathParams>;
export const ChatFeedbackPathParams = ChatPathParams.extend({ messageId: MessageId });
export type ChatFeedbackPathParams = z.infer<typeof ChatFeedbackPathParams>;

/** The longest title a person may give a conversation. */
export const CHAT_TITLE_MAX = 80;
/** How long a deleted conversation can be brought back, in seconds. */
export const CHAT_UNDO_SECONDS = 30;
/** The longest reason a person may add to a thumbs up or down. */
export const CHAT_FEEDBACK_REASON_MAX = 140;

// ---- the model menu ------------------------------------------------------------------------------------------------------------

/** Why a model in the menu is greyed: it has no model behind it yet, or the workspace has paused it. */
export const ChatModelUnavailable = z.enum(['unbound', 'paused']);
export type ChatModelUnavailable = z.infer<typeof ChatModelUnavailable>;

export const ChatModelOption = z.object({
  /** The alias the message carries (`smart`, `fast`). */
  alias: z.string().min(1).max(40),
  /** Plain words (Smart, Fast); never a model or provider name. */
  label: z.string().min(1).max(40),
  /** One line, such as "slower, more careful". */
  hint: z.string().max(120),
  available: z.boolean(),
  /** One plain sentence when `available` is false. */
  reason: z.string().max(200).nullable(),
  /** The first alias of the bot's definition: used when a message carries none. */
  isDefault: z.boolean(),
});
export type ChatModelOption = z.infer<typeof ChatModelOption>;

/** The aliases the bot's definition lists (`model.aliases`), in order, each marked with whether the workspace has a model behind it. */
export const ChatModelsResponse = z.object({ models: z.array(ChatModelOption).max(8) });
export type ChatModelsResponse = z.infer<typeof ChatModelsResponse>;
export const chatModelsRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/conversations/models' } as const satisfies ApiRoute;

// ---- sending ---------------------------------------------------------------------------------------------------------------------

/**
 * One message into the caller's conversation with the bot: `threadRootId` null starts a new conversation (this message is its root), else it
 * continues that one. `modelAlias` is the pick for this turn; the server checks it against the bot's list and refuses any other (422).
 * Files are the ones already uploaded to the conversation channel (`POST /api/channels/:channelId/files`).
 */
export const ChatSendRequest = z
  .strictObject({
    body: Message.shape.body,
    threadRootId: MessageId.nullable(),
    attachments: Message.shape.meta.shape.attachments,
    modelAlias: z.string().min(1).max(40).optional(),
  });
export type ChatSendRequest = z.infer<typeof ChatSendRequest>;
/** The new message's id: the message itself reaches the screen on the live feed like every message. */
export const ChatSendResponse = z.object({ messageId: MessageId, channelId: ChannelId, createdAt: IsoDateTime });
export type ChatSendResponse = z.infer<typeof ChatSendResponse>;
export const chatSendRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/conversations/send' } as const satisfies ApiRoute;

// ---- one conversation's state ----------------------------------------------------------------------------------------------------

export const ChatVariant = z.object({
  /** The bot's answer. */
  messageId: MessageId,
  /** 1 for the first answer to the turn, 2 for the next, and so on. */
  variantNo: z.number().int().min(1),
  /** The one later turns continue from; the screen shows only this one until the person switches. */
  chosen: z.boolean(),
  /** The alias that answered, when the run recorded one. */
  modelAlias: z.string().nullable(),
  /** The person pressed Stop: the answer is what had been written so far. */
  stopped: z.boolean(),
  runId: RunId.nullable(),
});
export type ChatVariant = z.infer<typeof ChatVariant>;

export const ChatTurn = z.object({
  /** The person's message this turn answers. */
  turnMessageId: MessageId,
  variants: z.array(ChatVariant).min(1),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

export const ChatVote = z.enum(['up', 'down']);
export type ChatVote = z.infer<typeof ChatVote>;

export const ChatThreadState = z.object({
  threadRootId: MessageId,
  channelId: ChannelId,
  botId: BotId,
  title: z.string(),
  pinned: z.boolean(),
  modelAlias: z.string().nullable(),
  turns: z.array(ChatTurn),
  /** The caller's own thumbs, by the answer's message id. Nobody else sees them. */
  feedback: z.array(z.object({ messageId: MessageId, vote: ChatVote, reason: z.string().max(CHAT_FEEDBACK_REASON_MAX) })),
  /** The run that is answering right now, so a screen that was closed and opened again can show Stop and the live frames. */
  liveRunId: RunId.nullable(),
});
export type ChatThreadState = z.infer<typeof ChatThreadState>;
export const chatThreadStateRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/conversations/:threadRootId/state' } as const satisfies ApiRoute;

// ---- naming, pinning, deleting ---------------------------------------------------------------------------------------------------

/** Rename and pin are one patch; at least one field. A title is trimmed and never empty. */
export const ChatPatchRequest = z
  .strictObject({
    title: z.string().trim().min(1, 'Give it a name.').max(CHAT_TITLE_MAX, `A name can be up to ${String(CHAT_TITLE_MAX)} characters.`).optional(),
    pinned: z.boolean().optional(),
    modelAlias: z.string().min(1).max(40).optional(),
  })
  .refine((v) => v.title !== undefined || v.pinned !== undefined || v.modelAlias !== undefined, { message: 'Nothing to change.' });
export type ChatPatchRequest = z.infer<typeof ChatPatchRequest>;
export const ChatPatchResponse = z.object({ title: z.string(), titleSource: z.enum(['auto', 'manual']).nullable(), pinned: z.boolean(), modelAlias: z.string().nullable() });
export type ChatPatchResponse = z.infer<typeof ChatPatchResponse>;
export const chatPatchRoute = { method: 'PATCH', path: '/api/teams/:slug/bots/:botSlug/conversations/:threadRootId' } as const satisfies ApiRoute;

/** A deleted conversation can be restored until `undoUntil`; after that it is in no list. */
export const ChatDeleteResponse = z.object({ ok: z.literal(true), undoUntil: IsoDateTime });
export type ChatDeleteResponse = z.infer<typeof ChatDeleteResponse>;
export const chatDeleteRoute = { method: 'DELETE', path: '/api/teams/:slug/bots/:botSlug/conversations/:threadRootId' } as const satisfies ApiRoute;
export const ChatRestoreResponse = z.object({ ok: z.literal(true) });
export type ChatRestoreResponse = z.infer<typeof ChatRestoreResponse>;
export const chatRestoreRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/conversations/:threadRootId/restore' } as const satisfies ApiRoute;

// ---- variants --------------------------------------------------------------------------------------------------------------------

/** Ask for another answer to the same turn (also how an edited last message is resent). The earlier answers stay as variants. */
export const ChatRegenerateRequest = z.strictObject({ modelAlias: z.string().min(1).max(40).optional() });
export type ChatRegenerateRequest = z.infer<typeof ChatRegenerateRequest>;
export const ChatRegenerateResponse = z.object({ ok: z.literal(true) });
export type ChatRegenerateResponse = z.infer<typeof ChatRegenerateResponse>;
export const chatRegenerateRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/conversations/:threadRootId/turns/:turnMessageId/regenerate' } as const satisfies ApiRoute;

/** Switch which answer of a turn is the one shown and continued from (the ‹ 2 / 3 › control). */
export const ChatChooseVariantRequest = z.strictObject({ messageId: MessageId });
export type ChatChooseVariantRequest = z.infer<typeof ChatChooseVariantRequest>;
export const chatChooseVariantRoute = { method: 'PUT', path: '/api/teams/:slug/bots/:botSlug/conversations/:threadRootId/turns/:turnMessageId/variant' } as const satisfies ApiRoute;

// ---- feedback --------------------------------------------------------------------------------------------------------------------

/** A thumb on one answer, with an optional one-line reason. `vote: null` takes the thumb back. Read by the eval harness, never shown to others. */
export const ChatFeedbackRequest = z.strictObject({
  vote: ChatVote.nullable(),
  reason: z.string().trim().max(CHAT_FEEDBACK_REASON_MAX, `A reason can be up to ${String(CHAT_FEEDBACK_REASON_MAX)} characters.`).optional(),
});
export type ChatFeedbackRequest = z.infer<typeof ChatFeedbackRequest>;
export const ChatFeedbackResponse = z.object({ messageId: MessageId, vote: ChatVote.nullable(), reason: z.string() });
export type ChatFeedbackResponse = z.infer<typeof ChatFeedbackResponse>;
export const chatFeedbackRoute = { method: 'PUT', path: '/api/teams/:slug/bots/:botSlug/conversations/messages/:messageId/feedback' } as const satisfies ApiRoute;

// ---- Stop and the live frames ----------------------------------------------------------------------------------------------------

export const RunStopPathParams = z.object({ runId: RunId });
export type RunStopPathParams = z.infer<typeof RunStopPathParams>;
/** `stopped` is false when the run had already ended (nothing to stop) or this server is not the one running it. */
export const RunStopResponse = z.object({ stopped: z.boolean() });
export type RunStopResponse = z.infer<typeof RunStopResponse>;
/** Only the person who asked can stop a run; anybody else gets 404. */
export const stopRunRoute = { method: 'POST', path: '/api/runs/:runId/stop' } as const satisfies ApiRoute;

// Live frames (WebSocket envelope `{ type, id, payload }`, pushed to the asker only; ephemeral, never in the event log). The final answer is
// the message the run posts; a screen that misses a frame loses a word of the preview, never the answer.
export const WS_RUN_DELTA = 'run.delta';
export const WS_RUN_LOOKING = 'run.looking';
export const WS_RUN_ENDED = 'run.ended';

/** A piece of the answer so far. `offset` is how many characters came before it, so a screen can drop a repeat and notice a gap. */
export const RunDeltaPush = z.object({ runId: RunId, channelId: ChannelId, threadRootId: MessageId, offset: z.number().int().nonnegative(), text: z.string() });
export type RunDeltaPush = z.infer<typeof RunDeltaPush>;
/** What the bot is reading right now ("Searching memory", "3 knowledge hits"): fixed words and counts, never a document's text. */
export const RunLookingPush = z.object({ runId: RunId, channelId: ChannelId, threadRootId: MessageId, label: z.string().max(80), tool: z.string().max(80) });
export type RunLookingPush = z.infer<typeof RunLookingPush>;
export const RunEndedPush = z.object({ runId: RunId, channelId: ChannelId, threadRootId: MessageId, status: z.enum(['done', 'failed', 'stopped']) });
export type RunEndedPush = z.infer<typeof RunEndedPush>;

import {
  ChatChooseVariantRequest,
  ChatDeleteResponse,
  ChatFeedbackRequest,
  ChatFeedbackResponse,
  ChatModelsResponse,
  ChatPatchRequest,
  ChatPatchResponse,
  ChatRegenerateRequest,
  ChatRegenerateResponse,
  ChatRestoreResponse,
  ChatSendRequest,
  ChatSendResponse,
  ChatThreadState,
  ListConversationsQuery,
  ListConversationsResponse,
  RunStopResponse,
  chatChooseVariantRoute,
  chatDeleteRoute,
  chatFeedbackRoute,
  chatModelsRoute,
  chatPatchRoute,
  chatRegenerateRoute,
  chatRestoreRoute,
  chatSendRoute,
  chatThreadStateRoute,
  listConversationsRoute,
  stopRunRoute,
  type ChatVote,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the Chat screen asks of the server (PLAN P20-16). A conversation is addressed by the team, the bot and the thread's first message. Reading
 * the messages themselves is the thread timeline the rest of the app uses; these are the parts that are the chat's own.
 */

type Who = { team: string; bot: string };
type One = Who & { root: string };

export const fetchChatModels = ({ team, bot }: Who) => call(chatModelsRoute, { response: ChatModelsResponse }, undefined, { slug: team, botSlug: bot });

export const sendChat = ({ team, bot }: Who, body: ChatSendRequest) =>
  call(chatSendRoute, { request: ChatSendRequest, response: ChatSendResponse }, ChatSendRequest.parse(body), { slug: team, botSlug: bot });

export const fetchChatState = ({ team, bot, root }: One) =>
  call(chatThreadStateRoute, { response: ChatThreadState }, undefined, { slug: team, botSlug: bot, threadRootId: root });

export const patchChat = ({ team, bot, root }: One, body: ChatPatchRequest) =>
  call(chatPatchRoute, { request: ChatPatchRequest, response: ChatPatchResponse }, ChatPatchRequest.parse(body), { slug: team, botSlug: bot, threadRootId: root });

export const deleteChat = ({ team, bot, root }: One) => call(chatDeleteRoute, { response: ChatDeleteResponse }, undefined, { slug: team, botSlug: bot, threadRootId: root });

export const restoreChat = ({ team, bot, root }: One) =>
  call(chatRestoreRoute, { response: ChatRestoreResponse }, undefined, { slug: team, botSlug: bot, threadRootId: root });

export const regenerateTurn = ({ team, bot, root }: One, turn: string, body: ChatRegenerateRequest = {}) =>
  call(chatRegenerateRoute, { request: ChatRegenerateRequest, response: ChatRegenerateResponse }, ChatRegenerateRequest.parse(body), {
    slug: team,
    botSlug: bot,
    threadRootId: root,
    turnMessageId: turn,
  });

export const chooseVariant = ({ team, bot, root }: One, turn: string, messageId: string) =>
  call(chatChooseVariantRoute, { request: ChatChooseVariantRequest, response: ChatRegenerateResponse }, ChatChooseVariantRequest.parse({ messageId }), {
    slug: team,
    botSlug: bot,
    threadRootId: root,
    turnMessageId: turn,
  });

export const giveFeedback = ({ team, bot }: Who, messageId: string, vote: ChatVote | null, reason: string) =>
  call(chatFeedbackRoute, { request: ChatFeedbackRequest, response: ChatFeedbackResponse }, ChatFeedbackRequest.parse({ vote, reason }), {
    slug: team,
    botSlug: bot,
    messageId,
  });

export const stopRun = (runId: string) => call(stopRunRoute, { response: RunStopResponse }, undefined, { runId });

/** The caller's own conversations with a bot, newest first; `q` searches the titles and the words. */
export const listChats = ({ team, bot }: Who, query: { q?: string; pinned?: 'only' | 'without'; cursor?: string }) =>
  call(
    listConversationsRoute,
    { request: ListConversationsQuery, response: ListConversationsResponse },
    ListConversationsQuery.parse({ scope: 'mine', limit: 50, ...query }),
    { slug: team, botSlug: bot },
  );

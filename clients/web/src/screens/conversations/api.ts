import {
  AnswerPreviewRequest,
  AnswerSharePreview,
  AnswerShareTargetsResponse,
  HandoffAnswerRequest,
  HandoffAnswerResponse,
  ListConversationsQuery,
  ListConversationsResponse,
  OpenConversationResponse,
  SaveAnswerPageRequest,
  SaveAnswerPageResponse,
  ShareAnswerRequest,
  ShareAnswerResponse,
  answerSharePreviewRoute,
  answerShareTargetsRoute,
  handoffAnswerRoute,
  listConversationsRoute,
  openConversationRoute,
  saveAnswerPageRoute,
  shareAnswerRoute,
  type ConversationScope,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the conversation view asks of the server (PLAN P5-16): open the person's channel with a bot (made on first use; it also says what to
 * suggest) and the three lists. Reading a thread and sending into it are the channel and thread routes the rest of the app already uses.
 */

export const openConversation = (slug: string, botSlug: string) =>
  call(openConversationRoute, { response: OpenConversationResponse }, undefined, { slug, botSlug });

export const fetchConversations = (slug: string, botSlug: string, scope: ConversationScope, cursor?: string) =>
  call(
    listConversationsRoute,
    { request: ListConversationsQuery, response: ListConversationsResponse },
    ListConversationsQuery.parse({ scope, ...(cursor ? { cursor } : {}) }),
    { slug, botSlug },
  );

// ---- what a person does with an answer of their own conversation (PLAN P5-17) --------------------------------------------------------------
// Every call is addressed by the answer's own message in the person's conversation channel. A request carries the numbers of the claims to
// remove and never any text; the preview answers with the copy exactly as it would be posted and a digest, which share and save take back.

type AnswerAddress = { channelId: string; messageId: string };

export const fetchShareTargets = (a: AnswerAddress) =>
  call(answerShareTargetsRoute, { response: AnswerShareTargetsResponse }, undefined, { channelId: a.channelId, messageId: a.messageId });

export const previewAnswerShare = (a: AnswerAddress, target: { kind: 'channel'; channelId: string } | { kind: 'page' }, remove: readonly number[]) =>
  call(
    answerSharePreviewRoute,
    { request: AnswerPreviewRequest, response: AnswerSharePreview },
    AnswerPreviewRequest.parse({ target, remove: [...remove] }),
    { channelId: a.channelId, messageId: a.messageId },
  );

export const shareAnswer = (a: AnswerAddress, targetChannelId: string, remove: readonly number[], digest: string) =>
  call(
    shareAnswerRoute,
    { request: ShareAnswerRequest, response: ShareAnswerResponse },
    ShareAnswerRequest.parse({ targetChannelId, remove: [...remove], digest }),
    { channelId: a.channelId, messageId: a.messageId },
  );

export const saveAnswerAsPage = (a: AnswerAddress, remove: readonly number[], digest: string) =>
  call(
    saveAnswerPageRoute,
    { request: SaveAnswerPageRequest, response: SaveAnswerPageResponse },
    SaveAnswerPageRequest.parse({ remove: [...remove], digest }),
    { channelId: a.channelId, messageId: a.messageId },
  );

export const handoffAnswer = (a: AnswerAddress, botId: string) =>
  call(
    handoffAnswerRoute,
    { request: HandoffAnswerRequest, response: HandoffAnswerResponse },
    HandoffAnswerRequest.parse({ botId }),
    { channelId: a.channelId, messageId: a.messageId },
  );

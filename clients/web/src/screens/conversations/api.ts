import {
  ListConversationsQuery,
  ListConversationsResponse,
  OpenConversationResponse,
  listConversationsRoute,
  openConversationRoute,
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

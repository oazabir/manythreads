import type { ChannelKind } from '@manythreads/shared';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { fetchChannel } from '../api/endpoints';
import { writePanel, type PanelEntry } from '../kernel/panel';
import { useShell } from './context';
import { channelPath } from './nav';
import { useNarrow } from './useNarrow';

/** A guest has no team in sight: any slug in the URL shows the channels they were granted, so the shell uses this one. */
export const GUEST_SLUG = 'shared';

/** Where a message lives, from a search hit or a notification. `teamId` is unknown for a notification (it is looked up). */
export type MessageTarget = {
  channelId: string;
  channelKind: ChannelKind;
  channelName: string | null;
  teamId?: string | null;
  messageId: string;
  /** Set when the message is a reply: the thread opens in the right panel. */
  threadRootId: string | null;
  /** Open the channel itself, at its latest messages (a notification that names no message, such as an invitation without its start message). */
  channelOnly?: boolean;
};

/** The reply a thread scrolls to and highlights when it opens (`?reply=<message id>`, read by `ThreadBody`). */
export const REPLY_PARAM = 'reply';

/** `land`: open at the message itself, scrolled to and highlighted inside its thread or chat (the Bookmarks page); off, a reply opens its thread. */
export type LandOptions = { land?: boolean };

export const dmPath = (slug: string, channelId: string): string => `/t/${slug}/dm/${channelId}`;
/** Where the person's meeting chats are listed (P37-07): the Chat page, under the chats with bots. (The Meetings page of P37-04 is gone; its old address lands here.) */
export const meetingsPath = (slug: string): string => `/t/${slug}/chat`;
/** A meeting space (P36-03): a conversation of its own, opened in the Chat page beside the list of chats, under the team in sight. (`/t/<team>/meetings/<id>` is a call's notes page.) */
export const meetingPath = (slug: string, channelId: string): string => `/t/${slug}/chat?meeting=${channelId}`;
/** The same address as a location, for a caller that adds its own search (a message to scroll to, a panel). */
const meetingLocation = (slug: string, channelId: string, search = ''): { pathname: string; search: string } => ({
  pathname: meetingsPath(slug),
  search: `?meeting=${channelId}${search.startsWith('?') && search.length > 1 ? `&${search.slice(1)}` : ''}`,
});

/**
 * The location of a message: its channel with `?message=<id>` (the channel view scrolls to it and flashes it), or for a reply its
 * root plus the thread in the right panel (with `land`, also `?reply=<id>`: the thread scrolls to the reply and highlights it). `under` is what stays in the panel below the thread (the search results, so Back returns).
 */
export function messageLocation(slug: string, t: MessageTarget, under: readonly PanelEntry[] = [], opts: LandOptions = {}): { pathname: string; search: string; state: unknown } {
  const target = t.threadRootId ?? t.messageId;
  if (t.channelOnly) {
    if (t.channelKind === 'bot_conversation') return { pathname: `/t/${slug}/chat/${t.channelId}`, search: '', state: null };
    if (t.channelKind === 'meeting') return { ...meetingLocation(slug, t.channelId), state: null };
    return { pathname: t.channelKind === 'dm' || !t.channelName ? dmPath(slug, t.channelId) : channelPath(slug, t.channelName), search: '', state: null };
  }
  // landing exactly (`land`, the Bookmarks page): a reply (not the thread's own first message) is scrolled to and highlighted in the thread (`?reply=`,
  // ThreadBody), a message of a chat with a bot in that chat (`&message=`); every other caller opens the thread as before
  const reply = opts.land === true && t.threadRootId !== null && t.messageId !== '' && t.messageId !== t.threadRootId ? t.messageId : null;
  // a conversation with a bot has no name to put in a URL: the conversation view finds the bot from the channel and opens the thread
  if (t.channelKind === 'bot_conversation') {
    const message = opts.land === true && t.threadRootId === null ? t.messageId : reply;
    return { pathname: `/t/${slug}/chat/${t.channelId}`, search: `?thread=${target}${message ? `&message=${message}` : ''}`, state: null };
  }
  const pathname = t.channelKind === 'dm' || !t.channelName ? dmPath(slug, t.channelId) : channelPath(slug, t.channelName);
  const stack = t.threadRootId ? [...under, { type: 'thread', id: t.threadRootId }] : [...under];
  const next = writePanel({ search: `?message=${target}${reply ? `&${REPLY_PARAM}=${reply}` : ''}`, state: null }, stack, false);
  // a meeting chat opens in the Chat page, with `?meeting=` ahead of the message and the panel
  if (t.channelKind === 'meeting') return { ...meetingLocation(slug, t.channelId, next.search), state: next.state };
  return { pathname, search: next.search, state: next.state };
}

/** Opens a message wherever it is: resolves the team of its channel, then navigates. Returns a function; it never throws. */
export function useOpenMessage(): (target: MessageTarget, under?: readonly PanelEntry[], opts?: LandOptions) => Promise<void> {
  const navigate = useNavigate();
  const { teams, team, teamSlug } = useShell();
  const narrow = useNarrow();
  return useCallback(
    async (target, under = [], opts = {}) => {
      const fallback = team?.slug ?? teamSlug ?? GUEST_SLUG;
      let slug = fallback;
      let teamId = target.teamId;
      if (teamId === undefined && target.channelKind === 'channel') {
        try {
          teamId = (await fetchChannel(target.channelId)).channel.teamId;
        } catch {
          teamId = null;
        }
      }
      if (teamId) slug = teams.find((t) => t.id === teamId)?.slug ?? fallback;
      const to = messageLocation(slug, target, narrow ? [] : under, opts);
      navigate({ pathname: to.pathname, search: to.search }, { state: to.state });
    },
    [navigate, teams, team, teamSlug, narrow],
  );
}

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
  channelKind: 'channel' | 'dm' | 'bot_conversation';
  channelName: string | null;
  teamId?: string | null;
  messageId: string;
  /** Set when the message is a reply: the thread opens in the right panel. */
  threadRootId: string | null;
};

export const dmPath = (slug: string, channelId: string): string => `/t/${slug}/dm/${channelId}`;

/**
 * The location of a message: its channel with `?message=<id>` (the channel view scrolls to it and flashes it), or for a reply its
 * root plus the thread in the right panel. `under` is what stays in the panel below the thread (the search results, so Back returns).
 */
export function messageLocation(slug: string, t: MessageTarget, under: readonly PanelEntry[] = []): { pathname: string; search: string; state: unknown } {
  const pathname = t.channelKind === 'dm' || !t.channelName ? dmPath(slug, t.channelId) : channelPath(slug, t.channelName);
  const target = t.threadRootId ?? t.messageId;
  const stack = t.threadRootId ? [...under, { type: 'thread', id: t.threadRootId }] : [...under];
  const next = writePanel({ search: `?message=${target}`, state: null }, stack, false);
  return { pathname, search: next.search, state: next.state };
}

/** Opens a message wherever it is: resolves the team of its channel, then navigates. Returns a function; it never throws. */
export function useOpenMessage(): (target: MessageTarget, under?: readonly PanelEntry[]) => Promise<void> {
  const navigate = useNavigate();
  const { teams, team, teamSlug } = useShell();
  const narrow = useNarrow();
  return useCallback(
    async (target, under = []) => {
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
      const to = messageLocation(slug, target, narrow ? [] : under);
      navigate({ pathname: to.pathname, search: to.search }, { state: to.state });
    },
    [navigate, teams, team, teamSlug, narrow],
  );
}

import { useCallback, useContext, useEffect, useMemo } from 'react';
import { useQuery } from '../app/useQuery';
import { isAdmin, useSession } from '../app/session';
import { fetchChannel } from '../api/endpoints';
import { fetchBots } from '../screens/bots/api';
import { useChannelFeed } from '../shell/channelFeed';
import { ShellContext } from '../shell/context';
import { handleFor, type People } from './hooks';
import { defaultEnv, type SlashEnv, type SlashWho, type SlashWhere } from './slash';
import { CHANNEL_CHANGED_EVENT } from './slashDeps';

/** Calls `reload` when a slash command changed this channel (its topic, or the person's place in it). */
export function useChannelChanged(channelId: string, reload: () => void): void {
  useEffect(() => {
    const on = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === channelId) reload();
    };
    window.addEventListener(CHANNEL_CHANGED_EVENT, on);
    return () => window.removeEventListener(CHANNEL_CHANGED_EVENT, on);
  }, [channelId, reload]);
}

type Loaded = { slug: string | null; bots: SlashWho['bots'] };
const NOT_LOADED: Loaded = { slug: null, bots: null };

/**
 * The facts `planSlash` needs about the signed-in person in the conversation's team. The team's bots are read only once a message starts with a slash
 * (`wanted`), so a composer nobody types a command in never asks. The conversation's own facts (whether the person is a member, whether they manage it)
 * are read as soon as the composer is on a conversation (`facts`, which defaults to `wanted`): the channel screen reads the same thing under the same
 * key, so it costs nothing, and `/invite`, `/leave` and `/topic` typed in the first second of a freshly opened channel are not told to wait. A guest has no
 * team routes and is never asked about bots.
 */
export function useSlashWho(teamSlug: string | null, channelId: string, wanted: boolean, selfName: string | null, facts: boolean = wanted): SlashWho {
  const shell = useContext(ShellContext);
  const session = useSession();
  const guest = shell?.guest ?? session.role === 'guest';
  const admin = isAdmin(session);
  const team = shell?.team && shell.team.slug === teamSlug ? shell.team : null;
  const ask = wanted && !guest && teamSlug !== null;
  const q = useQuery<Loaded>(ask ? `slash-bots:${teamSlug}` : 'slash-bots:off', () =>
    ask && teamSlug
      ? fetchBots(teamSlug).then((r) => ({ slug: teamSlug, bots: r.bots.filter((b) => b.status === 'active' && b.mentionable).map((b) => ({ slug: b.slug, name: b.name })) }))
      : Promise.resolve(NOT_LOADED),
  );
  // the same query (and key) the channel screen itself makes, so asking again costs nothing
  const info = useQuery(facts ? `channel:${channelId}` : 'slash-where:off', () => (facts ? fetchChannel(channelId) : Promise.resolve(null)));
  useChannelChanged(channelId, info.reload);
  // a previous answer is kept while another team's loads: use it only for the team it was read for
  const bots = q.status === 'ok' && q.data.slug === teamSlug ? q.data.bots : null;
  const detail = info.status === 'ok' ? info.data : null;
  const where = useMemo<SlashWhere | null>(() => {
    if (detail === null || detail.channel.id !== channelId) return null;
    return { channelId, kind: detail.channel.kind === 'dm' ? 'dm' : 'channel', isMember: detail.isMember, canManage: detail.canManage };
  }, [detail, channelId]);
  return useMemo<SlashWho>(
    () => ({
      guest,
      teamMember: !guest && team !== null && (team.myRole !== null || admin),
      teamArchived: team?.archivedAt != null,
      bots,
      selfName,
      where,
    }),
    [guest, team, admin, bots, selfName, where],
  );
}

/**
 * The page's clock, zone, roster and channels for `planSlash`. A function, so the clock is read when the message is sent, not when the page
 * last drew. Names on the roster are the team's people with the handle the @ picker shows for each.
 */
export function useSlashEnv(teamSlug: string | null, people: People): () => SlashEnv {
  const feed = useChannelFeed(teamSlug);
  const roster = useMemo(() => people.list.map((p) => ({ personId: p.personId, name: p.name, handle: handleFor(p, people.list) })), [people.list]);
  const channels = useMemo(() => feed.groups.flatMap((g) => g.channels.map((c) => ({ id: c.id as string, name: c.name.replace(/^#/, '') }))), [feed.groups]);
  const selfPersonId = people.me?.personId ?? null;
  return useCallback<() => SlashEnv>(() => ({ ...defaultEnv(), people: roster, channels, selfPersonId }), [roster, channels, selfPersonId]);
}

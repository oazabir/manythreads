import { useContext, useMemo } from 'react';
import { useQuery } from '../app/useQuery';
import { isAdmin, useSession } from '../app/session';
import { fetchBots } from '../screens/bots/api';
import { ShellContext } from '../shell/context';
import type { SlashWho } from './slash';

type Loaded = { slug: string | null; bots: SlashWho['bots'] };
const NOT_LOADED: Loaded = { slug: null, bots: null };

/**
 * The facts `planSlash` needs about the signed-in person in the conversation's team. The team's bots are read only once a message starts
 * with a slash (`wanted`), so a composer nobody types a command in never asks. A guest has no team routes and is never asked.
 */
export function useSlashWho(teamSlug: string | null, wanted: boolean, selfName: string | null): SlashWho {
  const shell = useContext(ShellContext);
  const session = useSession();
  const guest = shell?.guest ?? session.role === 'guest';
  const admin = isAdmin(session);
  const team = shell?.team && shell.team.slug === teamSlug ? shell.team : null;
  const ask = wanted && !guest && teamSlug !== null;
  const q = useQuery<Loaded>(ask ? `slash-bots:${teamSlug}` : 'slash-bots:off', () =>
    ask && teamSlug
      ? fetchBots(teamSlug).then((r) => ({ slug: teamSlug, bots: r.bots.filter((b) => b.status === 'active').map((b) => ({ slug: b.slug, name: b.name })) }))
      : Promise.resolve(NOT_LOADED),
  );
  // a previous answer is kept while another team's loads: use it only for the team it was read for
  const bots = q.status === 'ok' && q.data.slug === teamSlug ? q.data.bots : null;
  return useMemo<SlashWho>(
    () => ({
      guest,
      teamMember: !guest && team !== null && (team.myRole !== null || admin),
      teamArchived: team?.archivedAt != null,
      bots,
      selfName,
    }),
    [guest, team, admin, bots, selfName],
  );
}

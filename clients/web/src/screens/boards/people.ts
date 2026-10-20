import type { BotSummary, RosterMember } from '@manythreads/shared';
import { fetchRoster } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { fetchBots } from '../bots/api';

/**
 * The team's people and bots, for the two things the board needs them for: naming whoever holds a card, and offering a handoff
 * target. Both reads are the roster routes the rest of the app already uses, so a bot the loader has not seen is absent here too.
 */
export type TeamPeople = {
  roster: RosterMember[];
  bots: BotSummary[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
};

export function useTeamPeople(slug: string): TeamPeople {
  const rosterQ = useQuery(`roster:${slug}`, () => fetchRoster(slug));
  const botsQ = useQuery(`bots:${slug}`, () => fetchBots(slug));
  const loading = rosterQ.status === 'loading' || botsQ.status === 'loading';
  const error = rosterQ.status === 'error' ? (rosterQ.error as Error) : botsQ.status === 'error' ? (botsQ.error as Error) : null;
  return {
    roster: rosterQ.status === 'ok' ? rosterQ.data.members : [],
    bots: botsQ.status === 'ok' ? botsQ.data.bots : [],
    loading,
    error,
    reload: () => {
      rosterQ.reload();
      botsQ.reload();
    },
  };
}

import { createContext, useContext } from 'react';
import type { TeamSummary } from '@manythreads/shared';
import type { NavCounts } from './counts';

export type ShellValue = {
  teams: TeamSummary[];
  teamsLoading: boolean;
  /** The team named by `/t/:team/...` when the person can see it. */
  team: TeamSummary | null;
  /** The slug in the URL, whether or not the person can see that team (a guest has no team list to check it against). */
  teamSlug: string | null;
  /** The guest shell: only the channels that were granted. */
  guest: boolean;
  counts: NavCounts;
};

export const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const v = useContext(ShellContext);
  if (!v) throw new Error('useShell outside the app shell');
  return v;
}

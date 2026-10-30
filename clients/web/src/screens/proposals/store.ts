import { useSession } from '../../app/session';
import { useShell } from '../../shell/context';

/** Who applies proposals in this team: its lead or a workspace admin; adding or removing a bot is an admin's alone (the server enforces both). */
export function useProposalPerms(): { slug: string; canApply: boolean; isAdmin: boolean } {
  const { team, teamSlug } = useShell();
  const session = useSession();
  const slug = team?.slug ?? teamSlug ?? '';
  const isAdmin = session.role === 'owner' || session.role === 'admin';
  const lead = session.teams.find((t) => t.slug === slug)?.role === 'lead';
  return { slug, canApply: isAdmin || lead, isAdmin };
}

export const STATUS_LABEL = { open: 'Waiting for a decision', applied: 'Applied', rejected: 'Declined', withdrawn: 'Withdrawn' } as const;

/** The folder or file a proposal changes, in a few words. */
export function placeOf(path: string): string {
  if (path === 'TEAM.md') return 'Team file';
  if (path.startsWith('skills/')) return 'Skill';
  if (path.startsWith('routines/')) return 'Routine';
  if (path.startsWith('bots/')) return 'Bot';
  return 'File';
}

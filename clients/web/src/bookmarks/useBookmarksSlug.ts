import { useShell } from '../shell/context';
import { GUEST_SLUG } from '../shell/messageLink';

/** The team in the address of the Bookmarks page: the team in sight, or for a guest the shared one; null while there is none. */
export function useBookmarksSlug(): string | null {
  const { team, teamSlug, guest } = useShell();
  return team?.slug ?? (guest ? (teamSlug ?? GUEST_SLUG) : null);
}

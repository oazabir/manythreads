import type { WorkspaceMemberSummary } from '@manythreads/shared';

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When a person last used the app, in plain words: "Never signed in", "Active now", "12 minutes ago", "3 hours ago", "Yesterday", "4 days ago", "3 Sep 2026". */
export function lastActiveText(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return 'Never signed in';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Unknown';
  const ms = Math.max(0, now.getTime() - at.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 5) return 'Active now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(ms / DAY);
  if (days < 2) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** The people whose name or email contains the typed words (case and extra spaces do not matter); an empty search keeps everyone. */
export function filterMembers<T extends Pick<WorkspaceMemberSummary, 'displayName' | 'email'>>(members: readonly T[], search: string): T[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...members];
  return members.filter((m) => {
    const hay = `${m.displayName} ${m.email}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

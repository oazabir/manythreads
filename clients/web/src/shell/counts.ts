/**
 * Counters the sidebar badges read, by source name (`threads.unread`, `approvals.waiting`). The read-state service feeds
 * this once messages exist; until then no source has a count and the badges stay out of the way.
 */
export type NavCounts = Readonly<Record<string, number>>;

const NONE: NavCounts = {};

export function useNavCounts(): NavCounts {
  return NONE;
}

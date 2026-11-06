/*
 * What the browser tab says (P21-09): the title carries the count of things that want the person ("(3) # dev — Engineering · Kahf Software") and
 * the icon gets a dot. The count is unread direct messages (not muted) plus channel mentions; replies in followed threads never count, and
 * Do not disturb makes it zero so the tab is quiet while the person asked for quiet.
 */

/** Most the title and the icon show before "99+". */
export const TAB_COUNT_CAP = 99;

export const countText = (n: number): string => (n > TAB_COUNT_CAP ? `${TAB_COUNT_CAP}+` : String(n));

export type TabTitleInput = {
  /** what wants the person, already zero under Do not disturb */
  count: number;
  /** the page: "# dev", "Boards", a person's name */
  place: string;
  team: string | null;
  workspace: string;
};

/** `(3) # dev — Engineering · Kahf Software`; without a team `place · workspace`; no count, no prefix. */
export function documentTitle({ count, place, team, workspace }: TabTitleInput): string {
  const prefix = count > 0 ? `(${countText(count)}) ` : '';
  return team ? `${prefix}${place} — ${team} · ${workspace}` : `${prefix}${place} · ${workspace}`;
}

export type AttentionInput = {
  /** unread messages of each direct message the person has not muted */
  dmUnread: readonly number[];
  /** channel mentions not yet read */
  mentionCount: number;
  dnd: boolean;
};

/** What wants the person's attention: unread, unmuted DMs plus channel mentions. Followed-thread replies are left out on purpose. */
export function attentionCount({ dmUnread, mentionCount, dnd }: AttentionInput): number {
  if (dnd) return 0;
  return dmUnread.reduce((sum, n) => sum + Math.max(0, n), 0) + Math.max(0, mentionCount);
}

export type FaviconState = { dot: boolean; text: string | null };

/** The icon: the plain mark, or the mark with a dot when something waits. */
export function faviconState(count: number, dnd: boolean): FaviconState {
  const dot = count > 0 && !dnd;
  return { dot, text: dot ? countText(count) : null };
}

/** The count the tab shows: unmuted DM unread plus the bell's unread beyond those DMs (a DM also rings the bell, so it is not counted twice). */
export function combineAttention({ dms, bellUnread, dnd }: { dms: ReadonlyArray<{ unread: number; muted: boolean }>; bellUnread: number; dnd: boolean }): number {
  const dmUnread = dms.filter((d) => !d.muted).map((d) => d.unread);
  const dmTotal = dmUnread.reduce((a, b) => a + b, 0);
  return attentionCount({ dmUnread, mentionCount: Math.max(0, bellUnread - dmTotal), dnd });
}

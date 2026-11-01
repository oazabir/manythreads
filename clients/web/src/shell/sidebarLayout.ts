import { ChannelId, DEFAULT_SIDEBAR_PREFS, IDLE_CHANNEL_DAYS, MAX_STARRED_CHANNELS, type NavChannel, type NavChannelGroup, type SidebarPrefs } from '@manythreads/shared';

/*
 * How the channel groups of the sidebar (slot 40) are laid out for one person: their starred channels in a group of their own at the top,
 * the groups in the order they chose, the channels of each group sorted by recent activity or by name, and channels that went quiet folded
 * into one "N hidden" row. Pure functions: the sidebar only draws what these return.
 */

const DAY_MS = 86_400_000;
const plainName = (c: Pick<NavChannel, 'name'>): string => c.name.replace(/^#/, '').toLowerCase();

export type ArrangedGroup = {
  id: string;
  name: string;
  /** Channels shown in the group, in order. */
  channels: NavChannel[];
  /** Quiet channels folded into the "N hidden" row, in order (empty unless "Hide channels idle for 30 days" is on). */
  hidden: NavChannel[];
};

export type ArrangedSidebar = {
  /** The person's starred channels (they appear here and in no other group), in order. */
  starred: NavChannel[];
  groups: ArrangedGroup[];
};

export type ArrangeInput = {
  groups: readonly NavChannelGroup[];
  prefs: SidebarPrefs;
  /** The unread count of a channel as the sidebar shows it. */
  unreadOf: (channel: NavChannel) => number;
  /** The name of the channel that is open now (never folded away), or null. */
  openName: string | null;
  /** The current time in milliseconds. */
  now: number;
};

/** True when the channel has had no message for more than 30 days. A channel without a known time is never idle. */
export function isIdle(channel: Pick<NavChannel, 'lastActivityAt'>, now: number): boolean {
  if (!channel.lastActivityAt) return false;
  const at = Date.parse(channel.lastActivityAt);
  return Number.isFinite(at) && now - at > IDLE_CHANNEL_DAYS * DAY_MS;
}

/**
 * `team`: the order they come in (the team's own order, as the sidebar always showed). `recent`: newest message first (a channel with no known
 * time last). `name`: alphabetical. Equal channels keep a fixed order by name, then id.
 */
export function sortChannels(channels: readonly NavChannel[], sort: SidebarPrefs['sort']): NavChannel[] {
  if (sort === 'team') return [...channels];
  const time = (c: NavChannel): number => {
    const t = c.lastActivityAt ? Date.parse(c.lastActivityAt) : Number.NaN;
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return [...channels].sort((a, b) => {
    if (sort === 'recent') {
      const d = time(b) - time(a);
      if (d !== 0 && !Number.isNaN(d)) return d;
    }
    const an = plainName(a);
    const bn = plainName(b);
    return an < bn ? -1 : an > bn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The groups in the person's order: listed groups first, in the order listed; any other group after them in the order the server gave. */
export function orderGroups<T extends { id: string }>(groups: readonly T[], groupOrder: readonly string[]): T[] {
  const rank = new Map<string, number>();
  groupOrder.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const listed = groups.filter((g) => rank.has(g.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...listed, ...groups.filter((g) => !rank.has(g.id))];
}

/**
 * The sidebar as one person sees it. A starred channel is listed in the Starred group only; a group whose channels are all starred is left out.
 * With "hide idle" on, a channel with no message for 30 days moves to the group's hidden list, unless it has unread messages (a mention is
 * unread too), is the open one, or is starred.
 */
export function arrangeSidebar(input: ArrangeInput): ArrangedSidebar {
  const { groups, prefs, unreadOf, openName, now } = input;
  const starredIds = new Set<string>(prefs.starred);
  const open = openName ? openName.replace(/^#/, '').toLowerCase() : null;
  const seen = new Set<string>();
  const starred: NavChannel[] = [];
  // collected in the order the groups are shown, so the Starred group in the team's order reads the way the groups would
  for (const g of orderGroups(groups, prefs.groupOrder)) {
    for (const c of g.channels) {
      if (starredIds.has(c.id) && !seen.has(c.id)) {
        seen.add(c.id);
        starred.push(c);
      }
    }
  }
  const arranged: ArrangedGroup[] = [];
  for (const g of orderGroups(groups, prefs.groupOrder)) {
    const rest = sortChannels(
      g.channels.filter((c) => !starredIds.has(c.id)),
      prefs.sort,
    );
    if (rest.length === 0) continue;
    const kept: NavChannel[] = [];
    const hidden: NavChannel[] = [];
    for (const c of rest) {
      const folded = prefs.hideIdle && isIdle(c, now) && unreadOf(c) <= 0 && plainName(c) !== open;
      (folded ? hidden : kept).push(c);
    }
    arranged.push({ id: g.id, name: g.name, channels: kept, hidden });
  }
  return { starred: sortChannels(starred, prefs.sort), groups: arranged };
}

/** The ids of the groups as they are shown (the order the Move buttons and dragging work on). */
export const shownGroupIds = (groups: readonly { id: string }[], groupOrder: readonly string[]): string[] => orderGroups(groups, groupOrder).map((g) => g.id);

/** `ids` with `id` one place earlier (`-1`) or later (`1`); the same list when it is already at the end. */
export function moveId(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** `ids` with `id` taken out and put just before `target` (or just after it, with `after`); the same list when either is unknown. */
export function dropId(ids: readonly string[], id: string, target: string, after: boolean): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return [...ids];
  const without = ids.filter((x) => x !== id);
  const at = without.indexOf(target) + (after ? 1 : 0);
  without.splice(at, 0, id);
  return without;
}

/** Whether the channel is in the starred list. */
export const isStarred = (starred: readonly string[], channelId: string): boolean => starred.includes(channelId);

/** True when no more channels can be starred. */
export const starsFull = (starred: readonly string[]): boolean => starred.length >= MAX_STARRED_CHANNELS;

/** The change that stars or unstars a channel, or `null` when the list is full (the person must unstar one first). */
export function starPatch(starred: readonly string[], channelId: string, on: boolean): PrefsPatch | null {
  const id = ChannelId.parse(channelId);
  if (on) return isStarred(starred, channelId) ? {} : starsFull(starred) ? null : { starAdd: [id] };
  return { starRemove: [id] };
}

/**
 * What the screen sends: stars as "add these, remove those" (a tab that is out of date cannot undo a star made elsewhere), the rest as the
 * new value.
 */
export type PrefsPatch = {
  starAdd?: SidebarPrefs['starred'];
  starRemove?: SidebarPrefs['starred'];
  sort?: SidebarPrefs['sort'];
  hideIdle?: boolean;
  groupOrder?: SidebarPrefs['groupOrder'];
};

/** The view after a change (what the screen shows before the server has answered). */
export function applyPatch(prefs: SidebarPrefs, patch: PrefsPatch): SidebarPrefs {
  const gone = new Set<string>(patch.starRemove ?? []);
  const kept = prefs.starred.filter((id) => !gone.has(id));
  const added = (patch.starAdd ?? []).filter((id) => !kept.includes(id) && !gone.has(id));
  return {
    starred: [...kept, ...added],
    sort: patch.sort ?? prefs.sort,
    hideIdle: patch.hideIdle ?? prefs.hideIdle,
    groupOrder: patch.groupOrder ?? prefs.groupOrder,
  };
}

/** The change that takes `patch` back, given the view before it. */
export function inversePatch(before: SidebarPrefs, patch: PrefsPatch): PrefsPatch {
  const undo: PrefsPatch = {};
  const removed = (patch.starRemove ?? []).filter((id) => before.starred.includes(id));
  const added = (patch.starAdd ?? []).filter((id) => !before.starred.includes(id));
  if (removed.length > 0) undo.starAdd = removed;
  if (added.length > 0) undo.starRemove = added;
  if (patch.sort !== undefined) undo.sort = before.sort;
  if (patch.hideIdle !== undefined) undo.hideIdle = before.hideIdle;
  if (patch.groupOrder !== undefined) undo.groupOrder = before.groupOrder;
  return undo;
}

/**
 * The whole order of a team's groups after the shown ones were rearranged. `fullOrder` lists every group of the team in its current order
 * (shown or not); `shownAfter` is the new order of the groups that are shown. Only the places the shown groups hold are refilled, so a group
 * that is not shown (all its channels starred, or none to see) keeps its place among the others.
 */
export function reorderShown(fullOrder: readonly string[], shownAfter: readonly string[]): string[] {
  const shown = new Set<string>(shownAfter);
  const queue = shownAfter.filter((id) => fullOrder.includes(id));
  let next = 0;
  return fullOrder.map((id) => (shown.has(id) ? (queue[next++] ?? id) : id));
}

export const FULL_STARS_TEXT = `You can star up to ${MAX_STARRED_CHANNELS} channels. Remove a star before adding another.`;

export { DEFAULT_SIDEBAR_PREFS };

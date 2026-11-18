/**
 * The rules of the Members panel (P33-02), kept apart from React so a test can run them: who is in the channel, who of the team is not, and what a filter keeps.
 */

export type PanelPerson = { personId: string; displayName: string; avatar?: string | null | undefined };

/** The type of the panel entry (`members:<channelId>`); it is registered in `kernel/panel/builtins.tsx`. */
export const MEMBERS_PANEL = 'members';

/** A name matches when it holds every word of the filter, in any order, ignoring case and accents; an empty filter keeps everyone. */
export function matchesFilter(name: string, filter: string): boolean {
  const norm = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const words = norm(filter).split(/\s+/).filter(Boolean);
  const hay = norm(name);
  return words.every((w) => hay.includes(w));
}

const byName = (a: PanelPerson, b: PanelPerson): number => a.displayName.localeCompare(b.displayName) || a.personId.localeCompare(b.personId);

/**
 * Splits the team's people by the channel: `inChannel` are the channel's members (as the channel lists them, so a person who joined and later left the team
 * still shows), `others` are the team's people who are not. The reader comes first in their list; both lists are filtered by `filter` and sorted by name.
 * `added` holds people added in this panel before the channel's list is read again: they count as members at once.
 */
export function splitMembers(
  members: readonly PanelPerson[],
  roster: readonly PanelPerson[],
  filter: string,
  selfPersonId: string | null,
  added: readonly PanelPerson[] = [],
): { inChannel: PanelPerson[]; others: PanelPerson[] } {
  const known = new Set(members.map((m) => m.personId));
  const joined = [...members, ...added.filter((a) => !known.has(a.personId))];
  const ids = new Set(joined.map((m) => m.personId));
  const withFace = joined.map((m) => ({ ...m, avatar: m.avatar ?? roster.find((r) => r.personId === m.personId)?.avatar ?? null }));
  const rank = (p: PanelPerson): number => (p.personId === selfPersonId ? 0 : 1);
  const inChannel = withFace.filter((m) => matchesFilter(m.displayName, filter)).sort((a, b) => rank(a) - rank(b) || byName(a, b));
  const others = roster.filter((r) => !ids.has(r.personId) && matchesFilter(r.displayName, filter)).sort(byName);
  return { inChannel, others };
}

/** Whether the panel offers Add: a reader who may manage the channel, never a guest, never in an archived channel. */
export function canAddMembers(o: { canManage: boolean; guest: boolean; archived: boolean }): boolean {
  return o.canManage && !o.guest && !o.archived;
}

export const NO_ADD_NOTE = 'A team lead can add people to this channel.';

/** The line a screen reader hears after Add. */
export const addedLine = (name: string, channelName: string): string => `Added ${name} to #${channelName.replace(/^#/, '')}`;

// ---- a change of a channel's people is told to every part of the header that counts them ----------------------------------------------------------
const listeners = new Set<(channelId: string) => void>();
export const onMembersChanged = (fn: (channelId: string) => void): (() => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const notifyMembersChanged = (channelId: string): void => {
  for (const fn of [...listeners]) fn(channelId);
};

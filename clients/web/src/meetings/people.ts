/*
 * The rules of the people checklist (`PeopleChecklist.tsx`), shared by the start dialog, Invite more and the schedule dialog. Plain functions, no React, so a
 * test can run them.
 */

/** One person the list can tick. `locked` is ticked and cannot be unticked (the caller in the start dialog: always in the call, never invited). */
export type ChecklistPerson = { personId: string; displayName: string; locked?: boolean };

/** The find box appears once the list is longer than this. */
export const FIND_AFTER = 6;

const norm = (s: string): string => s.trim().toLowerCase();

/** The people whose name holds the words typed (any case); everyone when nothing is typed. */
export function filterPeople<P extends ChecklistPerson>(people: readonly P[], find: string): P[] {
  const q = norm(find);
  if (q === '') return [...people];
  return people.filter((p) => p.displayName.toLowerCase().includes(q));
}

/** "1,240": a count the way the dialog writes it. */
export const countText = (n: number): string => n.toLocaleString('en-US');

/**
 * The line the list's status region says while a filter is typed: "4 of 12 match", "Nobody matches"; null with no filter (the region stays, empty, so a
 * screen reader hears the first change).
 */
export function matchLine(find: string, matching: number, total: number): string | null {
  if (norm(find) === '') return null;
  if (matching === 0) return 'Nobody matches';
  return `${countText(matching)} of ${countText(total)} match`;
}

/** The line under a list the server cut short: "Showing 200 of 1,240 — type to search" (null when everyone is shown). */
export function capLine(shown: number, total: number): string | null {
  return total > shown ? `Showing ${countText(shown)} of ${countText(total)} — type to search` : null;
}

/**
 * What "Select all" does to the shown people: ticks every one that can be ticked, or, when they all are already, unticks them. Locked people never change.
 * With `max`, it ticks only as many as still fit (the people first in the list); `capped` says some were left out.
 */
export function selectShown(picked: readonly string[], shown: readonly ChecklistPerson[], max = Infinity): { next: string[]; capped: boolean } {
  const free = shown.filter((p) => !p.locked).map((p) => p.personId);
  const all = free.length > 0 && free.every((id) => picked.includes(id));
  if (all) return { next: picked.filter((id) => !free.includes(id)), capped: false };
  const missing = free.filter((id) => !picked.includes(id));
  const room = Math.max(0, max - picked.length);
  return { next: [...picked, ...missing.slice(0, room)], capped: missing.length > room };
}

/** Said when a list may not hold more: the server refuses more than this many invitations to one call. */
export const tooManyLine = (max: number): string => `At most ${countText(max)} people can be invited to one call`;

/** The words of the Select all button for the shown people: "Select all", "Clear all", or null when there is nothing to tick (one person or none). */
export function selectAllLabel(picked: readonly string[], shown: readonly ChecklistPerson[]): string | null {
  const free = shown.filter((p) => !p.locked);
  if (free.length < 2) return null;
  return free.every((p) => picked.includes(p.personId)) ? 'Clear all' : 'Select all';
}

/** Ticks or unticks one person; a locked person stays as they are. */
export function togglePerson(picked: readonly string[], person: ChecklistPerson): string[] {
  if (person.locked) return [...picked];
  return picked.includes(person.personId) ? picked.filter((id) => id !== person.personId) : [...picked, person.personId];
}

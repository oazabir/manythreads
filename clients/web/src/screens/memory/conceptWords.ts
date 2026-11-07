import type { MemoryConceptSummary } from '@manythreads/shared';

/*
 * The words of the team's Concepts tab (PLAN P21-15): what each trust level is called, and the small facts a row and the preview pane both
 * need. Pure functions of the concept, so they are tested without a browser.
 */

export type TrustTier = MemoryConceptSummary['trustTier'];

/** What a trust level means, in the words a person would use (never the stored value). */
export const TEAM_TRUST_WORDS: Readonly<Record<TrustTier, string>> = {
  unverified: 'Not checked yet',
  'machine-confirmed': 'Confirmed by a check',
  'human-reviewed': 'Reviewed by a person',
};

/** A concept whose "stale after" time has passed: its facts may be out of date. */
export const isStaleConcept = (c: Pick<MemoryConceptSummary, 'staleAfter'>, now: number = Date.now()): boolean =>
  c.staleAfter !== null && Date.parse(c.staleAfter) < now;

/** The concept a link or a click names, or null when the list does not hold it (it was removed, or the address is old). */
export const conceptAt = (concepts: readonly MemoryConceptSummary[], path: string | null): MemoryConceptSummary | null =>
  path === null ? null : (concepts.find((c) => c.path === path) ?? null);

/** The sentence a screen reader hears for a row: the title, then whatever is unusual about the concept. */
export function rowNote(c: Pick<MemoryConceptSummary, 'status' | 'staleAfter'>, now: number = Date.now()): string {
  const notes = [c.status === 'deprecated' ? 'deprecated' : '', isStaleConcept(c, now) ? 'out of date' : ''].filter(Boolean);
  return notes.join(', ');
}

/*
 * Per-person data held in the page (loaded channels, unread counts, the sidebar directory). It belongs to whoever is signed in:
 * when the person changes or signs out, everything registered here is dropped, so the next person in the same tab starts clean.
 */
const resets = new Set<() => void>();

export function onPersonChange(reset: () => void): void {
  resets.add(reset);
}

export function dropPersonData(): void {
  for (const r of [...resets]) r();
}

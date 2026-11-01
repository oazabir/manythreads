/*
 * `/away` (PLAN P14-06): a person who types it is shown as away until they type it again. The server has no "away by choice" of its own -- it
 * knows `online` and `away` from the heartbeat -- so the choice lives in the browser: while it is on, every tab of this browser sends `away` instead of
 * `online`, and the dot turns grey for everyone. It is kept in localStorage so a reload keeps it and every tab sees it; storage can be blocked
 * (private windows), so it also lives in memory and the page works without it.
 *
 * The choice belongs to a person, not to the browser: the stored value is the id of the person who made it, and it counts only while that person is
 * the one signed in (`setAwayOwner`, called by the session). Signing out, or signing in as someone else on the same browser, never carries it over.
 */

export const AWAY_KEY = 'mt:presence:manual-away';

let owner: string | null = null;
let memory = false;

/** Tells which person is signed in (null: nobody). The memory copy of the choice does not outlive a change of person. */
export function setAwayOwner(personId: string | null): void {
  if (personId !== owner) memory = false;
  owner = personId;
}

/** Whether the signed-in person chose to be shown as away. */
export function manualAway(): boolean {
  if (owner === null) return false;
  try {
    // storage answers when it works: a missing key is "not away", even if this tab last set it (another tab may have cleared it)
    return window.localStorage.getItem(AWAY_KEY) === owner;
  } catch {
    // blocked storage: the memory copy answers
  }
  return memory;
}

export function setManualAway(on: boolean): void {
  if (owner === null) return;
  memory = on;
  try {
    if (on) window.localStorage.setItem(AWAY_KEY, owner);
    else window.localStorage.removeItem(AWAY_KEY);
  } catch {
    // blocked storage: this tab only
  }
}

/** What the heartbeat sends: `away` while the person chose it, otherwise what the tab's own activity says. */
export function chosenBeat(natural: 'online' | 'away' | null): 'online' | 'away' | null {
  return manualAway() ? 'away' : natural;
}

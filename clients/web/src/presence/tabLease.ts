/*
 * One browser, several tabs, one person (PLAN P14-01): every open tab sends the heartbeat, and the server keeps one row per person, so a hidden or
 * idle tab saying "away" would flip the person to Away every 30 seconds while another tab of the same browser is in use. A tab that is in use takes
 * a short lease in localStorage on each beat; a tab that wants to say "away" stays quiet while another tab holds a fresh lease. Storage can be
 * blocked (private windows), so every access is wrapped; without it each tab simply beats for itself.
 */

export const LEASE_KEY = 'mt:presence:lease';
/** A little under the server's 90 seconds, and longer than the 30-second beat plus a late timer. */
export const LEASE_MS = 75_000;

export type Lease = { tab: string; at: number };

/** May this tab send `state` now? Always yes for `online`; `away` only when no other tab holds a fresh lease. */
export function mayBeat(state: 'online' | 'away', lease: Lease | null, tab: string, now: number): boolean {
  if (state === 'online') return true;
  if (lease === null || lease.tab === tab) return true;
  return now - lease.at > LEASE_MS;
}

export function parseLease(raw: string | null): Lease | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === 'object' && v !== null && typeof (v as Lease).tab === 'string' && typeof (v as Lease).at === 'number') return { tab: (v as Lease).tab, at: (v as Lease).at };
  } catch {
    // an unreadable lease is no lease
  }
  return null;
}

export function readLease(): Lease | null {
  try {
    return parseLease(window.localStorage.getItem(LEASE_KEY));
  } catch {
    return null;
  }
}

export function writeLease(tab: string, now: number): void {
  try {
    window.localStorage.setItem(LEASE_KEY, JSON.stringify({ tab, at: now } satisfies Lease));
  } catch {
    // storage blocked or full: this tab beats for itself
  }
}

/** This tab's name for the lease. */
export const TAB_ID = Math.random().toString(36).slice(2);

/** What this tab sends now: `state`, or null when another tab of this browser is in use and this one would only say "away". An `online` beat renews the lease. */
export function beatFor(state: 'online' | 'away'): 'online' | 'away' | null {
  const now = Date.now();
  if (!mayBeat(state, readLease(), TAB_ID, now)) return null;
  if (state === 'online') writeLease(TAB_ID, now);
  return state;
}

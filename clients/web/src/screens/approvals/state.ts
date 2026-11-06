import { APPROVAL_OVERDUE_HOURS, APPROVAL_RUN_TIMEOUT_MINUTES, type Approval } from '@manythreads/shared';

/** An approved call that has not reported back, and is still inside the time the server gives it before the sweep calls it failed. */
export function callInFlight(a: Approval, now: number = Date.now()): boolean {
  if (a.status !== 'approved' || (a.outcome !== 'queued' && a.outcome !== 'running')) return false;
  const since = Date.parse(a.decision?.decidedAt ?? a.createdAt);
  return Number.isNaN(since) || now - since < APPROVAL_RUN_TIMEOUT_MINUTES * 60_000;
}

/** An approved call that never reported back inside that time: the card says so instead of waiting for ever. */
export function callOverdue(a: Approval, now: number = Date.now()): boolean {
  return a.status === 'approved' && (a.outcome === 'queued' || a.outcome === 'running') && !callInFlight(a, now);
}

/** How long a pending request has waited: the words on the age pill, and whether it has passed the day after which the pill turns amber. */
export interface WaitAge {
  /** Whole hours since it was asked (never negative). */
  hours: number;
  overdue: boolean;
  /** "Waiting 12 min", "Waiting 5 h", "Waiting 2 days": the word is in the pill, so colour is never the only signal. */
  label: string;
}

export function waitAge(createdAt: string, now: number = Date.now()): WaitAge {
  const since = Date.parse(createdAt);
  const minutes = Number.isNaN(since) ? 0 : Math.max(0, Math.floor((now - since) / 60_000));
  const hours = Math.floor(minutes / 60);
  const overdue = hours >= APPROVAL_OVERDUE_HOURS;
  if (overdue) {
    const days = Math.floor(hours / 24);
    return { hours, overdue, label: `Waiting ${String(days)} ${days === 1 ? 'day' : 'days'}` };
  }
  if (hours >= 1) return { hours, overdue, label: `Waiting ${String(hours)} h` };
  return { hours, overdue, label: minutes < 1 ? 'Waiting just now' : `Waiting ${String(minutes)} min` };
}

/** Waiting stays oldest first: ids are time-ordered, so the server's order is the age order; this keeps the list right if a row arrives out of order. */
export function oldestFirst<T extends { id: string; createdAt: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

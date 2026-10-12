import { APPROVAL_RUN_TIMEOUT_MINUTES, type Approval } from '@manythreads/shared';

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

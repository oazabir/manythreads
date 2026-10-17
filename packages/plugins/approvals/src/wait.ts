/** A run a router worker holds is normally stopped before anyone approves; if it is not yet, the call waits (ten seconds at a time, then a minute) until that run's own deadline. */
const WAIT_MS = 10_000;
/** After the first two minutes of waiting the check is a minute apart: a run with a long budget is not polled thousands of times. */
const SLOW_AFTER_WAITS = 12;
const SLOW_WAIT_MS = 60_000;
/** A run is ended this long after its own deadline (its token's expiry), whatever it is doing: a run that is past its budget is not going to answer. */
const DEADLINE_GRACE_MS = 30_000;
/** When a run has no token row to say (it should always have one), this long after its start. */
export const FALLBACK_BUDGET_MS = 15 * 60 * 1000;

/**
 * What to do with a call whose origin run is still `running`:
 *   * a run no worker holds (an external client's MCP run) is ended now — nothing else will ever end it;
 *   * a run a router worker holds is waited for until its OWN deadline (its token expires with its budget, `limits.timeoutSeconds` plus slack): the
 *     worker is still working, its model may be mid-turn and its reply still to post, and ending it under it would turn that reply into a refusal;
 *   * past its deadline (plus a grace) it is ended all the same.
 * `waits` only sets how often the check is repeated.
 */
export function executeWait(input: { held: boolean; nowMs: number; deadlineMs: number; waits: number }): { action: 'end' } | { action: 'wait'; delayMs: number } {
  if (!input.held || input.nowMs >= input.deadlineMs + DEADLINE_GRACE_MS) return { action: 'end' };
  return { action: 'wait', delayMs: input.waits < SLOW_AFTER_WAITS ? WAIT_MS : SLOW_WAIT_MS };
}

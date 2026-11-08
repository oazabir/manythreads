import type { PluginTx } from '@manythreads/sdk';
import type { OAuthDeps } from './oauth/store.ts';

// The daily usage counter per connection (PLAN P16-11, decision D31). `source.ts` counts one tool call here after it ran, worked or not: a day, a connection, how many calls, how
// many failed (`app.connection_usage_bump`, migration 0006). Counts only. Never the arguments, the answer, a person's name or what a call read. The admin page reads the sums
// (`readUsage`) as the system role: the table gives the application role nothing.

/** Counts one call in the transaction given. The caller's transaction must be in the connection's workspace (the function checks it); a connection of another workspace changes nothing. */
export async function bumpConnectionUsage(tx: PluginTx, input: { connectionId: string; failed: boolean }): Promise<void> {
  await tx.query('SELECT app.connection_usage_bump($1::uuid, $2::boolean)', [input.connectionId, !input.failed]);
}

/**
 * Counts one call in a short transaction of its own, so the count survives a call that threw (the gateway rolls its transaction back) and never makes a tool call fail. Best
 * effort by design: a counter that cannot be written is lost, not an error for the person who asked.
 */
export async function countToolCall(deps: Pick<OAuthDeps, 'db'>, input: { workspaceId: string; connectionId: string; failed: boolean }): Promise<void> {
  try {
    await deps.db.system((tx) => bumpConnectionUsage(tx, input), { workspaceId: input.workspaceId });
  } catch {
    /* the count is lost; the call itself is unaffected */
  }
}

/** True for what a connection kind or a person tool answers when a call did not work: `{ ok: false, ... }`. */
export const isFailedAnswer = (answer: unknown): boolean => typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === false;

/** One provider's (or kind's) sums over the last seven days (today and the six days before it, in UTC). */
export interface UsageSum {
  connector: string;
  calls: number;
  failures: number;
  /** The newest day with a counted call (UTC midnight). */
  lastDay: Date | null;
}

/** Calls and failures of the last seven days per provider, for one workspace. Runs as the system role: pass a system transaction. */
export async function readUsage(tx: PluginTx, workspaceId: string): Promise<Map<string, UsageSum>> {
  const rows = await tx.query<{ provider: string; calls: string | number; failures: string | number; last_day: string | null }>(
    `SELECT provider, sum(calls) AS calls, sum(failures) AS failures, to_char(max(day), 'YYYY-MM-DD') AS last_day
       FROM app.connection_usage_daily
      WHERE workspace_id = $1 AND day > (now() AT TIME ZONE 'utc')::date - 7
      GROUP BY provider`,
    [workspaceId],
  );
  return new Map(
    rows.rows.map((r) => [
      r.provider,
      { connector: r.provider, calls: Number(r.calls), failures: Number(r.failures), lastDay: r.last_day === null ? null : new Date(`${r.last_day}T00:00:00.000Z`) },
    ]),
  );
}

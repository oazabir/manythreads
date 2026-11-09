import type { ActorId, RunId, WorkspaceId } from '@manythreads/shared';
import type pg from 'pg';
import { getAppPool, getSystemPool } from './pool.ts';
import { traceTransaction } from './trace.ts';

export type ActorKind = 'person' | 'bot' | 'system';

/** Who is acting. `id` is the `actors` row id (what `app.actor()` returns inside RLS policies). */
export interface Actor {
  kind: ActorKind;
  id: ActorId;
  workspaceId: WorkspaceId;
  /** Set for bot runs; written to `app.run_id` for audit. */
  runId?: RunId;
  /** What started the run (`conversation`, `mention`, `routine`, ...); read by the capability broker. */
  trigger?: string;
  /**
   * Set only by `ctx.runs.asApproved`: this transaction makes one call that a person approved (the approvals plugin, SPEC §7.3). The broker
   * then does not ask for approval again for exactly that capability — every other check (the grant, the path guard, the destructive tag)
   * still applies, and any other capability still waits. A property of the in-memory actor, never a setting the SQL could change.
   */
  approvedCapability?: string;
}

/** The only client request code sees: queries inside one actor transaction, nothing else. */
export interface Tx {
  readonly actor: Actor;
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** The system actor. The nil workspace means "no particular workspace"; pass one to scope writes. */
export function systemActor(workspaceId: WorkspaceId = NIL_UUID as WorkspaceId): Actor {
  return { kind: 'system', id: NIL_UUID as ActorId, workspaceId };
}

export interface WithActorOptions {
  /** Defaults to the shared manythreads_app pool, or the manythreads_system pool for the system actor. */
  pool?: pg.Pool;
  /** Open the transaction `READ ONLY`: any write in it fails with 25006 (the actor settings below are session settings, not data). */
  readOnly?: boolean;
  /** A whole number of milliseconds: any one statement of the transaction that runs longer is cancelled by the database (`SET LOCAL statement_timeout`). */
  statementTimeoutMs?: number;
}

/**
 * The one DB entry. Opens a transaction on the manythreads_app pool, sets the actor for RLS with SET LOCAL
 * semantics (`set_config(..., true)`), runs `fn`, then commits; any throw rolls back.
 */
export function withActor<T>(
  actor: Actor,
  fn: (tx: Tx) => Promise<T>,
  options: WithActorOptions = {},
): Promise<T> {
  // One span per transaction when a request or job is being traced (db/trace.ts); otherwise this is `runActor` itself.
  return traceTransaction(actor, options.readOnly === true, () => runActor(actor, fn, options));
}

async function runActor<T>(
  actor: Actor,
  fn: (tx: Tx) => Promise<T>,
  options: WithActorOptions,
): Promise<T> {
  const client = await (options.pool ?? (actor.kind === 'system' ? getSystemPool() : getAppPool())).connect();
  let released = false;
  try {
    await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    if (options.statementTimeoutMs !== undefined) {
      // an integer by construction (never text from a caller), so it can be written into the statement: SET does not take a bind parameter
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.min(600_000, Math.trunc(options.statementTimeoutMs)))}`);
    }
    await client.query(
      `SELECT set_config('app.actor_id', $1, true),
              set_config('app.actor_kind', $2, true),
              set_config('app.workspace_id', $3, true),
              set_config('app.run_id', $4, true)`,
      [actor.id, actor.kind, actor.workspaceId, actor.runId ?? ''],
    );
    const tx: Tx = {
      actor,
      query: (text, values) => client.query(text, values as unknown[] | undefined),
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is broken; drop it instead of returning it to the pool.
      client.release(true);
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

/**
 * `withActor` as the system actor. The pool must log in as manythreads_system (the default): app.is_system() is true only
 * for that Postgres role, so on any other pool the transaction is an ordinary one that just carries the system GUCs.
 */
export function withSystem<T>(
  fn: (tx: Tx) => Promise<T>,
  options: WithActorOptions & { workspaceId?: WorkspaceId } = {},
): Promise<T> {
  return withActor(systemActor(options.workspaceId), fn, options);
}

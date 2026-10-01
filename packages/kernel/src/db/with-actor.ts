import type { ActorId, RunId, WorkspaceId } from '@majlis/shared';
import type pg from 'pg';
import { getAppPool, getSystemPool } from './pool.ts';

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
  /** Defaults to the shared majlis_app pool, or the majlis_system pool for the system actor. */
  pool?: pg.Pool;
}

/**
 * The one DB entry. Opens a transaction on the majlis_app pool, sets the actor for RLS with SET LOCAL
 * semantics (`set_config(..., true)`), runs `fn`, then commits; any throw rolls back.
 */
export async function withActor<T>(
  actor: Actor,
  fn: (tx: Tx) => Promise<T>,
  options: WithActorOptions = {},
): Promise<T> {
  const client = await (options.pool ?? (actor.kind === 'system' ? getSystemPool() : getAppPool())).connect();
  let released = false;
  try {
    await client.query('BEGIN');
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
 * `withActor` as the system actor. The pool must log in as majlis_system (the default): app.is_system() is true only
 * for that Postgres role, so on any other pool the transaction is an ordinary one that just carries the system GUCs.
 */
export function withSystem<T>(
  fn: (tx: Tx) => Promise<T>,
  options: WithActorOptions & { workspaceId?: WorkspaceId } = {},
): Promise<T> {
  return withActor(systemActor(options.workspaceId), fn, options);
}

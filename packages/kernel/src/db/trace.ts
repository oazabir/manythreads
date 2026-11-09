import { traceSpan } from '@manythreads/sdk';
import type { Actor } from './with-actor.ts';

/** The nil workspace of the system actor (`NIL_UUID` in with-actor.ts; repeated so the two files do not import each other). */
const NIL_WORKSPACE = '00000000-0000-0000-0000-000000000000';

/**
 * One span around a whole actor transaction (`withActor` / `withSystem`): the wait for a pooled connection, the statements and the commit. It is the only place the database
 * entry meets telemetry, so every query of a traced request or job shows up under it.
 *
 * Attributes are kinds and ids only (never SQL, never a value): who acted, in which workspace, for which run. With tracing off, or outside a request or job, this is exactly `fn()`.
 */
export function traceTransaction<T>(actor: Actor, readOnly: boolean, fn: () => Promise<T>): Promise<T> {
  return traceSpan(
    'db.transaction',
    {
      'mt.db.actor_kind': actor.kind,
      'mt.workspace_id': actor.workspaceId === NIL_WORKSPACE ? undefined : actor.workspaceId,
      'mt.run_id': actor.runId,
      'mt.db.read_only': readOnly,
    },
    fn,
  );
}

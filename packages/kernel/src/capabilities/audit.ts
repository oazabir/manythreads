import type { ActorId, RunId, WorkspaceId } from '@manythreads/shared';
import type { Tx } from '../db/with-actor.ts';
import { withSystem } from '../db/with-actor.ts';

export interface DenialRecord {
  workspaceId: WorkspaceId;
  actorId: ActorId;
  actorKind: 'person' | 'bot' | 'system';
  runId: RunId | null;
  capability: string;
  reason: string;
  path: string | null;
  trigger: string | null;
}

/** Receives every denial. Must not throw to the caller's detriment: a failing sink never turns a deny into an allow. */
export type AuditSink = (denial: DenialRecord) => void | Promise<void>;

/** The kernel's `emit(tx, event)` (P1-05); kept as a minimal structural type so this module stays decoupled. */
export type AuditEmitFn = (tx: Tx, event: Record<string, unknown> & { type: string; schemaVersion: number }) => Promise<unknown>;

/** Default sink: one `kernel.capability.denied` event per denial, written as the system actor. */
export function createEventAuditSink(emit: AuditEmitFn, options: { withTx?: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> } = {}): AuditSink {
  const run = options.withTx ?? ((fn) => withSystem(fn));
  return (denial) =>
    run(async (tx) => {
      await emit(tx, { type: 'kernel.capability.denied', schemaVersion: 1, ...denial });
    });
}

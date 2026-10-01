import type { ActorId, BotId, PersonId, RunId, WorkspaceId } from '@majlis/shared';
import { getOneOrCreate, systemActor, type Actor, type ActorKind, type Tx } from '../db/index.ts';

/** A person acting as themselves; `id` is their `actors` row id (see ensureActor). */
export function personActor(id: ActorId, workspaceId: WorkspaceId): Actor {
  return { kind: 'person', id, workspaceId };
}

/** A bot acting in one run; `trigger` is what started it (read by the capability broker). */
export function botActor(id: ActorId, workspaceId: WorkspaceId, run?: { runId?: RunId; trigger?: string }): Actor {
  const actor: Actor = { kind: 'bot', id, workspaceId };
  if (run?.runId) actor.runId = run.runId;
  if (run?.trigger) actor.trigger = run.trigger;
  return actor;
}

/** The system actor (nil id), optionally scoped to a workspace. */
export function systemWorkspaceActor(workspaceId?: WorkspaceId): Actor {
  return systemActor(workspaceId);
}

export interface EnsureActorInput {
  kind: ActorKind;
  workspaceId: WorkspaceId;
  /** Person id, bot id, or (for system) the workspace id. */
  refId: PersonId | BotId | WorkspaceId;
}

/**
 * Registers an identity in `app.actors` (get-or-create on `(workspace_id, kind, ref_id)`) and returns it as an
 * `Actor` ready for withActor. Writes to `actors` are system-only, so call it inside withSystem.
 */
export async function ensureActor(tx: Tx, input: EnsureActorInput): Promise<Actor> {
  const row = await getOneOrCreate<{ id: string }>(tx, {
    table: 'app.actors',
    values: { workspace_id: input.workspaceId, kind: input.kind, ref_id: input.refId },
    conflict: ['workspace_id', 'kind', 'ref_id'],
    returning: ['id'],
  });
  return { kind: input.kind, id: row.id as ActorId, workspaceId: input.workspaceId };
}

/**
 * Runs `fn` with `app.actor_kind = 'system'` for this transaction only, then restores the previous value.
 * For kernel code that must touch a system-only table (jobs) on behalf of an ordinary actor's transaction.
 */
export async function runAsSystem<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const prev = await tx.query<{ v: string }>(`SELECT coalesce(current_setting('app.actor_kind', true), '') AS v`);
  await tx.query(`SELECT set_config('app.actor_kind', 'system', true)`);
  try {
    return await fn();
  } finally {
    await tx.query(`SELECT set_config('app.actor_kind', $1, true)`, [prev.rows[0]?.v ?? '']);
  }
}

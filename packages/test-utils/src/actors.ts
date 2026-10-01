import { toEventRecord, withActor, withSystem, type Actor, type EventRow, type Tx, type WithActorOptions } from '@manythreads/kernel';
import type { EventRecord } from '@manythreads/shared';
import { personaActor, type Persona } from './personas.ts';

/** Run `fn` inside a transaction as `persona` (RLS applies exactly as for that person's request). */
export function readAs<T>(persona: Persona, fn: (tx: Tx) => Promise<T>, options: WithActorOptions = {}): Promise<T> {
  return withActor(personaActor(persona), fn, options);
}

const LATEST_EVENT = 'SELECT id FROM app.events WHERE type = $1 ORDER BY id DESC LIMIT 1';

/**
 * Runs `fn` and returns the event of `type` it emitted, read from `app.events` afterwards. Throws when `fn` emitted
 * none; when it emitted several, the last is returned (use `captureEvents` to get them all).
 */
export async function captureEvent(
  type: string,
  fn: () => Promise<unknown>,
  options: WithActorOptions = {},
): Promise<EventRecord> {
  const events = await captureEvents(type, fn, options);
  const last = events[events.length - 1];
  if (!last) throw new Error(`captureEvent: no "${type}" event was emitted`);
  return last;
}

/** Every event of `type` that `fn` emitted, oldest first (event ids are time-ordered uuidv7). */
export async function captureEvents(
  type: string,
  fn: () => Promise<unknown>,
  options: WithActorOptions = {},
): Promise<EventRecord[]> {
  const before = await withSystem(async (tx) => (await tx.query<{ id: string }>(LATEST_EVENT, [type])).rows[0]?.id, options);
  await fn();
  return withSystem(async (tx) => {
    const res = await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload
       FROM app.events WHERE type = $1 AND ($2::uuid IS NULL OR id > $2::uuid) ORDER BY id`,
      [type, before ?? null],
    );
    return res.rows.map(toEventRecord);
  }, options);
}

export type { Actor };

import { EventRecord, parseEvent, type AnyEvent } from '@majlis/shared';
import { toEventRecord, type EventRow, type Tx } from '../db/index.ts';

const ENVELOPE = new Set(['type', 'schemaVersion', 'workspaceId']);

export interface EmitResult {
  record: EventRecord;
  /** Subscribers that got an outbox row. */
  subscribers: string[];
}

/**
 * Validates `event` against the registry (throws a ZodError naming the field; nothing is written), appends it to
 * `app.events` as `tx.actor`, and fans it out to every registered subscriber through app.enqueue_outbox, all in the
 * caller's transaction. NOTIFY majlis_outbox is delivered when that transaction commits.
 *
 * Stored shape: type, schema_version, workspace_id and team_id (when the event has `teamId`) are columns; the rest
 * of the event object is `payload`. `eventToRaw` rebuilds the original object.
 */
export async function emit(tx: Tx, event: unknown): Promise<EmitResult> {
  const parsed = parseEvent(event);
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) if (!ENVELOPE.has(k)) payload[k] = v;
  const teamId = 'teamId' in parsed && typeof parsed.teamId === 'string' ? parsed.teamId : null;
  // No RETURNING: the actor may not be allowed to SELECT its own event (team/admin read policy), and an INSERT
  // ... RETURNING is checked against the SELECT policy. Id and timestamp are drawn first instead.
  const stamp = await tx.query<{ id: string; ts: Date }>('SELECT uuidv7() AS id, now() AS ts');
  const { id, ts } = stamp.rows[0] as { id: string; ts: Date };
  await tx.query(
    `INSERT INTO app.events (id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ts, parsed.workspaceId, teamId, tx.actor.id, parsed.type, parsed.schemaVersion, JSON.stringify(payload)],
  );
  const row: EventRow = {
    id,
    occurred_at: ts,
    workspace_id: parsed.workspaceId,
    team_id: teamId,
    actor_id: tx.actor.id,
    type: parsed.type,
    schema_version: parsed.schemaVersion,
    payload,
  };
  const fan = await tx.query<{ subscriber: string }>('SELECT app.enqueue_outbox($1) AS subscriber', [row.id]);
  return { record: toEventRecord(row), subscribers: fan.rows.map((r) => r.subscriber) };
}

/** Rebuilds the object `emit` validated from a stored row (feed it to `parseEvent` / `upcast`). */
export function eventToRaw(row: Pick<EventRow, 'type' | 'schema_version' | 'workspace_id' | 'payload'>): unknown {
  return {
    ...(row.payload as Record<string, unknown>),
    type: row.type,
    schemaVersion: row.schema_version,
    workspaceId: row.workspace_id,
  };
}

/** Subscribes `subscriber` to an event type (or '*'); idempotent. System-only table: call inside withSystem. */
export async function subscribe(tx: Tx, subscriber: string, eventType: string): Promise<void> {
  await tx.query(
    'INSERT INTO app.event_subscriptions (subscriber, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [subscriber, eventType],
  );
}

export type { AnyEvent };

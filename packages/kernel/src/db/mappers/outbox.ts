import { OutboxDelivery } from '@manythreads/shared';

export interface OutboxRow {
  id: string;
  event_id: string;
  subscriber: string;
  available_at: Date;
  attempts: number;
  done_at: Date | null;
  created_at: Date;
}

export const toOutboxDelivery = (row: OutboxRow): OutboxDelivery =>
  OutboxDelivery.parse({
    id: row.id,
    eventId: row.event_id,
    subscriber: row.subscriber,
    availableAt: row.available_at.toISOString(),
    attempts: row.attempts,
    doneAt: row.done_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });

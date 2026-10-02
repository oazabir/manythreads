import { ReadState, ReadStateEntry } from '@manythreads/shared';

export interface ReadStateRow {
  person_id: string;
  target_type: string;
  target_id: string;
  last_read_id: string | null;
  unread_count: number;
  followed: boolean;
  updated_at: Date;
}

export const toReadState = (row: ReadStateRow): ReadState =>
  ReadState.parse({
    personId: row.person_id,
    targetType: row.target_type,
    targetId: row.target_id,
    lastReadId: row.last_read_id,
    unreadCount: row.unread_count,
    followed: row.followed,
    updatedAt: row.updated_at.toISOString(),
  });

/** The row without its bookkeeping (what the services and the API return). */
export const toReadStateEntry = (row: Omit<ReadStateRow, 'updated_at' | 'person_id'> & { person_id?: string; updated_at?: Date }): ReadStateEntry =>
  ReadStateEntry.parse({
    targetType: row.target_type,
    targetId: row.target_id,
    lastReadId: row.last_read_id,
    unreadCount: row.unread_count,
    followed: row.followed,
  });

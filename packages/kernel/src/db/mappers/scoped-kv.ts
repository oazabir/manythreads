import { ScopedKvEntry } from '@manythreads/shared';

export interface ScopedKvRow {
  plugin: string;
  scope_type: string;
  scope_id: string;
  key: string;
  value: unknown;
  created_at: Date;
  updated_at: Date;
}

export const toScopedKvEntry = (row: ScopedKvRow): ScopedKvEntry =>
  ScopedKvEntry.parse({
    plugin: row.plugin,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    key: row.key,
    value: row.value,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });

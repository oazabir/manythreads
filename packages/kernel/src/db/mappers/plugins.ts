import { PluginRecord } from '@manythreads/shared';

export interface PluginRow {
  name: string;
  version: string;
  enabled: boolean;
  manifest: unknown;
  updated_at: Date;
}

export const toPluginRecord = (row: PluginRow): PluginRecord =>
  PluginRecord.parse({
    name: row.name,
    version: row.version,
    enabled: row.enabled,
    manifest: row.manifest,
    updatedAt: row.updated_at.toISOString(),
  });

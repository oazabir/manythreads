import type { ScopedKv } from '@manythreads/sdk';
import type pg from 'pg';
import { systemActor, withActor, type Actor } from '../db/index.ts';

export interface DbKvOptions {
  /** The plugin this storage belongs to: the `plugin` column, so plugins never see each other's keys. */
  plugin: string;
  /** Defaults to the shared manythreads_app pool. */
  pool?: pg.Pool;
  /** Who performs the access (RLS applies). Default: the system actor, since a plugin has no request at hand. */
  actor?: () => Actor;
}

/** `ScopedKv` on `app.scoped_kv`, every call inside `withActor` like all other kernel DB access. */
export function createDbKv(options: DbKvOptions): ScopedKv {
  const run = <T>(fn: Parameters<typeof withActor<T>>[1]): Promise<T> =>
    withActor((options.actor ?? (() => systemActor()))(), fn, options.pool ? { pool: options.pool } : {});
  const { plugin } = options;
  return {
    async get(scope, key) {
      const res = await run((tx) =>
        tx.query<{ value: unknown }>(
          'SELECT value FROM app.scoped_kv WHERE plugin = $1 AND scope_type = $2 AND scope_id = $3 AND key = $4',
          [plugin, scope.type, scope.id, key],
        ),
      );
      return res.rows[0]?.value;
    },
    async set(scope, key, value) {
      if (value === undefined) throw new TypeError('ScopedKv.set: value must not be undefined (use delete)');
      await run((tx) =>
        tx.query(
          `INSERT INTO app.scoped_kv (plugin, scope_type, scope_id, key, value) VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (plugin, scope_type, scope_id, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [plugin, scope.type, scope.id, key, JSON.stringify(value)],
        ),
      );
    },
    async delete(scope, key) {
      const res = await run((tx) =>
        tx.query(
          'DELETE FROM app.scoped_kv WHERE plugin = $1 AND scope_type = $2 AND scope_id = $3 AND key = $4',
          [plugin, scope.type, scope.id, key],
        ),
      );
      return (res.rowCount ?? 0) > 0;
    },
  };
}

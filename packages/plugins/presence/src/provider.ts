import type { PresenceProvider } from '@manythreads/sdk';

/**
 * The `presence` provider (P14-09): when each person's latest heartbeat arrived. The heartbeat table is `app.presence` (channels migration 0003; this
 * plugin owns its routes), so the notifications plugin asks here instead of reading it. `app.presence_epoch` (migration 0002) says when that table was last empty. Row-level security applies to the asking transaction.
 */
export function createPresenceProvider(): PresenceProvider {
  return {
    id: 'presence',
    async lastSeen(tx, personIds) {
      const seen = new Map<string, Date>();
      if (personIds.length === 0) return seen;
      const res = await tx.query<{ person_id: string; seen_at: Date }>('SELECT person_id, seen_at FROM app.presence WHERE person_id = ANY ($1::uuid[])', [[...personIds]]);
      for (const r of res.rows) seen.set(r.person_id, r.seen_at);
      return seen;
    },
    async seenSince(tx, since, workspaceId) {
      const res = await tx.query<{ person_id: string; seen_at: Date }>(
        'SELECT person_id, seen_at FROM app.presence WHERE workspace_id = $1::uuid AND seen_at > $2::timestamptz',
        [workspaceId, since],
      );
      return new Map(res.rows.map((r) => [r.person_id, r.seen_at]));
    },
    async warmSince(tx) {
      // The marker is UNLOGGED like the heartbeat table, so it is lost in the same crash: finding it missing is how a restart of the data is noticed.
      const res = await tx.query<{ started_at: Date }>(
        `WITH made AS (INSERT INTO app.presence_epoch (id) VALUES (true) ON CONFLICT (id) DO NOTHING RETURNING started_at)
         SELECT started_at FROM made UNION ALL SELECT started_at FROM app.presence_epoch LIMIT 1`,
      );
      return res.rows[0]!.started_at;
    },
  };
}

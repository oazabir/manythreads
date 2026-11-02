import type { PresenceProvider } from '@manythreads/sdk';

/**
 * The `presence` provider (P14-09): when each person's latest heartbeat arrived. The heartbeat table is `app.presence` (channels migration 0003; this
 * plugin owns its routes), so the notifications plugin asks here instead of reading it. Row-level security applies to the asking transaction.
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
  };
}

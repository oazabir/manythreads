import { createAppPool, eventToRaw, withActor, type EventRow } from '@manythreads/kernel';
import { personaActor } from '@manythreads/test-utils';
import { PresenceDndChangedEvent, eventRegistry, parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type Persona, type World } from '../world.ts';

const { omar, nadia, rafi } = personas;

// Event contract (pnpm test:events): `presence.dnd.changed` is stored in the shape its registered schema accepts, as the person who changed
// their settings, without a team (so only workspace admins read it) and without the settings themselves; a status change emits nothing.

let w: World;
beforeAll(async () => {
  w = await createWorld();
  const put = (who: Persona, body: unknown): Promise<unknown> => w.call(who, 'PUT', '/api/presence/dnd', body);
  await put(nadia, { enabled: true });
  await put(nadia, { enabled: false });
  await put(rafi, { pauseMinutes: 30, schedule: { enabled: true, windows: [{ days: [1], start: '22:00', end: '07:00' }] } });
  await w.call(rafi, 'PATCH', '/api/presence/me', { status: { emoji: '🎧', text: 'Focus', clearsAt: null } });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const changed = (): Promise<EventRow[]> =>
  w.system(async (tx) =>
    (await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = 'presence.dnd.changed' ORDER BY id`,
    )).rows,
  );

describe('presence events', () => {
  it('registers the event at schema version 1, and the manifest lists it', async () => {
    expect(Object.keys(eventRegistry['presence.dnd.changed'])).toEqual(['1']);
    const plugin = (await import('../../src/index.ts')).default;
    expect([...plugin.manifest.events.emits]).toEqual(['presence.dnd.changed']);
  });

  it('one event per settings change, each parsing against its schema, as the person, with no team and none of the settings', async () => {
    const rows = await changed();
    expect(rows).toHaveLength(3);                       // the status change wrote none
    const parsed = rows.map((row) => PresenceDndChangedEvent.parse(parseEvent(eventToRaw(row))));
    expect(parsed.map((e) => [e.personId, e.active])).toEqual([[nadia.personId, true], [nadia.personId, false], [rafi.personId, true]]);
    expect(parsed[0]!.until).toBeNull();                // by hand: no end
    expect(parsed[2]!.until).not.toBeNull();            // paused for 30 minutes
    for (const [i, row] of rows.entries()) {
      expect(row.team_id).toBeNull();
      expect(row.actor_id).toBe((i < 2 ? nadia : rafi).actorId);
      expect(JSON.stringify(row.payload)).not.toMatch(/windows|22:00|schedule|Focus/);
    }
  });

  it('is readable from the event log by workspace admins and the system only', async () => {
    const pool = createAppPool(w.server.db.appUrl, 2);
    try {
      const countAs = (p: Persona): Promise<number> =>
        withActor(personaActor(p), async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'presence.dnd.changed'")).rows[0]!.n, { pool });
      expect(await countAs(omar)).toBe(3);
      expect(await countAs(rafi)).toBe(0);
      expect(await countAs(nadia)).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

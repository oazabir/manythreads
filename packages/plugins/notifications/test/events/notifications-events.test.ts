import { createAppPool, eventToRaw, withActor, type EventRow } from '@manythreads/kernel';
import { personaActor } from '@manythreads/test-utils';
import { NotificationsNotificationCreatedEvent, eventRegistry, parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, drained, ensureChannels, eventually, personas, type Persona, type World } from '../world.ts';

const { omar, nadia, rafi, priya } = personas;

// Event contract tests (pnpm test:events): the one event the notifications plugin emits is stored in the shape its registered schema
// accepts, as the system actor, without a team (so only workspace admins read it) and without any message text; nothing is emitted
// for a message that notifies nobody, nor when the same event is handled again.

let w: World;
let before: string | null = null;
let dev = '';
const ids: Record<string, string> = {};
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  before = await w.system(async (tx) => (await tx.query<{ id: string | null }>('SELECT max(id::text)::text AS id FROM app.events')).rows[0]?.id ?? null);
  const post = async (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> => {
    const res = await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.id;
  };
  ids['mention'] = await post(nadia, dev, 'secret launch date, see @rafi');
  ids['plain'] = await post(nadia, dev, 'nobody is named here');
  await w.call(rafi, 'POST', `/api/threads/${ids['plain']}/follow`);
  ids['reply'] = await post(priya, dev, 'a reply for the followers', ids['plain']);
  const dm = (await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] })).body.dm.channel.id;
  ids['dm'] = await post(nadia, dm, 'a direct message');
  await drained(w);
  await eventually(async () => ((await created()).length >= 4 ? true : undefined));
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const created = (): Promise<EventRow[]> =>
  w.system(async (tx) =>
    (await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
        WHERE ($1::uuid IS NULL OR id > $1::uuid) AND type = 'notifications.notification.created' ORDER BY id`,
      [before],
    )).rows,
  );

describe('notifications events', () => {
  it('registers the event at schema version 1 and the manifest lists it (and what the plugin consumes)', async () => {
    expect(Object.keys(eventRegistry['notifications.notification.created'])).toEqual(['1']);
    const plugin = (await import('../../src/index.ts')).default;
    expect([...plugin.manifest.events.emits]).toEqual(['notifications.notification.created']);
    for (const type of plugin.manifest.events.consumes) expect(Object.keys(eventRegistry)).toContain(type);
  });

  it('one event per notification written, each parsing against its schema, as the system actor, with no team and no text', async () => {
    const rows = await created();
    expect(rows).toHaveLength(4);   // mention for Rafi, reply for Rafi and Nadia (she follows from the first reply), dm for Rafi
    const parsed = rows.map((row) => NotificationsNotificationCreatedEvent.parse(parseEvent(eventToRaw(row))));
    expect(parsed.map((e) => `${e.kind}:${e.refId}`).sort()).toEqual(
      [`mention:${ids['mention']}`, `reply:${ids['reply']}`, `reply:${ids['reply']}`, `dm:${ids['dm']}`].sort(),
    );
    for (const row of rows) {
      expect(row.team_id).toBeNull();
      expect(row.workspace_id).toBe(omar.workspaceId);
      expect(JSON.stringify(row.payload)).not.toMatch(/secret launch|direct message|followers/);
    }
    const people = parsed.map((e) => e.personId).sort();
    expect(people).toEqual([nadia.personId, rafi.personId, rafi.personId, rafi.personId].sort());
    expect(parsed.every((e) => e.channelId.length > 0 && e.actorId.length > 0)).toBe(true);
  });

  it('is readable from the event log by workspace admins and the system only', async () => {
    const pool = createAppPool(w.server.db.appUrl, 2);
    try {
      const countAs = (p: Persona): Promise<number> =>
        withActor(personaActor(p), async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'notifications.notification.created'")).rows[0]!.n, { pool });
      expect(await countAs(omar)).toBeGreaterThanOrEqual(4);
      expect(await countAs(rafi)).toBe(0);
      expect(await countAs(nadia)).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('a message that notifies nobody emits nothing', async () => {
    const rows = await created();
    expect(rows.some((r) => (r.payload as { refId?: string }).refId === ids['plain'])).toBe(false);
  });
});

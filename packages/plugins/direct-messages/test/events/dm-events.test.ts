import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { eventRegistry, parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type World } from '../../../channels/test/world.ts';

const { nadia, rafi, priya, lena } = personas;

// Event contract (pnpm test:events): opening a DM for the first time writes channel.channel.created as the opener with no team; opening
// it again, or a refused request, writes nothing.

let w: World;
let before: string | null = null;
let dm = '';
beforeAll(async () => {
  w = await createWorld();
  before = await w.system(async (tx) => (await tx.query<{ id: string | null }>('SELECT max(id::text)::text AS id FROM app.events')).rows[0]?.id ?? null);
  const open = (who: typeof nadia, ...others: Array<typeof nadia>) => w.call<{ dm: { channel: { id: string } }; created: boolean }>(who, 'POST', '/api/dms', { personIds: others.map((o) => o.personId) });
  dm = (await open(nadia, rafi)).body.dm.channel.id;
  await open(nadia, rafi);
  await open(rafi, nadia);
  expect((await open(lena, nadia)).status).toBe(403);
  await open(nadia, rafi, priya);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const stored = (): Promise<EventRow[]> =>
  w.system(async (tx) =>
    (await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
        WHERE ($1::uuid IS NULL OR id > $1::uuid) AND type = 'channel.channel.created' ORDER BY id`,
      [before],
    )).rows,
  );

describe('direct message events', () => {
  it('the plugin declares channel.channel.created at schema version 1', async () => {
    expect(Object.keys(eventRegistry['channel.channel.created'])).toEqual(['1']);
    const plugin = (await import('../../src/index.ts')).default;
    expect([...plugin.manifest.events.emits]).toEqual(['channel.channel.created']);
  });

  it('is written once per conversation, as the opener, with no team, and parses against its schema', async () => {
    const rows = await stored();
    expect(rows).toHaveLength(2);                                   // the pair once, the group once; repeats and the refused guest wrote nothing
    for (const row of rows) {
      expect(parseEvent(eventToRaw(row)).type).toBe('channel.channel.created');
      expect(row.team_id).toBeNull();
      expect(row.actor_id).toBe(nadia.actorId);
      expect(row.workspace_id).toBe(nadia.workspaceId);
    }
    expect(rows[0]?.payload).toMatchObject({ channelId: dm, name: '', kind: 'dm', private: true, teamId: null });
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toContain(rafi.personId);   // ids of the conversation, not of who is in it
  });
});

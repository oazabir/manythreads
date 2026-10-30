import { createAppPool, enqueue, eventToRaw, withActor, type EventRow } from '@manythreads/kernel';
import { personaActor } from '@manythreads/test-utils';
import { RemindersReminderDueEvent, eventRegistry, parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type Persona, type World } from '../world.ts';

const { omar, nadia, rafi } = personas;

// Event contract (pnpm test:events): `reminders.reminder.due` is stored in the shape its registered schema accepts, once per due item, written by the
// system without a team (so only workspace admins read it) and without any text of the message.

let skewMs = 0;
let w: World;
let messageId = '';
let channelId = '';
beforeAll(async () => {
  w = await createWorld({ now: () => new Date(Date.now() + skewMs) });
  await ensureChannels(w);
  channelId = await w.channelId('engineering', 'dev');
  const posted = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'EVENT-CANARY words', threadRootId: null });
  messageId = posted.body.id;
  await w.call(rafi, 'PUT', `/api/later/messages/${messageId}`, { remindAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  skewMs = 11 * 60_000;
  for (let run = 0; run < 2; run++) {
    const id = await w.system(async (tx) => (await enqueue(tx, 'reminders.fire_due', {})).id);
    await eventually(async () => ((await w.system(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [id])).rows[0]?.state)) === 'done' ? true : undefined), 20_000, 'the reminders job');
  }
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const due = (): Promise<EventRow[]> =>
  w.system(async (tx) =>
    (await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = 'reminders.reminder.due' ORDER BY id`,
    )).rows,
  );

describe('reminders events', () => {
  it('registers the event at schema version 1, and the manifest lists it', async () => {
    expect(Object.keys(eventRegistry['reminders.reminder.due'])).toEqual(['1']);
    const plugin = (await import('../../src/index.ts')).default;
    expect([...plugin.manifest.events.emits]).toEqual(['reminders.reminder.due']);
  });

  it('one event for the item although the job ran twice, parsing against its schema, with no team and no text', async () => {
    const rows = await due();
    expect(rows).toHaveLength(1);
    const event = RemindersReminderDueEvent.parse(parseEvent(eventToRaw(rows[0]!)));
    expect(event).toMatchObject({ personId: rafi.personId, messageId, channelId });
    expect(rows[0]!.team_id).toBeNull();
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/CANARY|words/);
  });

  it('is readable from the event log by workspace admins and the system only', async () => {
    const pool = createAppPool(w.server.db.appUrl, 2);
    try {
      const countAs = (p: Persona): Promise<number> =>
        withActor(personaActor(p), async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'reminders.reminder.due'")).rows[0]!.n, { pool });
      expect(await countAs(omar)).toBe(1);
      expect(await countAs(rafi)).toBe(0);
      expect(await countAs(nadia)).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
